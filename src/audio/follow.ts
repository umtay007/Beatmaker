/**
 * Follow the original's loudness bar by bar: a song's parts swell and drop (a pad that comes in for
 * the hook, drums that thin out in a break), and a remake whose notes are right but whose levels
 * are flat sounds wrong for it. Each part is rendered, compared with the same bars of its separated
 * stem, and the difference (beyond the overall level, which is the track's own volume) is written
 * into the track's volume lane, one step per bar.
 */
import { Timeline } from '../core/timing';
import { BAR, cloneSong, type AutoPoint, type Song, type Track } from '../core/types';
import { mono, RATE, resampled } from './finder';
import { renderSong } from './render';

export interface Follow {
  /** The tracks that make up the part (they share one stem and get the same changes). */
  tracks: Track[];
  stem: AudioBuffer;
}

/** Most the volume moves from its overall level (dB). */
const UP = 6;
const DOWN = 9;
/** Bars quieter than this (dB re full scale) in the render or the stem have nothing to follow. */
const SILENT = -64;

const db = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
};

/** The change in dB for each bar of one part, or null if there's nothing to compare. */
async function barGains(song: Song, part: Follow, offset: number, seconds: number, barSecs: number[]): Promise<number[] | null> {
  const solo = cloneSong(song);
  solo.tracks = solo.tracks.filter((t) => part.tracks.some((x) => x.id === t.id));
  for (const t of solo.tracks) {
    t.mute = t.solo = false;
    delete t.automation?.volume;
  }
  if (!solo.tracks.length) return null;
  const mine = mono(await renderSong(solo, { from: 0, to: seconds, tail: 0, dynamics: false, sampleRate: RATE }), 0, seconds);
  const theirs = await resampled(part.stem, -offset, seconds - offset);
  const n = Math.min(mine.length, theirs.length);
  const rel: (number | null)[] = [];
  for (let b = 0; b + 1 < barSecs.length; b++) {
    const a = Math.round(barSecs[b] * RATE);
    const z = Math.min(n, Math.round(barSecs[b + 1] * RATE));
    if (z - a < RATE / 4) {
      rel.push(null);
      continue;
    }
    const m = db(mine, a, z);
    const s = db(theirs, a, z);
    rel.push(m < SILENT || s < SILENT ? null : s - m);
  }
  const known = rel.filter((v): v is number => v !== null).sort((x, y) => x - y);
  if (known.length < 8) return null;
  const overall = known[known.length >> 1];
  const raw = rel.map((v) => (v === null ? 0 : Math.max(-DOWN, Math.min(UP, v - overall))));
  // A light smoothing: a level that jumps for one bar and back is more likely noise than the mix.
  return raw.map((v, i) => 0.25 * (raw[i - 1] ?? v) + 0.5 * v + 0.25 * (raw[i + 1] ?? v));
}

/** Write each part's bar-by-bar volume into its tracks. Returns how many bars moved by 2 dB or more, per part. */
export async function followLevels(song: Song, parts: Follow[], offset: number, apply: (track: Track, lane: AutoPoint[]) => void): Promise<number[]> {
  const tl = new Timeline(song);
  const seconds = Math.min(tl.tickToSec(song.bars * BAR), parts[0]?.stem.duration + offset);
  const barSecs = Array.from({ length: song.bars + 1 }, (_, i) => tl.tickToSec(i * BAR));
  const moved: number[] = [];
  for (const part of parts) {
    const gains = await barGains(song, part, offset, seconds, barSecs);
    moved.push(gains ? gains.filter((g) => Math.abs(g) >= 2).length : 0);
    if (!gains) continue;
    for (const t of part.tracks) {
      const lane: AutoPoint[] = [];
      const base = t.volume;
      gains.forEach((g, b) => {
        const value = Math.max(0.02, Math.min(1.5, base * Math.pow(10, g / 20)));
        lane.push({ tick: b * BAR, value }, { tick: (b + 1) * BAR - 1, value });
      });
      apply(t, lane);
    }
  }
  return moved;
}
