/**
 * The instrument finder: plays one track's notes on every candidate instrument (or drum kit) over
 * a stretch of the song and ranks them by how close each sounds to the original there.
 *
 * The comparison only looks where that track's notes are: for pitched parts, the spectrogram bins
 * around each sounding note's first ten harmonics; for drums, the moments around each hit. Other
 * parts of the recording mostly fall outside that mask (a separated stem is better still). Three
 * measures, all blind to a plain EQ difference (which the track's EQ can fix):
 * - texture: how each masked band moves over time, after removing its average level difference;
 * - harmonics: the overtone profile relative to each note's fundamental, minus any tilt;
 * - envelope: attack and decay after the note starts (or the drum hit).
 */
import { midiToFreq } from '../core/theory';
import { Timeline } from '../core/timing';
import { cloneSong, type Song, type Track } from '../core/types';
import { KITS } from './drums';
import { fft } from './fft';
import { INSTRUMENTS } from './instruments';
import { renderSong } from './render';
import { ensureSongSamplesStrict, recordedRange } from './samples';

export interface FinderCandidate {
  id: string;
  label: string;
  group: string;
  recorded: boolean;
}

export interface FinderResult extends FinderCandidate {
  /** Lower is closer. */
  score: number;
  texture: number;
  harmonics: number;
  envelope: number;
  /** How much louder (dB) the original is than this render in the track's own bands: the volume change to match it. */
  levelDb: number;
}

export interface FinderOptions {
  song: Song;
  trackId: string;
  /** Song seconds to compare. */
  from: number;
  to: number;
  /** The original, and the song time its start plays at (the song's audioOffset). */
  reference: AudioBuffer;
  offset: number;
  /** Instrument or kit ids to try (default: every one that fits the track). */
  candidates?: string[];
  onProgress?: (done: number, total: number, label: string) => void;
  signal?: AbortSignal;
}

/** Everything the finder can try on a track: drum kits for drums, instruments otherwise. */
export function finderCandidates(track: Track, recordedOnly = false): FinderCandidate[] {
  if (track.kind === 'drums') return KITS.map((k) => ({ id: k.id, label: k.label, group: k.group ?? 'Synthesized', recorded: (k.group ?? 'Synthesized') !== 'Synthesized' })).filter((c) => !recordedOnly || c.recorded);
  return INSTRUMENTS.filter((i) => i.id !== 'sampler' && i.id !== 'soundfont' && (!recordedOnly || i.sampled)).map((i) => ({ id: i.id, label: i.label, group: i.group, recorded: !!i.sampled }));
}

// ---------------------------------------------------------------------------------------------
// Spectrogram in log-spaced bands

const PER_OCT = 24;
const F_LO = 40;
const N_BANDS = PER_OCT * 8; // 40 Hz .. ~10 kHz
const bandOf = (f: number) => PER_OCT * Math.log2(f / F_LO);

interface Spec {
  /** Frame times in song seconds. */
  times: number[];
  /** dB per band per frame. */
  db: Float32Array[];
}

function mono(buf: AudioBuffer, from: number, to: number): Float32Array {
  const sr = buf.sampleRate;
  const a = Math.round(from * sr);
  const n = Math.max(0, Math.round((to - from) * sr));
  const out = new Float32Array(n);
  const chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const j = a + i;
      if (j >= 0 && j < d.length) out[i] += d[j] / chans;
    }
  }
  return out;
}

/** Analysis rate: renders are 2-3x quicker than at 44.1 kHz, and 10 kHz is as high as the bands go. */
const RATE = 22050;

/** The stretch of a recording as mono at RATE, starting at recording time `from`. */
async function resampled(buf: AudioBuffer, from: number, to: number): Promise<Float32Array> {
  const len = Math.max(1, Math.round((to - from) * RATE));
  const ctx = new OfflineAudioContext(1, len, RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  if (from >= 0) src.start(0, from);
  else src.start(-from, 0);
  return (await ctx.startRendering()).getChannelData(0);
}

/** `x` starts at song time `t0`. */
function spectrogram(x: Float32Array, sr: number, t0: number): Spec {
  // About 93 ms windows and 23 ms steps at any rate.
  const N = sr > 30000 ? 4096 : 2048;
  const hop = N / 4;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binOfBand = new Float64Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) binOfBand[b] = (F_LO * Math.pow(2, b / PER_OCT) * N) / sr;
  const times: number[] = [];
  const db: Float32Array[] = [];
  const pow = new Float64Array(N / 2 + 1);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = x[s + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    const row = new Float32Array(N_BANDS);
    for (let b = 0; b < N_BANDS; b++) {
      const f = binOfBand[b];
      const k = Math.floor(f);
      const w = f - k;
      // Neighbouring bins too, so a harmonic between two bins isn't lost.
      const p = Math.max(pow[k] ?? 0, pow[k + 1] ?? 0) * 0.5 + ((pow[k] ?? 0) * (1 - w) + (pow[k + 1] ?? 0) * w) * 0.5;
      row[b] = 10 * Math.log10(p + 1e-12);
    }
    db.push(row);
    times.push(t0 + (s + N / 2) / sr);
  }
  return { times, db };
}

// ---------------------------------------------------------------------------------------------
// Where the track plays

interface Sounding {
  start: number;
  end: number;
  pitch: number;
}

function sounding(song: Song, track: Track): Sounding[] {
  const tl = new Timeline(song);
  const tune = (song.tuning ?? 0) / 100 + (track.tune ?? 0) / 100;
  return track.notes.map((n) => ({ start: tl.tickToSec(n.start), end: tl.tickToSec(n.start + n.dur), pitch: n.pitch + tune }));
}

/** Mark the bands around the first ten harmonics of the notes sounding at `t`. */
function markHarmonics(m: Uint8Array, notes: Sounding[], t: number, value: number, f0s?: number[]): void {
  for (const n of notes) {
    if (t < n.start || t > n.end + 0.3) continue;
    const f0 = midiToFreq(n.pitch);
    f0s?.push(f0);
    for (let k = 1; k <= 10; k++) {
      const b = Math.round(bandOf(f0 * k));
      for (let d = -1; d <= 1; d++) if (b + d >= 0 && b + d < N_BANDS) m[b + d] = value;
    }
  }
}

/**
 * Per frame, the bands to compare (1), and for pitched tracks the fundamentals sounding. Bands the
 * song's other parts also cover are left out when enough remain: in a mix (or a stem holding
 * several instruments) they carry the other parts' sound, not this one's.
 */
function buildMask(spec: Spec, notes: Sounding[], others: Sounding[], drums: boolean): { mask: Uint8Array[]; f0s: number[][] } {
  const mask: Uint8Array[] = [];
  const f0s: number[][] = [];
  for (const t of spec.times) {
    const m = new Uint8Array(N_BANDS);
    const here: number[] = [];
    if (drums) {
      if (notes.some((n) => t >= n.start - 0.03 && t < n.start + 0.25)) m.fill(1);
    } else {
      markHarmonics(m, notes, t, 1, here);
      const own = m.reduce((a, v) => a + v, 0);
      const excl = m.slice();
      markHarmonics(excl, others, t, 0);
      if (excl.reduce((a, v) => a + v, 0) >= Math.max(4, own * 0.25)) m.set(excl);
    }
    mask.push(m);
    f0s.push(here);
  }
  return { mask, f0s };
}

// ---------------------------------------------------------------------------------------------
// Measures

const FLOOR = 60;

function clampFloor(spec: Spec): void {
  let peak = -200;
  for (const r of spec.db) for (const v of r) peak = Math.max(peak, v);
  const floor = peak - FLOOR;
  for (const r of spec.db) for (let b = 0; b < r.length; b++) if (r[b] < floor) r[b] = floor;
}

/** Masked spectral distance after removing each band's average offset, and the overall level offset (dB). */
function texture(ref: Spec, cand: Spec, mask: Uint8Array[]): { dist: number; level: number } {
  const n = Math.min(ref.db.length, cand.db.length);
  const off = new Float64Array(N_BANDS);
  const cnt = new Float64Array(N_BANDS);
  for (let t = 0; t < n; t++) for (let b = 0; b < N_BANDS; b++) if (mask[t][b]) {
    off[b] += ref.db[t][b] - cand.db[t][b];
    cnt[b]++;
  }
  let sum = 0;
  let k = 0;
  for (let t = 0; t < n; t++) for (let b = 0; b < N_BANDS; b++) if (mask[t][b]) {
    sum += Math.min(25, Math.abs(ref.db[t][b] - cand.db[t][b] - off[b] / cnt[b]));
    k++;
  }
  // The level: the median band offset, so a band full of another part doesn't drag it up.
  const offs: number[] = [];
  for (let b = 0; b < N_BANDS; b++) if (cnt[b] >= 3) offs.push(off[b] / cnt[b]);
  offs.sort((a, b) => a - b);
  return { dist: k ? sum / k : 99, level: offs.length ? offs[offs.length >> 1] : 0 };
}

/** Average overtone levels (harmonics 2..8, dB re the fundamental) over the sounding notes. */
function harmonicProfile(spec: Spec, f0s: number[][]): Float64Array | null {
  const prof = new Float64Array(7);
  let n = 0;
  spec.db.forEach((row, t) => {
    for (const f0 of f0s[t]) {
      const h1 = row[Math.round(bandOf(f0))];
      if (h1 === undefined) continue;
      for (let k = 2; k <= 8; k++) {
        const b = Math.round(bandOf(f0 * k));
        prof[k - 2] += (b < N_BANDS ? row[b] : h1 - 40) - h1;
      }
      n++;
    }
  });
  if (!n) return null;
  return prof.map((v) => Math.max(-40, v / n));
}

function harmonicDistance(a: Float64Array | null, b: Float64Array | null): number {
  if (!a || !b) return 0;
  // Remove a straight tilt over log2(k): that much an EQ can change.
  const xs = a.map((_, i) => Math.log2(i + 2));
  const d = a.map((v, i) => v - b[i]);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const md = d.reduce((s, x) => s + x, 0) / d.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (d[i] - md);
    sxx += (x - mx) ** 2;
  });
  const slope = sxx ? sxy / sxx : 0;
  let sum = 0;
  d.forEach((v, i) => (sum += Math.abs(v - md - slope * (xs[i] - mx))));
  return sum / d.length;
}

/** Mean envelope (dB re its peak, 25 ms steps from 50 ms before to 600 ms after) of the masked energy after each isolated onset. */
function envelopeShape(spec: Spec, mask: Uint8Array[], onsets: number[]): Float64Array | null {
  const steps = 26;
  const acc = new Float64Array(steps);
  let n = 0;
  const dt = spec.times.length > 1 ? spec.times[1] - spec.times[0] : 0.023;
  for (const on of onsets) {
    const curve: number[] = [];
    for (let s = 0; s < steps; s++) {
      const t = on - 0.05 + s * 0.025;
      const i = Math.round((t - spec.times[0]) / dt);
      if (i < 0 || i >= spec.db.length) break;
      const row = spec.db[i];
      const m = mask[Math.max(0, Math.min(mask.length - 1, Math.round((on + 0.05 - spec.times[0]) / dt)))];
      let p = 0;
      for (let b = 0; b < N_BANDS; b++) if (m[b]) p += Math.pow(10, row[b] / 10);
      curve.push(10 * Math.log10(p + 1e-12));
    }
    if (curve.length < steps) continue;
    const peak = Math.max(...curve);
    curve.forEach((v, s) => (acc[s] += Math.max(-40, v - peak)));
    n++;
  }
  return n ? acc.map((v) => v / n) : null;
}

function envelopeDistance(a: Float64Array | null, b: Float64Array | null): number {
  if (!a || !b) return 0;
  let s = 0;
  a.forEach((v, i) => (s += Math.abs(v - b[i])));
  return s / a.length;
}

// ---------------------------------------------------------------------------------------------

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

/** Rank instruments (or kits) for a track against the original over [from, to]. */
export async function findInstrument(o: FinderOptions): Promise<FinderResult[]> {
  const track = o.song.tracks.find((t) => t.id === o.trackId);
  if (!track) throw new Error('No such track');
  const drums = track.kind === 'drums';
  const all = finderCandidates(track);
  let cands = o.candidates ? all.filter((c) => o.candidates!.includes(c.id)) : all;
  const notes = sounding(o.song, track).filter((n) => n.end > o.from && n.start < o.to);
  if (!notes.length) throw new Error('The track has no notes in that part of the song');

  const ref = spectrogram(await resampled(o.reference, o.from - o.offset, o.to - o.offset), RATE, o.from);
  clampFloor(ref);
  const others = o.song.tracks.filter((t) => t.id !== track.id && t.kind !== 'drums' && !t.mute).flatMap((t) => sounding(o.song, t)).filter((n) => n.end > o.from && n.start < o.to);
  const { mask, f0s } = buildMask(ref, notes, others, drums);
  // Recordings stretched far past their range (a trombone up at G6) sound like nothing real.
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const lo = pitches[Math.floor(pitches.length * 0.1)];
  const hi = pitches[Math.floor(pitches.length * 0.9)];
  const inRange = (id: string) => {
    const r = recordedRange(id);
    return !r || (lo >= r[0] - 7 && hi <= r[1] + 7);
  };
  const onsets = [...new Set(notes.map((n) => n.start))].sort((a, b) => a - b).filter((t, i, arr) => t >= o.from && t < o.to - 0.6 && (i + 1 >= arr.length || arr[i + 1] - t >= (drums ? 0.12 : 0.25)));
  if (!drums) cands = cands.filter((c) => inRange(c.id));
  const refProf = drums ? null : harmonicProfile(ref, f0s);
  const refEnv = envelopeShape(ref, mask, onsets);

  // The track alone, flat: its own EQ and colour belong to the current instrument, not the next one.
  const base = cloneSong(o.song);
  base.tracks = base.tracks.filter((t) => t.id === track.id);
  const solo = base.tracks[0];
  Object.assign(solo, { mute: false, solo: false, eqLow: 0, eqMid: 0, eqHigh: 0, hpf: 20, lpf: 20000, fx: undefined, duck: 0, automation: undefined });
  // Start early enough for notes already ringing when the stretch begins.
  const pre = 4;
  const out: FinderResult[] = [];
  let done = 0;
  const one = async (c: FinderCandidate): Promise<void> => {
    aborted(o.signal);
    const song = cloneSong(base);
    song.tracks[0].instrument = c.id;
    const ok = drums || !c.recorded || !(await ensureSongSamplesStrict(song.tracks, 2)).length;
    if (ok) {
      aborted(o.signal);
      const from = Math.max(0, o.from - pre);
      const buf = await renderSong(song, { from, to: o.to, tail: 0, dynamics: false, sampleRate: RATE });
      const spec = spectrogram(mono(buf, o.from - from, o.to - from), RATE, o.from);
      clampFloor(spec);
      const tex = texture(ref, spec, mask);
      const harm = drums ? 0 : harmonicDistance(refProf, harmonicProfile(spec, f0s));
      const env = envelopeDistance(refEnv, envelopeShape(spec, mask, onsets));
      out.push({ ...c, texture: tex.dist, harmonics: harm, envelope: env, levelDb: tex.level, score: tex.dist + 0.6 * harm + 0.8 * env });
    }
    o.onProgress?.(++done, cands.length, c.label);
  };
  // A few at a time: offline renders run on their own threads, and downloads overlap renders.
  const queue = [...cands];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await one(c);
  }));
  return out.sort((a, b) => a.score - b.score);
}

/** The stretch to compare when none is chosen: the 8 bars (or fewer) where the track has the most notes. */
export function busiestStretch(song: Song, track: Track, bars = 8): { from: number; to: number } {
  const tl = new Timeline(song);
  const BARTICKS = 384;
  const counts = new Array(song.bars).fill(0);
  for (const n of track.notes) counts[Math.floor(n.start / BARTICKS)] = (counts[Math.floor(n.start / BARTICKS)] ?? 0) + 1;
  const len = Math.min(bars, song.bars);
  let best = 0;
  let bestN = -1;
  for (let b = 0; b + len <= song.bars; b++) {
    let s = 0;
    for (let k = b; k < b + len; k++) s += counts[k] ?? 0;
    if (s > bestN) {
      bestN = s;
      best = b;
    }
  }
  return { from: tl.tickToSec(best * BARTICKS), to: tl.tickToSec((best + len) * BARTICKS) };
}
