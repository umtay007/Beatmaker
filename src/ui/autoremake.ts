/**
 * Remake a song automatically: everything a person (or Claude) would do by hand, in order.
 *
 * 1. Tempo, first beat, key and tuning; a fresh song on that grid.
 * 2. Optionally split the original into drums, bass, other and vocals (HTDemucs in the browser).
 * 3. Transcribe each part from its own stem (drums from the beat detector, notes from Basic Pitch).
 * 4. Tidy each part by its repeats, and mark the sections.
 * 5. Find the closest instrument or kit for each part, at the original's level.
 * 6. Fit each track's EQ and level to its stem, then match the master to the original.
 */
import { detectAudioKey } from '../audio/key';
import { busiestStretch, busyStretches, finderCandidates, findInstrument } from '../audio/finder';
import { transcribePitches, drumGrid } from '../audio/transcribe';
import { drumNotes, splitParts } from '../audio/parts';
import { transcribeBass } from '../audio/bassline';
import { detectTempo } from '../audio/tempo';
import { detectSections } from '../audio/structure';
import { renderSong } from '../audio/render';
import { compareRemake, describeComparison, partScore } from '../audio/compare';
import { applyVstSounds } from './vstparts';
import { fitTone, ltas } from '../audio/tonefit';
import { instrumentFor } from '../audio/instruments';
import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import { tidyRepeats } from '../core/tidy';
import { makeLoop } from '../core/loops';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, MAX_BARS, newNoteId, newTrackId, STEP, type Note, type Song, type Track } from '../core/types';
import type { Actions } from './actions';
import { vocalTrack } from './vocaltrack';
import { transcribeLyrics } from '../audio/lyricsasr';
import { barTimes, toSongLines } from '../core/lyrics';

export type StemName = 'drums' | 'bass' | 'other' | 'vocals';
export type Separator = (buf: AudioBuffer, onProgress: (fraction: number, message: string) => void, signal: AbortSignal) => Promise<Record<StemName, AudioBuffer>>;

export interface RemakeOptions {
  /** Split the original into parts first (much better transcriptions; a big one-time download). */
  separate: boolean;
  /** Try every instrument instead of a shortlist per part. */
  thorough: boolean;
  /** Put the original's vocals on a track of their own. */
  keepVocals: boolean;
  /** Tidy each part by its repeats. */
  tidy: boolean;
  /** Write out the lyrics from the vocals, timed (needs the parts separated). */
  lyrics?: boolean;
}

export interface RemakeContext {
  store: Store;
  engine: AudioEngine;
  actions: Actions;
  separator?: Separator;
}

/** The instruments tried per part unless every one is. */
const SHORTLIST: Record<'chords' | 'melody', string[]> = {
  chords: ['gstrings', 'gtremolo', 'goohs', 'gchoir', 'spiano', 'gepiano', 'sharp', 'selectric', 'sguitar', 'snylon', 'sorgan', 'sharmonium', 'shorn', 'gbrass', 'gpizz', 'gmarimba', 'gvibes', 'gmusicbox', 'gcelesta', 'sviolin', 'scello', 'sflute'],
  melody: ['spiano', 'gepiano', 'gmarimba', 'gvibes', 'gcelesta', 'gmusicbox', 'gglock', 'gbells', 'sxylo', 'sharp', 'selectric', 'snylon', 'sguitar', 'sflute', 'gpanflute', 'gocarina', 'gwhistle', 'sclarinet', 'goboe', 'strumpet', 'ssax', 'sviolin', 'gstrings', 'gchoir', 'goohs', 'gpizz'],
};

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

const pause = () => new Promise((r) => setTimeout(r, 20));

export async function autoRemake(
  c: RemakeContext,
  opts: RemakeOptions,
  step: (label: string, fraction: number) => void,
  signal: AbortSignal,
): Promise<string[]> {
  const { store, engine, actions } = c;
  const buf = engine.backingBuffer;
  if (!buf) throw new Error('Load the original song first');
  const report: string[] = [];
  const stemsWanted = opts.separate && !!c.separator;
  const weights = { grid: 3, separate: opts.separate && c.separator ? 40 : 0, notes: 25, tidy: 2, lyrics: opts.lyrics && opts.separate && c.separator ? 8 : 0, find: 20, settle: stemsWanted ? 6 : 0, tone: 5, mix: 5 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let done = 0;
  const phase = (key: keyof typeof weights, label: string) => {
    const base = done;
    done += weights[key];
    return (f: number, msg = label) => step(msg, (base + weights[key] * Math.max(0, Math.min(1, f))) / total);
  };

  // 1. The grid
  const grid = phase('grid', 'Finding the tempo, first beat and key…');
  grid(0);
  await pause();
  const tempo = detectTempo(buf);
  const key = detectAudioKey(buf);
  const colors = actions.palette();
  const name = engine.backingName.replace(/\.[a-z0-9]+$/i, '') || 'Song';
  const song: Song = {
    name: `${name} (remake)`,
    artist: '',
    bpm: tempo.bpm,
    tempoChanges: [],
    swing: 0,
    bars: 4,
    key: key.key,
    scale: key.scale,
    tuning: Math.abs(key.tuning) >= 6 ? Math.round(key.tuning) : 0,
    tracks: [],
    loop: { enabled: false, start: 0, end: 4 * BAR },
    audioOffset: -Math.round(tempo.firstBeat * 1000) / 1000,
    synthsWithAudio: true,
  };
  song.bars = Math.min(MAX_BARS, Math.max(4, Math.ceil(new Timeline(song).secToTick(buf.duration + song.audioOffset) / BAR)));
  report.push(`${tempo.bpm} BPM, ${song.bars} bars${song.tuning ? `, tuned ${song.tuning > 0 ? '+' : ''}${song.tuning} cents` : ''}`);
  aborted(signal);

  // 2. Parts
  let stems: Record<StemName, AudioBuffer> | null = null;
  if (weights.separate) {
    const sep = phase('separate', 'Separating drums, bass, melody and vocals…');
    // Twice before giving up: everything after is much better with the parts apart.
    for (let attempt = 1; attempt <= 2 && !stems; attempt++) {
      try {
        stems = await c.separator!(buf, (f, msg) => sep(f, msg), signal);
        engine.stems = stems;
        report.push('Separated the original into drums, bass, melody and vocals');
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        console.warn('Separation failed', e);
        if (attempt === 2) report.push(`Warning: couldn't separate the parts (${(e as Error).message}), so it worked from the full mix: expect rougher notes and sounds`);
      }
    }
  }
  aborted(signal);

  // 3. Notes
  const notesStep = phase('notes', 'Transcribing…');
  const tl = new Timeline(song);
  const off = song.audioOffset;
  const endTick = Math.min(song.bars * BAR, Math.ceil(tl.secToTick(buf.duration + off)));
  const ticks: number[] = [];
  for (let t = 0; t < endTick; t += STEP) ticks.push(t);
  notesStep(0, 'Finding the drums…');
  await pause();
  const drumsIn = stems?.drums ?? buf;
  const drums = drumNotes(drumGrid(drumsIn, ticks.map((t) => tl.tickToSec(t) - off)), ticks);
  const kicks = new Set<number>(drums.filter((n) => n.pitch === 36).map((n) => n.start));
  aborted(signal);
  let bass: Note[] = [];
  let chords: Note[] = [];
  let melody: Note[] = [];
  const listen = (label: string, a: number, b: number) => (p: number) => notesStep(a + (b - a) * p, `${label} ${Math.round(p * 100)}%`);
  const stepTimes = ticks.map((t) => tl.tickToSec(t) - off);
  // The bass by its own tracker (note models hardly hear an 808); the model's reading if that finds little.
  notesStep(0.05, 'Following the bass…');
  await pause();
  const tracked = await transcribeBass(stems?.bass ?? buf, { stepTimes, stepTicks: ticks, tuning: song.tuning, mix: !stems });
  aborted(signal);
  if (stems) {
    if (tracked.length >= 8) bass = tracked;
    else {
      const b = await transcribePitches(stems.bass, 0, stems.bass.duration, {}, listen('Listening to the bass…', 0.1, 0.4));
      bass = splitParts(b.struck, tl, { offset: off, kicks }).bass;
    }
    aborted(signal);
    const o = await transcribePitches(stems.other, 0, stems.other.duration, {}, listen('Listening to the melody and chords…', 0.4, 1));
    const sp = splitParts(o.notes, tl, { offset: off, kicks });
    // The melodic stem's lowest line is the bottom of its chords (the bass has its own stem).
    chords = [...sp.chords, ...sp.bass].sort((x, y) => x.start - y.start || x.pitch - y.pitch);
    melody = sp.melody;
  } else {
    const r = await transcribePitches(buf, 0, buf.duration, {}, listen('Listening for notes…', 0.1, 1));
    const sp = splitParts(r.notes, tl, { offset: off, kicks });
    // A sub-bass line the tracker follows is an 808 the model would mostly miss.
    const modelBass = splitParts(r.struck, tl, { offset: off, kicks }).bass;
    bass = tracked.length >= 8 && median(tracked.map((n) => n.pitch)) < 45 ? tracked : modelBass;
    chords = sp.chords;
    // In the full mix, a "melody" in the voice's range is mostly the vocals transcribed: keep the
    // lines above them (beat melodies usually sit up there).
    melody = sp.melody.filter((n) => n.pitch >= 72);
  }
  aborted(signal);

  // 4. Tidy and sections
  const tidyStep = phase('tidy', 'Tidying repeats and finding sections…');
  tidyStep(0);
  await pause();
  const parts: { name: string; kind: Track['kind']; instrument: string; notes: Note[]; role: 'drums' | 'bass' | 'chords' | 'melody' }[] = [
    { name: 'Drums', kind: 'drums', instrument: 'trap', notes: drums, role: 'drums' },
    { name: 'Bass', kind: 'synth', instrument: median(bass.map((n) => n.pitch)) < 43 ? 'bass808' : 'sebass', notes: bass, role: 'bass' },
    { name: 'Chords', kind: 'synth', instrument: 'gstrings', notes: chords, role: 'chords' },
    { name: 'Melody', kind: 'synth', instrument: 'spiano', notes: melody, role: 'melody' },
  ];
  const loopsOf = new Map<string, { period: number; groups: number[][] }>();
  for (const p of parts) {
    const inRange = p.notes.filter((n) => n.start < endTick);
    if (opts.tidy && inRange.length >= 8) {
      const r = tidyRepeats(inRange, { bars: song.bars });
      p.notes = r.notes;
      if (r.tidied) {
        report.push(`${p.name}: repeats tidied (a ${r.period}-bar loop, ${r.tidied} passes), and linked so editing one pass edits them all`);
        loopsOf.set(p.name, { period: r.period, groups: r.groups });
      }
    } else p.notes = inRange;
  }
  song.tracks = parts
    .filter((p) => p.notes.length)
    .map((p, i) => ({
      id: newTrackId(),
      name: p.name,
      kind: p.kind,
      instrument: p.instrument,
      color: colors[i % colors.length],
      volume: 0.8,
      pan: 0,
      reverb: p.role === 'drums' ? 0.05 : p.role === 'bass' ? 0 : 0.25,
      mute: false,
      solo: false,
      visible: true,
      notes: p.notes.map((n) => ({ ...n, id: newNoteId() })),
    }));
  const roleOf = new Map(song.tracks.map((t) => [t.id, parts.find((p) => p.name === t.name)!.role]));
  // The tidied repeats become linked loops, one per group of alike passes.
  for (const t of song.tracks) {
    const l = loopsOf.get(t.name);
    if (!l) continue;
    l.groups.forEach((starts, gi) => {
      const ok = starts.filter((s, i) => s + l.period * BAR <= song.bars * BAR && (i === 0 || s >= starts[i - 1] + l.period * BAR));
      if (ok.length < 2) return;
      const loop = makeLoop(song, ok[0], ok[0] + l.period * BAR, [t.id], `${t.name} ${String.fromCharCode(65 + gi)}`);
      loop.starts = ok;
    });
  }
  song.sections = detectSections({ song, mix: buf, offset: off, vocals: stems?.vocals, drums: stems?.drums });
  report.push(`Sections: ${song.sections.map((s) => s.name).join(', ')}`);
  if (opts.keepVocals && stems?.vocals) {
    const t = await vocalTrack(stems.vocals, song, colors[song.tracks.length % colors.length], { name: 'Vocals (original)', withOriginal: true });
    song.tracks.push(t);
    report.push('The original vocals are on their own track');
  }
  if (weights.lyrics && stems?.vocals) {
    const lyr = phase('lyrics', 'Writing out the lyrics…');
    try {
      const { lines } = await transcribeLyrics(stems.vocals, { signal, bars: barTimes(song), onProgress: (msg, f) => lyr(f, msg) });
      const timed = toSongLines(song, lines);
      if (timed.length) song.lyrics = timed;
      report.push(timed.length ? `Lyrics: ${timed.length} lines written out from the vocals, timed (check the words in Visual → Lyrics)` : 'Lyrics: no singing found in the vocals');
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      report.push(`Lyrics: couldn't write them out (${(e as Error).message})`);
    }
  }
  store.loadSong(song);
  // The video's title follows the new song, as it does for any song opened.
  store.setVisual({ titleText: song.name, subtitleText: song.artist || store.visual.subtitleText });
  engine.applySynthMute();
  aborted(signal);

  // 5. Instruments
  const find = phase('find', 'Finding instruments…');
  const pitched = store.song.tracks.filter((t) => roleOf.has(t.id));
  /** Each track's best few sounds (with the volume each needs), for settling the close calls together. */
  const shortlist = new Map<string, { id: string; gain: number; base: number }[]>();
  for (const [i, t] of pitched.entries()) {
    aborted(signal);
    const role = roleOf.get(t.id)!;
    const stem = stems ? (role === 'drums' ? stems.drums : role === 'bass' ? stems.bass : stems.other) : undefined;
    const span = busiestStretch(store.song, t);
    const all = finderCandidates(t, false);
    const cands =
      role === 'drums' ? all.map((x) => x.id)
      : role === 'bass' ? bassCandidates(t, all.filter((x) => x.group === 'Bass').map((x) => x.id))
      : opts.thorough ? all.filter((x) => x.group !== 'Bass').map((x) => x.id)
      : SHORTLIST[role];
    try {
      const label = (what: string) => (d: number, n: number, l: string) => find((i + d / Math.max(1, n)) / pitched.length, `${what} the ${t.name.toLowerCase()} sound: ${l || 'done'}`);
      const ask = (sp: { from: number; to: number }, candidates: string[], what: string) =>
        findInstrument({ song: store.song, trackId: t.id, from: sp.from, to: sp.to, reference: stem ?? buf, offset: off, candidates, signal, onProgress: label(what) });
      let res = await ask(span, cands, 'Finding');
      // Close calls are settled over more of the song: the busiest stretch alone can mislead.
      let checked = 1;
      const near = res.filter((r) => r.score <= res[0].score * 1.12).slice(0, 3);
      if (near.length > 1) {
        const total = new Map(near.map((r) => [r.id, r.score]));
        for (const sp of busyStretches(store.song, t, 8, 3).slice(1)) {
          const again = await ask(sp, near.map((r) => r.id), 'Double-checking');
          for (const r of near) {
            const hit = again.find((x) => x.id === r.id);
            total.set(r.id, hit ? total.get(r.id)! + hit.score : Infinity);
          }
          checked++;
        }
        if (checked > 1) {
          const ranked = [...near].sort((a, b) => total.get(a.id)! - total.get(b.id)!).map((r) => ({ ...r, score: total.get(r.id)! / checked }));
          res = [...ranked, ...res.filter((r) => !near.includes(r))];
        }
      }
      const best = res[0];
      if (best) {
        const gainOf = (levelDb: number) => Math.pow(10, Math.max(-18, Math.min(18, levelDb)) / 20);
        shortlist.set(t.id, res.slice(0, 5).map((r) => ({ id: r.id, gain: gainOf(r.levelDb), base: t.volume })));
        const gain = Math.pow(10, Math.max(-18, Math.min(18, best.levelDb)) / 20);
        store.update(() => {
          t.instrument = best.id;
          t.volume = Math.round(Math.max(0.02, Math.min(1.5, t.volume * gain)) * 1000) / 1000;
        });
        // A near tie: the numbers can't tell them apart, so say so (Find on the track lets you listen).
        const close = res[1] && res[1].score - best.score < 0.06 * best.score;
        const over = checked > 1 ? `, compared over ${checked} parts of the song` : '';
        report.push(`${t.name}: ${best.label}${res[1] ? (close ? ` (a close call with ${res[1].label}${over}: try both with Find on the track)` : ` (next closest: ${res[1].label}${over})`) : ''}`);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      report.push(`${t.name}: kept ${instrumentFor(t.instrument).label} (${(e as Error).message})`);
    }
  }

  // Chords and melody share one stem, so a sound is judged best by how the two sound together:
  // try each one's best few against the stem, over the stretches where the melody plays most.
  const settle = phase('settle', 'Settling the melody and chords together…');
  const lead = store.song.tracks.find((t) => roleOf.get(t.id) === 'melody');
  const pads = store.song.tracks.find((t) => roleOf.get(t.id) === 'chords');
  if (stems && lead && pads && shortlist.has(lead.id) && shortlist.has(pads.id)) {
    try {
      const spans = busyStretches(store.song, lead, 8, 3);
      const together = (): Promise<number> => {
        const solo = cloneSong(store.song);
        solo.tracks = solo.tracks.filter((x) => x.id === lead.id || x.id === pads.id);
        for (const x of solo.tracks) x.mute = x.solo = false;
        return partScore(solo, stems.other, off, 'other', spans);
      };
      const volumeOf = (o: { gain: number; base: number }) => Math.round(Math.max(0.02, Math.min(1.5, o.base * o.gain)) * 1000) / 1000;
      const before = { lead: lead.instrument, pads: pads.instrument };
      const first = await together();
      let bestScore = first;
      for (const [k, t] of [lead, pads].entries()) {
        const options = shortlist.get(t.id)!;
        let pick = options.find((o) => o.id === t.instrument) ?? options[0];
        for (const [oi, o] of options.entries()) {
          aborted(signal);
          settle((k + oi / options.length) / 2);
          if (o.id === pick.id) continue;
          store.update(() => {
            t.instrument = o.id;
            t.volume = volumeOf(o);
          });
          const s = await together();
          if (s > bestScore + 1) {
            bestScore = s;
            pick = o;
          }
        }
        store.update(() => {
          t.instrument = pick.id;
          t.volume = volumeOf(pick);
        });
      }
      if (lead.instrument !== before.lead || pads.instrument !== before.pads) {
        report.push(`Chords and melody together: ${instrumentFor(pads.instrument).label} and ${instrumentFor(lead.instrument).label} (was ${instrumentFor(before.pads).label} and ${instrumentFor(before.lead).label}; matches the original ${Math.round(first)} → ${Math.round(bestScore)} of 100 over the busiest bars)`);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      report.push(`Chords and melody: kept the sounds found one by one (${(e as Error).message})`);
    }
  }

  // 6. Tone and mix
  const tone = phase('tone', 'Fitting each part’s tone…');
  if (stems) {
    for (const [i, t] of pitched.entries()) {
      aborted(signal);
      const role = roleOf.get(t.id)!;
      if (role === 'melody') continue; // it shares its stem with the chords, which dominate it
      tone(i / pitched.length, `Fitting the tone of the ${t.name.toLowerCase()}…`);
      const stem = role === 'drums' ? stems.drums : role === 'bass' ? stems.bass : stems.other;
      const span = busiestStretch(store.song, t, 16);
      const solo = cloneSong(store.song);
      solo.tracks = solo.tracks.filter((x) => x.id === t.id);
      const pre = 4;
      const from = Math.max(0, span.from - pre);
      const r = await renderSong(solo, { from, to: span.to, tail: 0, dynamics: false });
      const fit = fitTone(ltas(stem, span.from - off, span.to - off), ltas(r, span.from - from, span.to - from), role === 'bass' ? 30 : 60, role === 'bass' ? 2000 : 12000);
      store.update(() => {
        t.eqLow = fit.eqLow;
        t.eqMid = fit.eqMid;
        t.eqMidFreq = fit.eqMidFreq;
        t.eqHigh = fit.eqHigh;
        t.volume = Math.round(Math.max(0.02, Math.min(1.5, t.volume * Math.pow(10, Math.max(-9, Math.min(9, fit.volumeDb)) / 20))) * 1000) / 1000;
      });
    }
  }
  aborted(signal);
  // Your own VST sounds, where you've picked them (the desktop app): they replace the built-in melody and drums.
  if (stems) {
    step('Playing the melody and drums through your VST sounds…', 0.9);
    try {
      report.push(...(await applyVstSounds({ store, roleOf, stems, offset: off, colors })));
    } catch (e) {
      console.warn('VST sounds failed', e);
      report.push(`VST sounds: not used (${(e as Error).message})`);
    }
  }
  const mix = phase('mix', 'Matching the mix…');
  mix(0);
  const sound = actions.analyzeReference();
  if (sound) {
    // The remake has no vocals, so match it to the original without them: the separated parts
    // summed back, over the first hook; or, from the full mix, a stretch without vocals.
    const secs = store.song.sections ?? [];
    const pick = stems ? secs.find((s) => s.name === 'Hook') : (secs.find((s) => s.name === 'Outro') ?? secs.find((s, i) => s.name === 'Break' && i > 0) ?? secs.find((s) => s.name === 'Hook'));
    const saved = { ...store.song.loop };
    store.update((s) => {
      const start = pick ? pick.tick : 8 * BAR;
      const next = secs.find((x) => x.tick > start)?.tick ?? s.bars * BAR;
      const end = Math.min(s.bars * BAR, start + 8 * BAR, Math.max(start + 4 * BAR, next));
      s.loop = { enabled: true, start: Math.min(start, (s.bars - 4) * BAR), end };
    });
    const original = engine.backingBuffer;
    if (stems) engine.backingBuffer = mixStems([stems.drums, stems.bass, stems.other]);
    let changes: string[];
    try {
      changes = await actions.matchMix(sound, (msg) => mix(0.5, msg));
    } finally {
      engine.backingBuffer = original;
      store.update((s) => (s.loop = saved));
    }
    if (sound.echo) {
      const lead = store.song.tracks.find((t) => roleOf.get(t.id) === 'melody');
      if (lead) store.update(() => (lead.echo = 0.2));
    }
    if (changes.length) report.push(`Master: ${changes.join(' · ')}`);
  }
  // 7. How close is it? Each part against the original's matching stem.
  if (stems) {
    step('Comparing the remake with the original…', 0.99);
    try {
      const secs = store.song.sections ?? [];
      const sectionAt = (bar: number) => [...secs].reverse().find((s) => s.tick <= (bar - 1) * BAR)?.name ?? 'Intro';
      const roles = new Map([...roleOf].map(([id, r]) => [id, r]));
      const cmp = await compareRemake(store.song, { drums: stems.drums, bass: stems.bass, other: stems.other }, off, roles);
      report.push(...describeComparison(cmp, sectionAt));
    } catch (e) {
      console.warn('Comparison failed', e);
      report.push(`Couldn't compare with the original (${(e as Error).message})`);
    }
  }
  step('Done', 1);
  return report;
}

/**
 * A bass line that lives down in the sub range with held notes is an 808 (or a sub) in nearly every
 * beat that has one; choosing among those alone keeps a plucked bass from winning on a noisy match.
 */
function bassCandidates(t: Track, all: string[]): string[] {
  const pitches = t.notes.map((n) => n.pitch);
  const durs = t.notes.map((n) => n.dur);
  const sub = median(pitches) < 45 && median(durs) >= 96;
  return sub ? all.filter((id) => /^bass808|^sub$|^deepbass$/.test(id)) : all;
}

/** Sum some stems back together (the original without its vocals, say). */
function mixStems(parts: AudioBuffer[]): AudioBuffer {
  const len = Math.max(...parts.map((p) => p.length));
  const ch = Math.max(...parts.map((p) => p.numberOfChannels));
  const out = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: parts[0].sampleRate });
  for (let c = 0; c < ch; c++) {
    const d = out.getChannelData(c);
    for (const p of parts) {
      const s = p.getChannelData(Math.min(c, p.numberOfChannels - 1));
      for (let i = 0; i < s.length; i++) d[i] += s[i];
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 40;
}
