import { fft } from './fft';

/**
 * "What did the mix engineer do?" Measures the traces that EQ, compression, reverb, delay,
 * saturation, stereo wideners and sidechain leave in a finished recording. It can't name the
 * plugins, but it can say what they did, and the remake can then be matched to it.
 */

/** Centre frequencies of the master graphic EQ (octave bands). */
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export interface SoundReport {
  /** Level per EQ band in dB, relative to the mean of the 63 Hz–8 kHz bands. */
  bands: number[];
  loudness: { rmsDb: number; peakDb: number; crestDb: number; clippedPct: number; rangeDb: number };
  /** Side/mid energy ratio in dB (−∞ = mono, 0 = as much side as mid). */
  width: { all: number; low: number; mid: number; high: number };
  /** Estimated reverb decay (RT60) in seconds from tails after stops, or null. */
  reverb: number | null;
  /** A delay effect at a musical division, or null. */
  echo: { beats: number; label: string; strength: number } | null;
  /** Harmonic levels of the bass (2nd, 3rd, 4th, 5th) relative to its fundamental, in dB. */
  bassHarmonics: number[] | null;
  /** Depth of beat-synced ducking in dB (sidechain compression), or null. */
  pump: number | null;
  notes: string[];
}

interface Mono {
  l: Float32Array;
  r: Float32Array;
  sr: number;
}

/** Stereo at the buffer's rate (or decimated to ~22 kHz), limited to a window of the buffer. */
function prepare(buf: AudioBuffer, from = 0, seconds = 90, decimate = false): Mono {
  const dec = decimate && buf.sampleRate > 30000 ? 2 : 1;
  const sr = buf.sampleRate / dec;
  const c0 = buf.getChannelData(0);
  const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const start = Math.max(0, Math.floor(from * buf.sampleRate));
  const len = Math.max(0, Math.min(Math.floor((c0.length - start) / dec), Math.floor(seconds * sr)));
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let a = 0;
    let b = 0;
    for (let d = 0; d < dec; d++) {
      a += c0[start + i * dec + d];
      b += c1[start + i * dec + d];
    }
    l[i] = a / dec;
    r[i] = b / dec;
  }
  return { l, r, sr };
}

const N = 8192;
const HOP = 4096;
const win = (() => {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  return w;
})();

/** Average power spectra of mid and side. */
function spectra(m: Mono): { mid: Float64Array; side: Float64Array; frames: number } {
  const mid = new Float64Array(N / 2);
  const side = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const re2 = new Float64Array(N);
  const im2 = new Float64Array(N);
  let frames = 0;
  for (let o = 0; o + N <= m.l.length; o += HOP) {
    for (let i = 0; i < N; i++) {
      re[i] = ((m.l[o + i] + m.r[o + i]) / 2) * win[i];
      re2[i] = ((m.l[o + i] - m.r[o + i]) / 2) * win[i];
      im[i] = 0;
      im2[i] = 0;
    }
    fft(re, im);
    fft(re2, im2);
    for (let k = 0; k < N / 2; k++) {
      mid[k] += re[k] * re[k] + im[k] * im[k];
      side[k] += re2[k] * re2[k] + im2[k] * im2[k];
    }
    frames++;
  }
  return { mid, side, frames };
}

function bandPower(spec: Float64Array, sr: number, lo: number, hi: number): number {
  const bin = sr / N;
  let s = 0;
  for (let k = Math.max(1, Math.floor(lo / bin)); k <= Math.min(N / 2 - 1, Math.ceil(hi / bin)); k++) s += spec[k];
  return s;
}

/** Octave-band levels (dB, normalised to the 63 Hz–8 kHz mean), stereo width and RMS in one pass. */
export function mixStats(buf: AudioBuffer, from = 0, seconds = 30): { bands: number[]; width: number; rms: number } {
  const m = prepare(buf, from, seconds);
  const { mid, side } = spectra(m);
  const both = mid.map((v, k) => v + side[k]);
  const bands = normBands(EQ_BANDS.map((f) => 10 * Math.log10(bandPower(both, m.sr, f / Math.SQRT2, Math.min(m.sr / 2, f * Math.SQRT2)) + 1e-12)));
  const width = 10 * Math.log10(bandPower(side, m.sr, 20, m.sr / 2) / (bandPower(mid, m.sr, 20, m.sr / 2) + 1e-12) + 1e-12);
  let s = 0;
  for (let i = 0; i < m.l.length; i++) s += (m.l[i] * m.l[i] + m.r[i] * m.r[i]) / 2;
  return { bands, width, rms: 10 * Math.log10(s / Math.max(1, m.l.length) + 1e-12) };
}

function normBands(db: number[]): number[] {
  const core = db.slice(1, 9);
  const mean = core.reduce((a, b) => a + b, 0) / core.length;
  return db.map((d) => d - mean);
}

/** EQ gains (dB) that move `mine` towards `target`, damped and limited to ±9 dB. */
export function matchGains(target: number[], mine: number[]): number[] {
  return target.map((t, i) => {
    const g = (t - mine[i]) * 0.85;
    // The very top and bottom bands are often empty in a remake: don't boost noise there.
    const limit = i === 0 || i === 9 ? 6 : 9;
    return Math.round(Math.max(-limit, Math.min(limit, g)) * 2) / 2;
  });
}


// ---------------------------------------------------------------------------------------------

/** Energy envelope in dB, one value per `ms` milliseconds, optionally high-passed. */
function envelope(x: Float32Array, sr: number, ms: number, highpass = false): Float32Array {
  const hop = Math.max(1, Math.round((sr * ms) / 1000));
  const out = new Float32Array(Math.floor(x.length / hop));
  let prev = 0;
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = highpass ? x[i] - prev : x[i];
      prev = x[i];
      s += v * v;
    }
    out[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  return out;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Reverb: after moments where the music stops, how fast does the remaining sound fade? */
function reverbTime(mono: Float32Array, sr: number): number | null {
  const env = envelope(mono, sr, 10);
  const est: number[] = [];
  for (let i = 30; i < env.length - 60; i++) {
    const before = Math.max(...Array.from(env.subarray(i - 30, i)));
    // A stop: at least 18 dB below the preceding 300 ms within 100 ms, and staying down.
    if (env[i] > before - 18 || env[i + 10] > before - 18 || before < -45) continue;
    // Fit the decay of the tail between -20 and -45 dB below the pre-stop level.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = i; j < Math.min(env.length, i + 250); j++) {
      const rel = env[j] - before;
      if (rel < -45) break;
      if (rel <= -20) {
        xs.push((j - i) * 0.01);
        ys.push(env[j]);
      }
    }
    if (xs.length >= 6) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let den = 0;
      for (let k = 0; k < xs.length; k++) {
        num += (xs[k] - mx) * (ys[k] - my);
        den += (xs[k] - mx) ** 2;
      }
      const slope = num / (den || 1); // dB per second
      // Only trust clean, straight-line (exponential) decays: a held note or a new hit isn't reverb.
      let ssTot = 0;
      let ssRes = 0;
      for (let k = 0; k < xs.length; k++) {
        ssTot += (ys[k] - my) ** 2;
        ssRes += (ys[k] - (my + slope * (xs[k] - mx))) ** 2;
      }
      const r2 = 1 - ssRes / (ssTot || 1);
      if (slope < -8 && r2 > 0.85) est.push(Math.min(6, -60 / slope));
    }
    i += 60;
  }
  return est.length ? median(est) : null;
}

/** Delay times producers favour, in 16th notes, with the lags a plain rhythm would also light up. */
const DIVISIONS: { sixteenths: number; label: string; refs: number[] }[] = [
  { sixteenths: 4 / 3, label: '1/8 triplet', refs: [1, 2] },
  { sixteenths: 8 / 3, label: '1/4 triplet', refs: [2, 3] },
  { sixteenths: 3, label: 'dotted 1/8', refs: [2, 4, 5] },
  { sixteenths: 6, label: 'dotted 1/4', refs: [5, 7, 4] },
];

/**
 * Echo: a delay repeats every hit after a fixed musical time. Straight 8ths and quarters are hidden
 * by the rhythm itself, so test the dotted and triplet delays producers favour: with an echo, the
 * onset envelope correlates with itself at that lag clearly more than at the nearby 16th-note lags
 * that any rhythm on the grid lights up too.
 */
function echoDivision(mono: Float32Array, sr: number, bpm: number): SoundReport['echo'] {
  const env = envelope(mono, sr, 5, true);
  const d = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) d[i] = Math.max(0, env[i] - env[i - 1]);
  let mean = 0;
  for (const v of d) mean += v;
  mean /= d.length || 1;
  for (let i = 0; i < d.length; i++) d[i] -= mean;
  const acf = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag];
    return s / Math.max(1, d.length - lag);
  };
  const sixteenth = 15 / bpm / 0.005; // in envelope frames
  const peakAt = (lag: number) => Math.max(acf(lag - 1), acf(lag), acf(lag + 1));
  let best: SoundReport['echo'] = null;
  for (const div of DIVISIONS) {
    const lag = Math.round(div.sixteenths * sixteenth);
    if (lag < 20 || lag * 3 > d.length) continue;
    const base = Math.max(...div.refs.map((s) => peakAt(Math.round(s * sixteenth))), 1e-9);
    const strength = peakAt(lag) / base;
    if (strength > 1.35 && (!best || strength > best.strength)) best = { beats: div.sixteenths / 4, label: div.label, strength: Math.round(strength * 100) / 100 };
  }
  return best;
}

/** Bass saturation: harmonic levels of the low end where the bass dominates. */
function bassHarmonics(m: Mono): number[] | null {
  const len = 16384;
  const re = new Float64Array(len);
  const im = new Float64Array(len);
  const acc = new Float64Array(len / 2);
  let used = 0;
  const w = new Float64Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
  for (let o = 0; o + len <= m.l.length && used < 40; o += len / 2) {
    for (let i = 0; i < len; i++) {
      re[i] = ((m.l[o + i] + m.r[o + i]) / 2) * w[i];
      im[i] = 0;
    }
    fft(re, im);
    let low = 0;
    let all = 0;
    const bin = m.sr / len;
    for (let k = 1; k < len / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      all += p;
      if (k * bin < 120) low += p;
    }
    if (low / all < 0.5) continue; // bass doesn't dominate this frame
    for (let k = 0; k < len / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  if (used < 3) return null;
  const bin = m.sr / len;
  let f0k = Math.round(28 / bin);
  for (let k = Math.round(28 / bin); k <= Math.round(110 / bin); k++) if (acc[k] > acc[f0k]) f0k = k;
  const peakNear = (k: number) => {
    let p = 0;
    for (let j = Math.floor(k * 0.94); j <= Math.ceil(k * 1.06); j++) p = Math.max(p, acc[j]);
    return p;
  };
  const f0 = peakNear(f0k);
  return [2, 3, 4, 5].map((h) => Math.round(10 * Math.log10(peakNear(f0k * h) / (f0 + 1e-12) + 1e-12)));
}

/** Sidechain pumping: sustained mid content ducking right after each beat and swelling back. */
function pumping(m: Mono, bpm: number, firstBeat: number): number | null {
  // Band-pass the mids (RBJ biquad around 800 Hz, about 250 Hz – 2.5 kHz).
  const w0 = (2 * Math.PI * 800) / m.sr;
  const alpha = Math.sin(w0) / (2 * 0.5);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const mids = new Float32Array(m.l.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < mids.length; i++) {
    const x = (m.l[i] + m.r[i]) / 2;
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    mids[i] = y;
  }
  const env = envelope(mids, m.sr, 10);
  const beat = 60 / bpm;
  const bins = 12;
  const sum = new Float64Array(bins);
  const cnt = new Float64Array(bins);
  for (let i = 0; i < env.length; i++) {
    const t = i * 0.01 - firstBeat;
    if (t < 0) continue;
    const ph = (t / beat) % 1;
    const k = Math.min(bins - 1, Math.floor(ph * bins));
    sum[k] += env[i];
    cnt[k] += 1;
  }
  const prof = Array.from(sum, (s, k) => s / Math.max(1, cnt[k]));
  const minK = prof.indexOf(Math.min(...prof));
  const depth = Math.max(...prof) - prof[minK];
  // Pumping: the dip sits in the first quarter of the beat and the level recovers towards the end.
  const recovers = prof[bins - 1] > prof[minK] + depth * 0.6 && prof[Math.min(bins - 1, minK + 4)] > prof[minK];
  return minK <= bins / 4 && recovers && depth > 3 ? Math.round(depth * 10) / 10 : null;
}

export function analyzeSound(buf: AudioBuffer, bpm: number, firstBeat: number): SoundReport {
  const m = prepare(buf, 0, 90);
  const mono = new Float32Array(m.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (m.l[i] + m.r[i]) / 2;
  const { mid, side } = spectra(m);
  const both = mid.map((v, k) => v + side[k]);
  const bands = normBands(EQ_BANDS.map((f) => 10 * Math.log10(bandPower(both, m.sr, f / Math.SQRT2, Math.min(m.sr / 2, f * Math.SQRT2)) + 1e-12)));
  const w = (lo: number, hi: number) => 10 * Math.log10(bandPower(side, m.sr, lo, hi) / (bandPower(mid, m.sr, lo, hi) + 1e-12) + 1e-12);
  const width = { all: w(20, m.sr / 2), low: w(20, 150), mid: w(150, 2500), high: w(2500, m.sr / 2) };

  // Loudness and dynamics from the full-rate data.
  let peak = 0;
  let sq = 0;
  let clipped = 0;
  const c0 = buf.getChannelData(0);
  for (let i = 0; i < c0.length; i++) {
    const v = Math.abs(c0[i]);
    if (v > peak) peak = v;
    if (v > 0.999) clipped++;
    sq += v * v;
  }
  const rms = Math.sqrt(sq / Math.max(1, c0.length));
  const env3 = envelope(mono, m.sr, 3000).filter((v) => v > -60);
  const sorted = [...env3].sort((a, b) => a - b);
  const range = sorted.length > 3 ? sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.1)] : 0;
  const loudness = {
    rmsDb: Math.round(20 * Math.log10(rms + 1e-12) * 10) / 10,
    peakDb: Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10,
    crestDb: Math.round(20 * Math.log10(peak / (rms + 1e-12)) * 10) / 10,
    clippedPct: Math.round((clipped / Math.max(1, c0.length)) * 1e5) / 1e3,
    rangeDb: Math.round(range * 10) / 10,
  };

  // Stops (breaks, the ending) show the reverb best, so search the whole song for them.
  const whole = prepare(buf, 0, buf.duration, true);
  const wholeMono = new Float32Array(whole.l.length);
  for (let i = 0; i < wholeMono.length; i++) wholeMono[i] = (whole.l[i] + whole.r[i]) / 2;
  const reverb = reverbTime(wholeMono, whole.sr);
  const echo = bpm > 0 ? echoDivision(mono, m.sr, bpm) : null;
  const harm = bassHarmonics(m);
  const pump = bpm > 0 ? pumping(m, bpm, firstBeat) : null;

  // Plain-language findings.
  const notes: string[] = [];
  const lowEnd = (bands[0] + bands[1] + bands[2]) / 3;
  const top = (bands[7] + bands[8] + bands[9]) / 3;
  if (lowEnd > 4) notes.push(`Heavy low end: the bass region sits ${lowEnd.toFixed(0)} dB above the mids (typical of 808-driven mixes).`);
  else if (lowEnd < -4) notes.push('Light low end: little energy below 125 Hz.');
  if (top > 0) notes.push('Bright, airy top end (a high-shelf boost or bright sources).');
  else if (top < -12) notes.push('Dark top end: the highs roll off steeply (low-pass filtering or dark sources).');
  if (loudness.crestDb < 10) notes.push(`Heavily compressed and limited master (only ${loudness.crestDb} dB between peaks and average).`);
  else if (loudness.crestDb > 16) notes.push(`Dynamic master with light compression (${loudness.crestDb} dB crest factor).`);
  if (loudness.clippedPct > 0.01) notes.push(`The master clips in places (${loudness.clippedPct}% of samples at full scale).`);
  if (width.low < -25 && width.mid > -12) notes.push('Mono bass with wide mids: a typical stereo-imaging setup.');
  if (width.all > -3) notes.push('Very wide stereo image (stereo wideners, doubled or chorused parts).');
  else if (width.all < -20) notes.push('Almost mono mix.');
  if (reverb !== null) notes.push(reverb > 1.6 ? `Long reverb tails (about ${reverb.toFixed(1)} s).` : `Short, tight reverb (about ${reverb.toFixed(1)} s decay).`);
  if (echo) notes.push(`An echo/delay locked to the tempo at ${echo.label}.`);
  if (harm) {
    const odd = Math.max(harm[1], harm[3]);
    if (odd > -18) notes.push(`Saturated bass: strong odd harmonics (3rd at ${harm[1]} dB), like a distorted or clipped 808.`);
    else if (odd < -30) notes.push('Clean, sine-like bass.');
  }
  if (pump !== null) notes.push(`Sidechain pumping: the mids duck about ${pump} dB on every beat.`);
  return { bands, loudness, width, reverb, echo, bassHarmonics: harm, pump, notes };
}
