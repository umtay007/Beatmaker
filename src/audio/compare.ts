/**
 * The remake against the original, part by part: each separated stem (drums, bass, everything
 * else) is compared with the remake's matching tracks played alone, and the gaps are named.
 *
 * Per part, over the whole song and per bar:
 * - hits: do the attacks land together (onsets of both, matched within about 70 ms);
 * - pitch: do the same pitch classes sound (chroma similarity, pitched parts only);
 * - loudness: do the two rise and fall together (correlation of their level over time);
 * - tone: after removing the average EQ difference (a mix setting), how alike do the bands move.
 * The average EQ difference itself is reported in words, since that is what a person would change.
 */
import { Timeline } from '../core/timing';
import { BAR, cloneSong, type Song } from '../core/types';
import { clampFloor, F_LO, mono, N_BANDS, PER_OCT, RATE, resampled, spectrogram, type Spec } from './finder';
import { renderSong } from './render';

export type Role = 'drums' | 'bass' | 'chords' | 'melody';
type Part = 'drums' | 'bass' | 'other';

export interface PartScore {
  part: string;
  /** 0-100. */
  score: number;
  hits: number;
  pitch: number | null;
  loudness: number;
  tone: number;
  /** Where the remake's tone is off, in words. */
  eq: string[];
  /** The weakest bars (1-based) with their scores. */
  worst: { bar: number; score: number }[];
}

export interface Comparison {
  overall: number;
  parts: PartScore[];
}

const PARTS: { part: Part; name: string; roles: Role[]; lo: number; hi: number; weight: number; pitched: boolean }[] = [
  { part: 'drums', name: 'Drums', roles: ['drums'], lo: 40, hi: 10000, weight: 0.3, pitched: false },
  { part: 'bass', name: 'Bass', roles: ['bass'], lo: 40, hi: 500, weight: 0.3, pitched: true },
  { part: 'other', name: 'Chords + melody', roles: ['chords', 'melody'], lo: 150, hi: 6000, weight: 0.4, pitched: true },
];
/** How much each measure counts, per part. */
const WEIGHTS: Record<Part, { hits: number; pitch: number; loudness: number; tone: number }> = {
  drums: { hits: 0.45, pitch: 0, loudness: 0.25, tone: 0.3 },
  bass: { hits: 0.2, pitch: 0.35, loudness: 0.2, tone: 0.25 },
  other: { hits: 0.1, pitch: 0.45, loudness: 0.2, tone: 0.25 },
};

const bandHz = (b: number) => F_LO * Math.pow(2, b / PER_OCT);
const bandAt = (f: number) => Math.max(0, Math.min(N_BANDS - 1, Math.round(PER_OCT * Math.log2(f / F_LO))));
/** Pitch class of a band (the bands are a quarter-tone apart). */
const pitchClass = (b: number) => ((Math.round(69 + 12 * Math.log2(bandHz(b) / 440)) % 12) + 12) % 12;

interface Feat {
  /** Level per frame (dB), and the loudest. */
  e: Float64Array;
  peak: number;
  chroma: Float64Array[];
  onsets: number[];
}

function features(spec: Spec, lo: number, hi: number): Feat {
  const n = spec.db.length;
  const b0 = bandAt(lo);
  const b1 = bandAt(hi);
  const e = new Float64Array(n);
  const chroma: Float64Array[] = [];
  const flux = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const row = spec.db[t];
    const c = new Float64Array(12);
    let p = 0;
    for (let b = 0; b < N_BANDS; b++) p += Math.pow(10, row[b] / 10);
    for (let b = b0; b <= b1; b++) c[pitchClass(b)] += Math.pow(10, row[b] / 10);
    e[t] = 10 * Math.log10(p + 1e-12);
    chroma.push(c);
    if (t) for (let b = b0; b <= b1; b++) flux[t] += Math.max(0, row[b] - spec.db[t - 1][b]);
  }
  const peak = e.reduce((a, v) => Math.max(a, v), -200);
  // Peaks of the flux that clear its local average (about a second either side), while sounding.
  const onsets: number[] = [];
  const W = 43;
  const prefix = new Float64Array(n + 1);
  for (let t = 0; t < n; t++) prefix[t + 1] = prefix[t] + flux[t];
  for (let t = 0; t < n; t++) {
    const a = Math.max(0, t - W);
    const z = Math.min(n - 1, t + W);
    const mean = (prefix[z + 1] - prefix[a]) / (z - a + 1);
    let top = true;
    for (let k = Math.max(0, t - 2); k <= Math.min(n - 1, t + 2); k++) if (flux[k] > flux[t] || (flux[k] === flux[t] && k < t)) top = false;
    if (top && flux[t] > 1.6 * mean + 8 && e[t] > peak - 40) onsets.push(t);
  }
  return { e, peak, chroma, onsets };
}

const TOL = 3;

/** Stem onsets that have a render onset nearby (each used once): the indices of the matched stem onsets. */
function matched(a: number[], b: number[]): Set<number> {
  const used = new Set<number>();
  const hit = new Set<number>();
  for (const x of a) {
    let best = -1;
    for (const y of b) if (!used.has(y) && Math.abs(y - x) <= TOL && (best < 0 || Math.abs(y - x) < Math.abs(best - x))) best = y;
    if (best >= 0) {
      used.add(best);
      hit.add(x);
    }
  }
  return hit;
}

function pearson(a: Float64Array, b: Float64Array, from: number, to: number, floorA: number, floorB: number): number | null {
  const n = to - from;
  if (n < 8) return null;
  let ma = 0;
  let mb = 0;
  for (let t = from; t < to; t++) {
    ma += Math.max(a[t], floorA);
    mb += Math.max(b[t], floorB);
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let t = from; t < to; t++) {
    const x = Math.max(a[t], floorA) - ma;
    const y = Math.max(b[t], floorB) - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 1e-9 && sbb > 1e-9 ? sab / Math.sqrt(saa * sbb) : null;
}

const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

function combine(w: { hits: number; pitch: number; loudness: number; tone: number }, m: { hits: number | null; pitch: number | null; loudness: number | null; tone: number | null }): number | null {
  let s = 0;
  let k = 0;
  for (const key of ['hits', 'pitch', 'loudness', 'tone'] as const) {
    const v = m[key];
    if (v === null || w[key] === 0) continue;
    s += v * w[key];
    k += w[key];
  }
  return k ? s / k : null;
}

/** A window of frames [from, to): the four measures, each 0-100 or null when there is nothing to judge. */
function measure(part: (typeof PARTS)[number], S: Spec, R: Spec, fs: Feat, fr: Feat, off: Float64Array, from: number, to: number) {
  const b0 = bandAt(part.lo);
  const b1 = bandAt(part.hi);
  const inWin = (t: number) => t >= from && t < to;
  const so = fs.onsets.filter(inWin);
  const ro = fr.onsets.filter(inWin);
  const hit = matched(so, fr.onsets);
  const hits = so.length + ro.length ? clamp100((200 * hit.size) / (so.length + ro.length)) : null;
  let cs = 0;
  let cn = 0;
  if (part.pitched) {
    for (let t = from; t < to; t++) {
      if (fs.e[t] < fs.peak - 35 || fr.e[t] < fr.peak - 45) continue;
      const a = fs.chroma[t];
      const b = fr.chroma[t];
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let k = 0; k < 12; k++) {
        ab += a[k] * b[k];
        aa += a[k] * a[k];
        bb += b[k] * b[k];
      }
      if (aa > 0 && bb > 0) {
        cs += ab / Math.sqrt(aa * bb);
        cn++;
      }
    }
  }
  // A cosine of 0.6 is what unrelated pitches give; 1 is the same notes.
  const pitch = part.pitched && cn >= 4 ? clamp100(((cs / cn - 0.6) / 0.4) * 100) : null;
  const corr = pearson(fs.e, fr.e, from, to, fs.peak - 50, fr.peak - 50);
  const loudness = corr === null ? null : clamp100(corr * 100);
  let d = 0;
  let dn = 0;
  for (let t = from; t < to; t++) {
    if (fs.e[t] < fs.peak - 35) continue;
    for (let b = b0; b <= b1; b++) {
      d += Math.min(25, Math.abs(S.db[t][b] - R.db[t][b] - off[b]));
      dn++;
    }
  }
  const tone = dn >= 50 ? clamp100(100 * (1 - d / dn / 12)) : null;
  return { hits, pitch, loudness, tone };
}

/** The remake's average level against the stem's, per octave, as words for the ones that matter. */
function eqNotes(S: Spec, R: Spec, fs: Feat, part: (typeof PARTS)[number]): { off: Float64Array; notes: string[] } {
  const sum = new Float64Array(N_BANDS);
  let n = 0;
  for (let t = 0; t < S.db.length; t++) {
    if (fs.e[t] < fs.peak - 35) continue;
    for (let b = 0; b < N_BANDS; b++) sum[b] += S.db[t][b] - R.db[t][b];
    n++;
  }
  const off = sum.map((v) => (n ? v / n : 0));
  const b0 = bandAt(part.lo);
  const b1 = bandAt(part.hi);
  const inRange = Array.from(off.slice(b0, b1 + 1)).sort((a, b) => a - b);
  const level = inRange.length ? inRange[inRange.length >> 1] : 0;
  const notes: string[] = [];
  for (const f of [63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
    const lo = bandAt(f / Math.SQRT2);
    const hi = bandAt(f * Math.SQRT2);
    if (f < part.lo / 1.4 || f > part.hi * 1.4) continue;
    let s = 0;
    for (let b = lo; b <= hi; b++) s += off[b];
    const d = s / (hi - lo + 1) - level;
    if (Math.abs(d) >= 4) notes.push(`${d > 0 ? 'too quiet' : 'too loud'} by ${Math.abs(Math.round(d))} dB at ${f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz'}`);
  }
  if (Math.abs(level) >= 3) notes.unshift(`${level > 0 ? 'too quiet' : 'too loud'} overall by ${Math.abs(Math.round(level))} dB`);
  return { off, notes };
}

/**
 * One part's score over some stretches of the song only: cheap enough to try several sounds. `solo`
 * holds just the part's tracks.
 */
export async function partScore(solo: Song, stem: AudioBuffer, offset: number, part: Part, spans: { from: number; to: number }[]): Promise<number> {
  const p = PARTS.find((x) => x.part === part)!;
  let sum = 0;
  for (const sp of spans) {
    // Start early enough for notes already ringing when the stretch begins.
    const pre = Math.min(4, sp.from);
    const len = sp.to - sp.from;
    const R = spectrogram(mono(await renderSong(solo, { from: sp.from - pre, to: sp.to, tail: 0, dynamics: false, sampleRate: RATE }), pre, pre + len), RATE, sp.from);
    const S = spectrogram(await resampled(stem, sp.from - offset, sp.to - offset), RATE, sp.from);
    clampFloor(R);
    clampFloor(S);
    const n = Math.min(R.db.length, S.db.length);
    R.db.length = S.db.length = n;
    const fs = features(S, p.lo, p.hi);
    const fr = features(R, p.lo, p.hi);
    sum += combine(WEIGHTS[part], measure(p, S, R, fs, fr, eqNotes(S, R, fs, p).off, 0, n)) ?? 0;
  }
  return sum / spans.length;
}

/** Compare the finished remake (`song`) with the original's separated parts. */
export async function compareRemake(
  song: Song,
  stems: Record<Part, AudioBuffer>,
  offset: number,
  roleOf: Map<string, Role>,
  onProgress?: (fraction: number) => void,
  /** Only these parts (to try an instrument without re-rendering the rest). */
  only?: Part[],
): Promise<Comparison> {
  const tl = new Timeline(song);
  const seconds = Math.min(tl.tickToSec(song.bars * BAR), stems.drums.duration + offset);
  const parts: PartScore[] = [];
  const barSecs = Array.from({ length: song.bars + 1 }, (_, i) => tl.tickToSec(i * BAR));
  for (const [pi, p] of PARTS.entries()) {
    if (only && !only.includes(p.part)) continue;
    onProgress?.(pi / PARTS.length);
    const solo = cloneSong(song);
    // (A muted track is one another has replaced, such as a VST sound standing in for a built-in one.)
    solo.tracks = solo.tracks.filter((t) => !t.mute && p.roles.includes(roleOf.get(t.id) as Role));
    if (!solo.tracks.length) continue;
    for (const t of solo.tracks) t.solo = false;
    const R = spectrogram(mono(await renderSong(solo, { from: 0, to: seconds, tail: 0, dynamics: false, sampleRate: RATE }), 0, seconds), RATE, 0);
    const S = spectrogram(await resampled(stems[p.part], -offset, seconds - offset), RATE, 0);
    clampFloor(R);
    clampFloor(S);
    const n = Math.min(R.db.length, S.db.length);
    R.db.length = S.db.length = n;
    const fs = features(S, p.lo, p.hi);
    const fr = features(R, p.lo, p.hi);
    const { off, notes } = eqNotes(S, R, fs, p);
    const dt = S.times[1] - S.times[0];
    const frameOf = (sec: number) => Math.max(0, Math.min(n, Math.round(sec / dt)));
    const whole = measure(p, S, R, fs, fr, off, 0, n);
    const w = WEIGHTS[p.part];
    const bars: { bar: number; score: number }[] = [];
    for (let b = 0; b < song.bars; b++) {
      const from = frameOf(barSecs[b]);
      const to = frameOf(barSecs[b + 1]);
      if (to - from < 8 || fs.e.slice(from, to).every((v) => v < fs.peak - 35)) continue;
      const s = combine(w, measure(p, S, R, fs, fr, off, from, to));
      if (s !== null) bars.push({ bar: b + 1, score: s });
    }
    bars.sort((a, b) => a.score - b.score);
    parts.push({
      part: p.name,
      score: Math.round(combine(w, whole) ?? 0),
      hits: Math.round(whole.hits ?? 0),
      pitch: whole.pitch === null ? null : Math.round(whole.pitch),
      loudness: Math.round(whole.loudness ?? 0),
      tone: Math.round(whole.tone ?? 0),
      eq: notes,
      worst: bars.slice(0, 3).map((x) => ({ bar: x.bar, score: Math.round(x.score) })),
    });
  }
  onProgress?.(1);
  const weight = PARTS.filter((p) => parts.some((s) => s.part === p.name)).reduce((a, p) => a + p.weight, 0);
  const overall = Math.round(PARTS.reduce((a, p) => a + p.weight * (parts.find((s) => s.part === p.name)?.score ?? 0), 0) / (weight || 1));
  return { overall, parts };
}

/** The comparison as lines of the report. */
export function describeComparison(c: Comparison, sectionAt: (bar: number) => string): string[] {
  const out = [`Match to the original (0-100): ${c.parts.map((p) => `${p.part} ${p.score}`).join(', ')}; overall ${c.overall}`];
  for (const p of c.parts) {
    const bits = [`hits ${p.hits}`, p.pitch === null ? null : `pitch ${p.pitch}`, `loudness shape ${p.loudness}`, `tone ${p.tone}`].filter(Boolean).join(', ');
    const weak = p.worst.length ? `; weakest bars ${p.worst.map((w) => `${w.bar} (${sectionAt(w.bar)}, ${w.score})`).join(', ')}` : '';
    out.push(`  ${p.part}: ${bits}${weak}${p.eq.length ? `; the remake is ${p.eq.join(', ')}` : ''}`);
  }
  return out;
}
