/**
 * The chords and melody read again as notes on sounds fitted to the original (desktop app, where the --sep
 * tools are set up: vst/resynth.py). The built-in route hears notes with a general model and then looks for the
 * nearest ready-made instrument; this one models the stem itself as notes of one harmonic sound, so the notes,
 * their loudness, the overtones and how a note swells and fades all come from the same fit.
 *
 * The fitted tracks replace the built-in ones only if the part then matches the original better (the same
 * comparison the report uses).
 */
import { compareRemake, type Role } from '../audio/compare';
import { mono, RATE, resampled } from '../audio/finder';
import { encodeWav, renderSong } from '../audio/render';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, newNoteId, newTrackId, type Song, type Track } from '../core/types';
import type { Store } from '../core/store';
import { desktop } from './desktop';

export interface FittedContext {
  store: Store;
  roleOf: Map<string, Role>;
  stems: { drums: AudioBuffer; bass: AudioBuffer; other: AudioBuffer };
  offset: number;
  colors: string[];
}

const MELODIC: Role[] = ['chords', 'melody', 'extra'];
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** Returns lines for the report (none where the tools are not set up). */
export async function fittedParts(c: FittedContext): Promise<string[]> {
  const app = desktop();
  if (!app?.resynthRun || !(await app.devocalReady())) return [];
  const r = await app.resynthRun(new Uint8Array(await encodeWav(c.stems.other).arrayBuffer()));
  if (r.error) return [`Sounds fitted to the original: not used (${r.error})`];
  if (!r.notes?.length || !r.kinds || !r.harmonics || !r.step) return [];
  const song = c.store.song;
  const tl = new Timeline(song);
  const end = song.bars * BAR;
  const notes = r.notes
    .map((n) => {
      const start = Math.max(0, Math.round(tl.secToTick(n[1] + c.offset)));
      return { id: newNoteId(), pitch: n[0], start, dur: Math.max(1, Math.round(tl.secToTick(n[2] + c.offset)) - start), vel: Math.max(0.05, Math.min(1, n[3])), shape: n[5] };
    })
    .filter((n) => n.start < end);
  // One track: every note carries its own level curve; the commonest kind's envelope is the sound's own, for
  // notes added by hand.
  const usual = [...r.kinds].sort((x, y) => y.notes - x.notes)[0];
  const tracks: Track[] = notes.length
    ? [{
        id: newTrackId(),
        name: 'Chords',
        kind: 'synth',
        instrument: 'fitted',
        fitted: { harmonics: r.harmonics, envelope: usual.envelope, step: r.step },
        color: c.colors[song.tracks.length % c.colors.length],
        volume: 0.8,
        pan: 0,
        reverb: 0.1,
        mute: false,
        solo: false,
        visible: true,
        notes,
      }]
    : [];
  if (!tracks.length) return [];

  const others = song.tracks.filter((t) => !MELODIC.includes(c.roleOf.get(t.id) as Role));
  const fitted: Song = { ...cloneSong(song), tracks: [...others, ...tracks] };
  // As loud as the stem, over the whole song (the later steps fit the tone and follow the level bar by bar).
  const seconds = Math.min(tl.tickToSec(end), c.stems.other.duration + c.offset);
  const solo: Song = { ...cloneSong(fitted), tracks: tracks.map((t) => ({ ...t })) };
  const ours = rms(mono(await renderSong(solo, { from: 0, to: seconds, tail: 0, dynamics: false, sampleRate: RATE }), 0, seconds));
  const theirs = rms(await resampled(c.stems.other, -c.offset, seconds - c.offset));
  if (!(ours > 0)) return [];
  const volume = Math.round(Math.max(0.02, Math.min(1.5, (0.8 * theirs) / ours)) * 1000) / 1000;
  for (const t of fitted.tracks) if (tracks.some((x) => x.id === t.id)) t.volume = volume;
  for (const t of tracks) t.volume = volume;

  const roles = new Map(c.roleOf);
  for (const t of tracks) roles.set(t.id, 'chords');
  const score = async (s: Song) => (await compareRemake(s, c.stems, c.offset, roles, undefined, ['other'])).parts[0]?.score ?? 0;
  const had = song.tracks.some((t) => !t.mute && MELODIC.includes(c.roleOf.get(t.id) as Role));
  const before = had ? await score(song) : 0;
  const after = await score(fitted);
  if (after <= before) return [`Sounds fitted to the original: not used (they matched its chords and melody ${after} of 100, the built-in sounds ${before})`];
  c.store.update((s) => {
    s.tracks = [...s.tracks.filter((t) => !MELODIC.includes(c.roleOf.get(t.id) as Role)), ...tracks];
  });
  for (const t of tracks) c.roleOf.set(t.id, 'chords');
  return [
    `Chords and melody: read again as ${tracks.reduce((n, t) => n + t.notes.length, 0)} notes on a sound fitted to the original (its overtones, and each note's own swell and fade), matching it ${after} of 100 (the built-in sounds: ${before})`,
  ];
}
