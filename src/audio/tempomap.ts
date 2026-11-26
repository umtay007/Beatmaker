import { PPQ, type TempoChange } from '../core/types';

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];

/**
 * A straight line through detected beats against their beat numbers: the beat's length and where beat 0 falls.
 * The rough length is first sharpened to the one the beats agree on best (within 4%: a rough length a fraction
 * of a percent out miscounts beats over a few minutes). Beats are then numbered by rounding, so a missed beat
 * leaves a gap instead of shifting the count, and a line is fitted twice.
 */
export function fitBeats(beats: number[], rough: number): { beat: number; origin: number } {
  let beat = rough;
  let best = 0;
  for (let c = rough * 0.96; c <= rough * 1.04; c += rough * 0.0001) {
    // how well the beats line up on a grid this long: the length of their summed phase arrows
    let x = 0;
    let y = 0;
    for (const t of beats) {
      x += Math.cos((2 * Math.PI * t) / c);
      y += Math.sin((2 * Math.PI * t) / c);
    }
    if (x * x + y * y > best) {
      best = x * x + y * y;
      beat = c;
    }
  }
  let origin = beats[0];
  for (let pass = 0; pass < 2; pass++) {
    const idx = beats.map((t) => Math.round((t - origin) / beat));
    const mi = idx.reduce((x, v) => x + v, 0) / idx.length;
    const mt = beats.reduce((x, v) => x + v, 0) / beats.length;
    beat = idx.reduce((x, v, i) => x + (v - mi) * (beats[i] - mt), 0) / idx.reduce((x, v) => x + (v - mi) ** 2, 0);
    origin = mt - mi * beat;
  }
  return { beat, origin };
}

export interface TempoMap {
  bpm: number;
  /** Seconds into the audio where bar 1 starts. */
  firstBeat: number;
  changes: TempoChange[];
  /** The steady stretches found: tempo and where each starts in the audio. */
  stretches: { bpm: number; from: number }[];
}

/**
 * A tempo map from detected beats and downbeats, for songs that change tempo (an intro at one speed, the beat at
 * another). Steady stretches are each fitted on their own; between two of them one short bridging stretch (about
 * a bar, at an in-between tempo) carries the grid across, so the next stretch's bar lines fall on bar lines.
 * Returns null when there are too few beats to tell.
 */
export function tempoMap(beats: number[], downbeats: number[]): TempoMap | null {
  if (beats.length < 16) return null;
  // ponytail: gaps are folded into 91-182 BPM, so half- and double-time detections count as one tempo; a song
  // whose tempo sits right at an edge of that range could split in two. Widen with a tempo prior if it happens.
  const fold = (v: number) => {
    while (v < 0.33) v *= 2;
    while (v >= 0.66) v /= 2;
    return v;
  };
  const gaps = beats.slice(1).map((t, i) => fold(t - beats[i]));
  const smooth = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - 4), i + 5)));
  // runs of gaps that stay within 6% of where the run began; short runs (the muddle around a change) are dropped
  const runs: { a: number; b: number; beat: number; origin: number; bar: number }[] = [];
  for (let i = 1, start = 0; i <= smooth.length; i++) {
    if (i < smooth.length && Math.abs(smooth[i] / smooth[start] - 1) <= 0.06) continue;
    if (i - start >= 16) {
      const rough = median(gaps.slice(start, i));
      const last = runs[runs.length - 1];
      if (last && Math.abs(rough / last.beat - 1) < 0.03) last.b = i; // the same tempo carried on after a muddle
      else runs.push({ a: start, b: i, beat: rough, origin: 0, bar: 0 });
    }
    start = i;
  }
  if (!runs.length) return null;
  for (const r of runs) {
    Object.assign(r, fitBeats(beats.slice(r.a, r.b + 1), r.beat));
    // where bar lines fall: the downbeats inside the run, as an angle so the wrap-around averages properly
    const bar = 4 * r.beat;
    const ang = downbeats.filter((t) => t >= beats[r.a] && t <= beats[r.b]).map((t) => (((t - r.origin) % bar) / bar) * 2 * Math.PI);
    const mean = Math.atan2(ang.reduce((x, v) => x + Math.sin(v), 0), ang.reduce((x, v) => x + Math.cos(v), 0));
    r.bar = ang.length ? ((Math.round((mean / (2 * Math.PI)) * 4) % 4) + 4) % 4 : 0; // which beat of the run's count is a downbeat
  }
  // each run reaches out over the neighbouring beats that sit on its grid (later runs first: the beat that
  // follows a change is the one that matters)
  const fits = (r: (typeof runs)[0], t: number) => Math.abs((t - r.origin) / r.beat - Math.round((t - r.origin) / r.beat)) < 0.15;
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k];
    const floor = k ? runs[k - 1].b + 1 : 0;
    while (r.a > floor && fits(r, beats[r.a - 1])) r.a--;
    const ceil = k < runs.length - 1 ? runs[k + 1].a - 1 : beats.length - 1;
    while (r.b < ceil && fits(r, beats[r.b + 1])) r.b++;
  }
  const first = runs[0];
  const bar0 = 4 * first.beat;
  const firstBeat = (((first.origin + first.bar * first.beat) % bar0) + bar0) % bar0;
  const bpmOf = (beat: number) => Math.round(60000 / beat) / 1000;
  const changes: TempoChange[] = [];
  const stretches = [{ bpm: bpmOf(first.beat), from: beats[first.a] }];
  // the grid so far: beat number `n` (counted from bar 1) falls at `at` seconds, beats `len` long
  let n = 0;
  let at = firstBeat;
  let len = first.beat;
  for (let k = 1; k < runs.length; k++) {
    const r = runs[k];
    // the last beat line of the grid so far: where the stretch before stops fitting, and at least a bridge's
    // length before this run takes over
    const steps = Math.max(0, Math.floor((Math.min(beats[runs[k - 1].b], beats[r.a] - 3.5 * r.beat) - at) / len + 0.01));
    n += steps;
    at += steps * len;
    // the bridge ends on this run's first beat line
    const line = Math.ceil((Math.max(beats[r.a], at + 3.5 * r.beat) - r.origin) / r.beat - 0.01);
    const end = r.origin + line * r.beat;
    // as many beats long as lands that line on the right beat of the bar, nearest to the time it spans
    const want = (end - at) / ((len + r.beat) / 2);
    let m = Math.max(1, Math.round(want));
    for (const d of [0, 1, -1, 2, -2]) if (m + d >= 1 && (((n + m + d - (line - r.bar)) % 4) + 4) % 4 === 0) { m += d; break; }
    changes.push({ tick: n * PPQ, bpm: bpmOf((end - at) / m) }, { tick: (n + m) * PPQ, bpm: bpmOf(r.beat) });
    stretches.push({ bpm: bpmOf(r.beat), from: end });
    n += m;
    at = end;
    len = r.beat;
  }
  return { bpm: bpmOf(first.beat), firstBeat, changes, stretches };
}
