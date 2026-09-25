/**
 * Fit a track's EQ and level to the part it remakes: compare third-octave spectra of the track
 * alone and of the original part (a separated stem), then pick the track EQ (low shelf 150 Hz, bell,
 * high shelf 6 kHz) and volume change that close the gap, preferring small moves.
 *
 * The filter responses are the RBJ biquads that Web Audio's BiquadFilterNode implements, so the fit
 * is what the track will actually do.
 */
import { fft } from './fft';

const EDGES = (() => {
  const e: number[] = [];
  for (let f = 40; f < 16500; f *= Math.pow(2, 1 / 3)) e.push(f);
  return e;
})();
export const TONE_BANDS = EDGES.slice(0, -1).map((f, i) => Math.sqrt(f * EDGES[i + 1]));

/** Long-term average spectrum in third-octave bands (dB), over [from, to] seconds of `buf`. */
export function ltas(buf: AudioBuffer, from: number, to: number): number[] {
  const sr = buf.sampleRate;
  const N = 8192;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const acc = new Float64Array(N / 2 + 1);
  const d0 = buf.getChannelData(0);
  const d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0;
  let frames = 0;
  for (let s = Math.max(0, Math.floor(from * sr)); s + N <= Math.min(buf.length, to * sr); s += N / 2) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = ((d0[s + i] + d1[s + i]) / 2) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return TONE_BANDS.map((_, b) => {
    const lo = Math.floor((EDGES[b] * N) / sr);
    const hi = Math.max(lo + 1, Math.floor((EDGES[b + 1] * N) / sr));
    let p = 0;
    for (let k = lo; k < hi && k < acc.length; k++) p += acc[k];
    return 10 * Math.log10(p / Math.max(1, frames) + 1e-12);
  });
}

type Kind = 'lowshelf' | 'highshelf' | 'peaking';

function responseDb(kind: Kind, f0: number, gain: number, q: number, f: number, sr = 44100): number {
  if (!gain) return 0;
  const w0 = (2 * Math.PI * f0) / sr;
  const A = Math.pow(10, gain / 40);
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === 'peaking') {
    const alpha = sw / (2 * q);
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
  } else {
    const s2 = 2 * Math.sqrt(A) * (sw / 2) * Math.SQRT2;
    if (kind === 'lowshelf') {
      [b0, b1, b2] = [A * (A + 1 - (A - 1) * cw + s2), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s2)];
      [a0, a1, a2] = [A + 1 + (A - 1) * cw + s2, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s2];
    } else {
      [b0, b1, b2] = [A * (A + 1 + (A - 1) * cw + s2), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s2)];
      [a0, a1, a2] = [A + 1 - (A - 1) * cw + s2, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s2];
    }
  }
  const w = (2 * Math.PI * f) / sr;
  const zr = Math.cos(w);
  const zi = -Math.sin(w);
  const z2r = Math.cos(2 * w);
  const z2i = -Math.sin(2 * w);
  const nr = b0 + b1 * zr + b2 * z2r;
  const ni = b1 * zi + b2 * z2i;
  const dr = a0 + a1 * zr + a2 * z2r;
  const di = a1 * zi + a2 * z2i;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export interface ToneFit {
  eqLow: number;
  eqMid: number;
  eqMidFreq: number;
  eqHigh: number;
  /** Volume change in dB. */
  volumeDb: number;
  /** Remaining spectral difference (dB rms) before and after. */
  before: number;
  after: number;
}

/**
 * The EQ and level that bring `mine` (the track alone) closest to `target` (the original part),
 * over bands between lo and hi Hz where the target has something.
 */
export function fitTone(target: number[], mine: number[], lo = 60, hi = 12000): ToneFit {
  const peak = Math.max(...target);
  const use = TONE_BANDS.map((f, i) => f >= lo && f <= hi && target[i] > peak - 45 && mine[i] > -150);
  const gap = target.map((t, i) => t - mine[i]);
  const eqAt = (p: { eqLow: number; eqMid: number; eqMidFreq: number; eqHigh: number }, f: number) =>
    responseDb('lowshelf', 150, p.eqLow, 0, f) + responseDb('peaking', p.eqMidFreq, p.eqMid, 0.9, f) + responseDb('highshelf', 6000, p.eqHigh, 0, f);
  const cost = (p: { eqLow: number; eqMid: number; eqMidFreq: number; eqHigh: number }) => {
    const res: number[] = [];
    TONE_BANDS.forEach((f, i) => use[i] && res.push(gap[i] - eqAt(p, f)));
    const off = res.reduce((a, b) => a + b, 0) / Math.max(1, res.length);
    const rms = Math.sqrt(res.reduce((a, r) => a + (r - off) ** 2, 0) / Math.max(1, res.length));
    // Every dB of EQ has to earn its keep.
    return { score: rms + 0.06 * (Math.abs(p.eqLow) + Math.abs(p.eqMid) + Math.abs(p.eqHigh)), off, rms };
  };
  let p = { eqLow: 0, eqMid: 0, eqMidFreq: 1000, eqHigh: 0 };
  const before = cost(p).rms;
  const gains = Array.from({ length: 25 }, (_, i) => -6 + i * 0.5);
  const mids = Array.from({ length: 31 }, (_, i) => Math.round(150 * Math.pow(2, i / 6)));
  for (let it = 0; it < 3; it++) {
    for (const [k, grid] of [['eqLow', gains], ['eqHigh', gains], ['eqMidFreq', mids], ['eqMid', gains]] as const) {
      let best = p;
      let bestScore = cost(p).score;
      for (const v of grid) {
        const cand = { ...p, [k]: v };
        const sc = cost(cand).score;
        if (sc < bestScore) {
          bestScore = sc;
          best = cand;
        }
      }
      p = best;
    }
  }
  const c = cost(p);
  return { ...p, volumeDb: c.off, before, after: c.rms };
}
