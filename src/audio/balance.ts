/**
 * The balance of the finished mix. A part's tone and level are set against its own stem with nothing
 * else on, but the reverb and the master chain change them, and in bars where drums and bass play the
 * chords and melody are buried so nothing shows. The bars where only they play (an intro, a
 * breakdown) do: there the whole mix is the original's "other" stem, so the difference is how far off
 * the chords and melody are, in tone and in level, and the pads' own EQ and volume close it.
 */
import { Timeline } from '../core/timing';
import { BAR, type Song, type Track } from '../core/types';
import { mono, RATE, resampled } from './finder';
import { renderSong } from './render';
import { fitTone, ltas } from './tonefit';
import { average } from './tonepass';

/** The original's drums or bass are absent from a bar this quiet (dB re full scale). */
const ABSENT = -55;
/** Fewest bars that make a reading. */
const MIN_BARS = 4;
/** Most the track EQ may move any band (dB; the editor's range). */
const EQ_MAX = 18;
/** Highest band the tone cares about (Hz; the render runs at RATE). */
const TONE_HI = 9000;

const db = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
};
const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));

export interface Balance {
  /** Spectral gap (dB rms, third-octave bands) between the pads' finished mix and the original, before and after the EQ. */
  tone: [number, number];
  /** Volume change (dB) that made them as loud as the original's. */
  level: number;
}

/** Fix the chords and melody (`pads`) against the original's other stem where only they play. Null if no bar has them alone. */
export async function balancePads(song: Song, stems: { drums: AudioBuffer; bass: AudioBuffer; other: AudioBuffer }, offset: number, pads: Track[], edit: (change: () => void) => void): Promise<Balance | null> {
  const tl = new Timeline(song);
  const seconds = Math.min(tl.tickToSec(song.bars * BAR), stems.other.duration + offset);
  const secs = Array.from({ length: song.bars + 1 }, (_, i) => tl.tickToSec(i * BAR));
  const at = secs.map((s) => Math.round(s * RATE));
  const [drums, bass, other] = await Promise.all([stems.drums, stems.bass, stems.other].map((s) => resampled(s, -offset, seconds - offset)));
  // The bars that count: drums and bass absent from the original (and not the first of a run: the reverb tail of the full bars before it rings on).
  const counted: number[] = [];
  let before = false;
  for (let i = 0; i + 1 < at.length; i++) {
    const [a, z] = [at[i], Math.min(drums.length, bass.length, other.length, at[i + 1])];
    const alone = z - a > RATE / 4 && db(drums, a, z) < ABSENT && db(bass, a, z) < ABSENT;
    if (alone && before) counted.push(i);
    before = alone;
  }
  if (counted.length < MIN_BARS || !pads.length) return null;
  const render = () => renderSong(song, { from: 0, to: seconds, tail: 0, sampleRate: RATE });

  // Tone: the pads' EQ moves by what closes the gap between the finished mix and the original's other stem.
  const buf = await render();
  const target = average(counted.map((i) => ltas(stems.other, secs[i] - offset, secs[i + 1] - offset)));
  const fit = fitTone(target, average(counted.map((i) => ltas(buf, secs[i], secs[i + 1]))), 60, TONE_HI, 9);
  edit(() => {
    for (const t of pads) {
      t.eqLow = clamp((t.eqLow ?? 0) + fit.eqLow, EQ_MAX);
      t.eqHigh = clamp((t.eqHigh ?? 0) + fit.eqHigh, EQ_MAX);
      // (A bell already set stays: two bells at different frequencies can't be added into one.)
      if (Math.abs(t.eqMid ?? 0) < 0.5) {
        t.eqMid = fit.eqMid;
        t.eqMidFreq = fit.eqMidFreq;
      }
    }
  });

  // Level: the median bar's difference, measured again after each change (the EQ moved it too).
  let level = 0;
  for (let pass = 0; pass < 2; pass++) {
    const mine = mono(await render(), 0, seconds);
    const diffs = counted.map((i) => db(mine, at[i], Math.min(mine.length, at[i + 1])) - db(other, at[i], Math.min(other.length, at[i + 1]))).sort((x, y) => x - y);
    const d = diffs[diffs.length >> 1];
    if (Math.abs(d) < 1) break;
    const g = clamp(-d, 9);
    const f = Math.pow(10, g / 20);
    const scale = (v: number) => Math.max(0.02, Math.min(1.5, v * f));
    edit(() => {
      for (const t of pads) {
        t.volume = scale(t.volume);
        if (t.automation?.volume) t.automation.volume = t.automation.volume.map((p) => ({ ...p, value: scale(p.value) }));
      }
    });
    level += g;
  }
  return { tone: [fit.before, fit.after], level };
}
