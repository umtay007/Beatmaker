import { fft } from './fft';

/**
 * Tempo and beat-phase estimation for a reference track, so a beat can be remade on top of it.
 *
 * 1. Mono, ~22 kHz, STFT (1024 / hop ≈ 10 ms) → log-compressed spectral flux onset envelope,
 *    plus a separate low-band (kick) flux.
 * 2. Autocorrelation of the envelope, scored with a harmonic comb and a log-Gaussian tempo prior,
 *    then a 16th-grid fit that rejects the 2/3 and 3/2 "triplet" tempos trap hats often suggest.
 * 3. Beat phase from kick/snare-weighted onsets, preferring the grid with fewer hi-hats on it, so
 *    it lands on the beat rather than on off-beat hats or pumping bass, refined to ~1 ms from the
 *    raw audio. The downbeat is assumed to be the first beat; the UI offers one-click shifts for
 *    pickups.
 */
export interface TempoResult {
  bpm: number;
  /** Seconds into the audio of the first detected beat. */
  firstBeat: number;
  confidence: number;
}

interface Envelopes {
  full: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  fps: number;
  bias: number;
  mono: Float32Array;
  sr: number;
}

function onsetEnvelopes(buf: AudioBuffer, maxSeconds: number): Envelopes {
  const c0 = buf.getChannelData(0);
  const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const dec = buf.sampleRate > 30000 ? 2 : 1;
  const sr = buf.sampleRate / dec;
  const len = Math.min(Math.floor(c0.length / dec), Math.floor(maxSeconds * sr));
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let d = 0; d < dec; d++) s += c0[i * dec + d] + c1[i * dec + d];
    mono[i] = s / (2 * dec);
  }
  const N = 1024;
  const hop = Math.round(sr / 100);
  const fps = sr / hop;
  const frames = Math.max(0, Math.floor((len - N) / hop));
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const maxBin = Math.min(N / 2, Math.floor(9000 / binHz));
  const lowBin = Math.max(2, Math.floor(160 / binHz));
  const midLo = Math.floor(300 / binHz);
  const midHi = Math.floor(4000 / binHz);
  const highLo = Math.floor(6000 / binHz);
  let prev = new Float64Array(maxBin);
  let cur = new Float64Array(maxBin);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = mono[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let fl = 0;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let k = 1; k < maxBin; k++) {
      const m = Math.log1p(200 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) {
        fl += d;
        if (k <= lowBin) lo += d;
        else if (k >= midLo && k <= midHi) mi += d;
        else if (k >= highLo) hi += d;
      }
    }
    full[f] = fl;
    low[f] = lo;
    mid[f] = mi;
    high[f] = hi;
    [prev, cur] = [cur, prev];
  }
  const clean = (e: Float32Array) => {
    const w = Math.round(fps * 0.4);
    const out = new Float32Array(e.length);
    let acc = 0;
    for (let i = 0; i < e.length; i++) {
      acc += e[i];
      if (i >= w) acc -= e[i - w];
      out[i] = Math.max(0, e[i] - acc / Math.min(i + 1, w));
    }
    let max = 0;
    for (const v of out) max = Math.max(max, v);
    if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
  };
  // Frames are stamped at the window start; an onset registers around the window centre.
  return { full: clean(full), low: clean(low), mid: clean(mid), high: clean(high), fps, bias: N / 2 / sr, mono, sr };
}

/**
 * The flux frames are 10 ms apart and smeared by a 46 ms window, which leaves the grid a few
 * milliseconds off. Refine it: average a 1 ms energy-rise curve of the bright (differentiated)
 * signal around every predicted beat and move the grid to where hits actually start.
 */
function refinePhase(mono: Float32Array, sr: number, first: number, bpm: number): number {
  const beat = 60 / bpm;
  const ms = sr / 1000;
  const span = 30;
  const acc = new Float64Array(2 * span);
  for (let t = first; (t + 0.05) * sr < mono.length; t += beat) {
    const e = new Float64Array(2 * span + 1);
    for (let j = 0; j <= 2 * span; j++) {
      const a = Math.floor((t + (j - span) / 1000) * sr);
      let s = 0;
      for (let i = Math.max(1, a); i < a + ms && i < mono.length; i++) s += (mono[i] - mono[i - 1]) ** 2;
      e[j] = Math.log(s + 1e-9);
    }
    for (let j = 0; j < 2 * span; j++) acc[j] += Math.max(0, e[j + 1] - e[j]);
  }
  let best = span;
  for (let j = 0; j < 2 * span; j++) if (acc[j] > acc[best]) best = j;
  // acc[j] is the rise between ms j and j+1: the onset starts at the end of that millisecond.
  const shift = (best + 1 - span) / 1000;
  return Math.abs(shift) < 0.025 ? first + shift : first;
}

export function detectTempo(buf: AudioBuffer, maxSeconds = 60): TempoResult {
  const { full, low, mid, high, fps, bias, mono, sr } = onsetEnvelopes(buf, maxSeconds);
  const n = full.length;
  if (n < fps * 4) return { bpm: 120, firstBeat: 0, confidence: 0 };

  // Autocorrelation up to 4 beats at 50 BPM.
  const maxLag = Math.min(n - 1, Math.ceil((fps * 60 * 4) / 50));
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += full[i] * full[i + lag];
    acf[lag] = s / (n - lag);
  }
  const acfAt = (x: number) => {
    const i = Math.floor(x);
    if (i + 1 > maxLag) return 0;
    const t = x - i;
    return acf[i] * (1 - t) + acf[i + 1] * t;
  };

  const minLag = (fps * 60) / 200;
  const maxBeatLag = (fps * 60) / 60;
  let best = { lag: fps / 2, s: -Infinity };
  let sum = 0;
  let cnt = 0;
  for (let lag = minLag; lag <= maxBeatLag; lag += 0.25) {
    // Harmonic comb: the beat period should also explain 2 and 4 beats (bar structure).
    const comb = acfAt(lag) + 0.5 * acfAt(lag * 2) + 0.35 * acfAt(lag * 4) + 0.25 * acfAt(lag / 2);
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.75, 2));
    const s = comb * prior;
    sum += s;
    cnt++;
    if (s > best.s) best = { lag, s };
  }
  // Parabolic refinement.
  const l0 = best.lag;
  const y0 = acfAt(l0 - 0.25);
  const y1 = acfAt(l0);
  const y2 = acfAt(l0 + 0.25);
  const denom = y0 - 2 * y1 + y2;
  const lag = denom < 0 ? l0 + Math.max(-0.25, Math.min(0.25, (0.25 * 0.5 * (y0 - y2)) / denom)) : l0;
  let bpm = Math.max(50, Math.min(220, (fps * 60) / lag));

  // Triplet confusion: hi-hat rolls and dotted 808 patterns make 2/3 (or 3/2) of the tempo look
  // periodic too. The true tempo puts the onsets on its own 16th grid, so compare how much onset
  // energy each candidate's 16th grid catches per grid point (±1 frame for swing and timing).
  const gridFit = (b: number) => {
    const sf = (fps * 60) / b / 4;
    let bestFit = 0;
    for (let p = 0; p < sf; p += 0.5) {
      let s = 0;
      let c = 0;
      for (let x = p; x < n - 2; x += sf) {
        const i = Math.max(1, Math.round(x));
        s += Math.max(full[i - 1], full[i], full[i + 1]);
        c++;
      }
      if (c) bestFit = Math.max(bestFit, s / c);
    }
    return bestFit;
  };
  const base = gridFit(bpm);
  let bestAlt = { bpm, fit: base * 1.15 };
  for (const r of [2 / 3, 3 / 2]) {
    const alt = bpm * r;
    if (alt < 60 || alt > 200) continue;
    const f = gridFit(alt);
    if (f > bestAlt.fit) bestAlt = { bpm: alt, fit: f };
  }
  bpm = bestAlt.bpm;

  // Phase-coherent refinement over the whole excerpt: the right tempo keeps onsets on the grid
  // for every beat, so small tempo errors are heavily penalised.
  const combAt = (e: Float32Array, beatFrames: number, phase: number) => {
    let s = 0;
    if (!(beatFrames > 1) || !Number.isFinite(phase)) return 0;
    for (let x = phase; x < n - 1; x += beatFrames) {
      const i = Math.floor(x);
      const t = x - i;
      s += e[i] * (1 - t) + e[i + 1] * t;
    }
    return s;
  };
  const bestPhaseFor = (e: Float32Array, beatFrames: number, step: number) => {
    let bp = 0;
    let bs = -Infinity;
    for (let p = 0; p < beatFrames && beatFrames < 1e4; p += step) {
      const sc = combAt(e, beatFrames, p);
      if (sc > bs) {
        bs = sc;
        bp = p;
      }
    }
    return { phase: bp, score: bs };
  };
  {
    let bestB = bpm;
    let bestS = -Infinity;
    for (let b = bpm - 1.5; b <= bpm + 1.5; b += 0.02) {
      const bf = (fps * 60) / b;
      // Score beats plus their 8th-note subdivisions (hats) for a sharper peak.
      const r = bestPhaseFor(full, bf, 1);
      const sc = r.score + 0.5 * combAt(full, bf, r.phase + bf / 2);
      if (sc > bestS) {
        bestS = sc;
        bestB = b;
      }
    }
    bpm = bestB;
  }
  // Snap to a nearby integer tempo when it is within 0.25 BPM (most produced music is on-grid).
  bpm = Math.abs(bpm - Math.round(bpm)) < 0.25 ? Math.round(bpm) : Math.round(bpm * 10) / 10;

  // Beat phase: kicks and snares/claps land on beats, hats and pumping bass tend to sit between.
  const beatFrames = (fps * 60) / bpm;
  const beatEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) beatEnv[i] = low[i] * (0.3 + mid[i]) + 0.8 * mid[i] * mid[i];
  let { phase: bestPhase } = bestPhaseFor(beatEnv, beatFrames, 0.25);
  // Resolve the half-beat ambiguity: prefer the grid with fewer hi-hat onsets on it.
  const alt = (bestPhase + beatFrames / 2) % beatFrames;
  const onScore = (p: number) => combAt(beatEnv, beatFrames, p) - 0.35 * combAt(high, beatFrames, p) + 0.35 * combAt(high, beatFrames, p + beatFrames / 2);
  if (onScore(alt) > onScore(bestPhase)) bestPhase = alt;
  const mean = sum / Math.max(1, cnt);
  const firstBeat = refinePhase(mono, sr, bestPhase / fps + bias, bpm);
  return { bpm, firstBeat, confidence: Math.max(0, Math.min(1, 1 - mean / (best.s + 1e-12))) };
}

/** Peak envelope at `rate` values per second, for drawing waveforms. */
export function peakEnvelope(buf: AudioBuffer, rate = 200): Float32Array {
  const c0 = buf.getChannelData(0);
  const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const step = Math.max(1, Math.floor(buf.sampleRate / rate));
  const out = new Float32Array(Math.ceil(c0.length / step));
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    let p = 0;
    const end = Math.min(c0.length, (i + 1) * step);
    for (let j = i * step; j < end; j += 4) {
      const v = Math.abs(c0[j]) + Math.abs(c1[j]);
      if (v > p) p = v;
    }
    out[i] = p;
    if (p > max) max = p;
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}
