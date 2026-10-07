/**
 * The balance of the finished mix. A part's level is set against its own stem with nothing else on,
 * but the reverb and the master chain change it, and in bars where drums and bass play the chords and
 * melody are buried so nothing shows. The bars where only they play (an intro, a breakdown) do: there
 * the whole mix is the original's "other" stem, so the difference is how far off they are.
 */
import { Timeline } from '../core/timing';
import { BAR, type Song } from '../core/types';
import { mono, RATE, resampled } from './finder';
import { renderSong } from './render';

/** The original's drums or bass are absent from a bar this quiet (dB re full scale). */
const ABSENT = -55;
/** Fewest bars that make a reading. */
const MIN_BARS = 4;

const db = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
};

/** How many dB louder the remake's finished mix is than the original's chords and melody where only they play (null: no such bars). */
export async function padOffset(song: Song, stems: { drums: AudioBuffer; bass: AudioBuffer; other: AudioBuffer }, offset: number): Promise<number | null> {
  const tl = new Timeline(song);
  const seconds = Math.min(tl.tickToSec(song.bars * BAR), stems.other.duration + offset);
  const at = Array.from({ length: song.bars + 1 }, (_, i) => Math.round(tl.tickToSec(i * BAR) * RATE));
  const mine = mono(await renderSong(song, { from: 0, to: seconds, tail: 0, sampleRate: RATE }), 0, seconds);
  const [drums, bass, other] = await Promise.all([stems.drums, stems.bass, stems.other].map((s) => resampled(s, -offset, seconds - offset)));
  const n = Math.min(mine.length, drums.length, bass.length, other.length);
  const diffs: number[] = [];
  let before = false;
  for (let i = 0; i + 1 < at.length; i++) {
    const [a, z] = [at[i], Math.min(n, at[i + 1])];
    // (Not the first bar after a full one: the reverb tail of the drums and bass is still ringing.)
    const alone = z - a > RATE / 4 && db(drums, a, z) < ABSENT && db(bass, a, z) < ABSENT;
    if (alone && before) diffs.push(db(mine, a, z) - db(other, a, z));
    before = alone;
  }
  if (diffs.length < MIN_BARS) return null;
  return diffs.sort((x, y) => x - y)[diffs.length >> 1];
}
