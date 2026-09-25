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
import { busiestStretch, finderCandidates, findInstrument } from '../audio/finder';
import { transcribePitches, drumGrid } from '../audio/transcribe';
import { drumNotes, splitParts } from '../audio/parts';
import { detectTempo } from '../audio/tempo';
import { detectSections } from '../audio/structure';
import { renderSong, encodeWav } from '../audio/render';
import { fitTone, ltas } from '../audio/tonefit';
import { instrumentFor } from '../audio/instruments';
import type { AudioEngine } from '../audio/engine';
import { putFile } from '../core/library';
import type { Store } from '../core/store';
import { tidyRepeats } from '../core/tidy';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, DEFAULT_SAMPLER, MAX_BARS, newNoteId, newTrackId, STEP, type Note, type Song, type Track } from '../core/types';
import type { Actions } from './actions';

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
  const weights = { grid: 3, separate: opts.separate && c.separator ? 40 : 0, notes: 25, tidy: 2, find: 20, tone: 5, mix: 5 };
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
    try {
      stems = await c.separator!(buf, (f, msg) => sep(f, msg), signal);
      engine.stems = stems;
      report.push('Separated the original into drums, bass, melody and vocals');
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      report.push(`Couldn't separate the parts (${(e as Error).message}); worked from the full mix`);
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
  if (stems) {
    const b = await transcribePitches(stems.bass, 0, stems.bass.duration, {}, listen('Listening to the bass…', 0.1, 0.4));
    aborted(signal);
    bass = splitParts(b.struck, tl, { offset: off, kicks }).bass;
    const o = await transcribePitches(stems.other, 0, stems.other.duration, {}, listen('Listening to the melody and chords…', 0.4, 1));
    const sp = splitParts(o.notes, tl, { offset: off, kicks });
    // The melodic stem's lowest line is the bottom of its chords (the bass has its own stem).
    chords = [...sp.chords, ...sp.bass].sort((x, y) => x.start - y.start || x.pitch - y.pitch);
    melody = sp.melody;
  } else {
    const r = await transcribePitches(buf, 0, buf.duration, {}, listen('Listening for notes…', 0.1, 1));
    const sp = splitParts(r.notes, tl, { offset: off, kicks });
    bass = splitParts(r.struck, tl, { offset: off, kicks }).bass;
    chords = sp.chords;
    melody = sp.melody;
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
  for (const p of parts) {
    const inRange = p.notes.filter((n) => n.start < endTick);
    if (opts.tidy && inRange.length >= 8) {
      const r = tidyRepeats(inRange, { bars: song.bars });
      p.notes = r.notes;
      if (r.tidied) report.push(`${p.name}: repeats tidied (a ${r.period}-bar loop, ${r.tidied} passes)`);
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
  song.sections = detectSections({ song, mix: buf, offset: off, vocals: stems?.vocals, drums: stems?.drums });
  report.push(`Sections: ${song.sections.map((s) => s.name).join(', ')}`);
  if (opts.keepVocals && stems?.vocals) {
    const t = await vocalTrack(stems.vocals, song, colors[song.tracks.length % colors.length]);
    song.tracks.push(t);
    report.push('The original vocals are on their own track');
  }
  store.loadSong(song);
  engine.applySynthMute();
  aborted(signal);

  // 5. Instruments
  const find = phase('find', 'Finding instruments…');
  const pitched = store.song.tracks.filter((t) => roleOf.has(t.id));
  for (const [i, t] of pitched.entries()) {
    aborted(signal);
    const role = roleOf.get(t.id)!;
    const stem = stems ? (role === 'drums' ? stems.drums : role === 'bass' ? stems.bass : stems.other) : undefined;
    const span = busiestStretch(store.song, t);
    const all = finderCandidates(t, false);
    const cands =
      role === 'drums' ? all.map((x) => x.id)
      : role === 'bass' ? all.filter((x) => x.group === 'Bass').map((x) => x.id)
      : opts.thorough ? all.map((x) => x.id)
      : SHORTLIST[role];
    try {
      const res = await findInstrument({
        song: store.song,
        trackId: t.id,
        from: span.from,
        to: span.to,
        reference: stem ?? buf,
        offset: off,
        candidates: cands,
        signal,
        onProgress: (d, n, label) => find((i + d / Math.max(1, n)) / pitched.length, `Finding the ${t.name.toLowerCase()} sound: ${label || 'done'}`),
      });
      const best = res[0];
      if (best) {
        const gain = Math.pow(10, Math.max(-18, Math.min(18, best.levelDb)) / 20);
        store.update(() => {
          t.instrument = best.id;
          t.volume = Math.round(Math.max(0.02, Math.min(1.5, t.volume * gain)) * 1000) / 1000;
        });
        report.push(`${t.name}: ${best.label}${res[1] ? ` (next closest: ${res[1].label})` : ''}`);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      report.push(`${t.name}: kept ${instrumentFor(t.instrument).label} (${(e as Error).message})`);
    }
  }

  // 6. Tone and mix
  const tone = phase('tone', 'Fitting each part’s tone…');
  if (stems) {
    for (const [i, t] of pitched.entries()) {
      aborted(signal);
      const role = roleOf.get(t.id)!;
      if (role === 'melody') continue; // it shares its stem with the chords, which dominate it
      tone(i / pitched.length, `Fitting the ${t.name.toLowerCase()}’s tone…`);
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
  const mix = phase('mix', 'Matching the mix…');
  mix(0);
  const sound = actions.analyzeReference();
  if (sound) {
    // Compare over the first hook (or the busiest part): the fullest, most typical stretch.
    const hook = store.song.sections?.find((s) => s.name === 'Hook');
    const loop = store.song.loop;
    const saved = { ...loop };
    store.update((s) => {
      const start = hook ? hook.tick : 8 * BAR;
      s.loop = { enabled: true, start: Math.min(start, (s.bars - 4) * BAR), end: Math.min(s.bars * BAR, start + 8 * BAR) };
    });
    const changes = await actions.matchMix(sound, (msg) => mix(0.5, msg));
    store.update((s) => (s.loop = saved));
    if (sound.echo) {
      const lead = store.song.tracks.find((t) => roleOf.get(t.id) === 'melody');
      if (lead) store.update(() => (lead.echo = 0.2));
    }
    if (changes.length) report.push(`Master: ${changes.join(' · ')}`);
  }
  step('Done', 1);
  return report;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 40;
}

/** The separated vocals as a sampler track: one long note playing the stem in time with the grid. */
async function vocalTrack(vocals: AudioBuffer, song: Song, color: string): Promise<Track> {
  const id = await putFile('Original vocals.wav', await encodeWav(vocals).arrayBuffer());
  const tl = new Timeline(song);
  // Song time 0 is `-audioOffset` seconds into the recording.
  const lead = Math.max(0, -song.audioOffset);
  const dur = vocals.duration - lead;
  return {
    id: newTrackId(),
    name: 'Vocals (original)',
    kind: 'synth',
    instrument: 'sampler',
    color,
    volume: 0.8,
    pan: 0,
    reverb: 0,
    // The sampler follows the song's tuning; cancel it so the vocals stay as recorded.
    tune: -(song.tuning ?? 0),
    mute: false,
    solo: false,
    visible: true,
    sampler: { ...DEFAULT_SAMPLER, file: id, name: 'Original vocals', mode: 'pitch', root: 60, start: lead / vocals.duration, end: 1, attack: 0.005, release: 0.2 },
    notes: [{ id: newNoteId(), pitch: 60, start: 0, dur: Math.max(1, Math.round(tl.secToTick(dur))), vel: 1 }],
  };
}
