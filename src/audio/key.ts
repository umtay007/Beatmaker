import { estimateKey } from '../core/theory';
import { fft } from './fft';

/**
 * Estimate the key of a recording: STFT (~2.7 Hz bins) → peak-picked chroma between 50 Hz and
 * 2 kHz → Krumhansl–Kessler key profiles. The same spectral peaks give the tuning: the circular
 * mean of how far each peak sits from equal temperament (A = 440 Hz), in cents.
 */
export function detectAudioKey(
  buf: AudioBuffer,
  maxSeconds = 120,
): { key: number; scale: 'major' | 'minor'; confidence: number; tuning: number } {
  const c0 = buf.getChannelData(0);
  const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const dec = Math.max(1, Math.round(buf.sampleRate / 11025));
  const sr = buf.sampleRate / dec;
  const len = Math.min(Math.floor(c0.length / dec), Math.floor(maxSeconds * sr));
  const N = 4096;
  const hop = 2048;
  const chroma = new Array(12).fill(0);
  let tc = 0;
  let ts = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const k0 = Math.ceil(50 / binHz);
  const k1 = Math.min(N / 2 - 2, Math.floor(2000 / binHz));
  for (let o = 0; o + N <= len; o += hop) {
    for (let i = 0; i < N; i++) {
      let s = 0;
      const j = (o + i) * dec;
      for (let d = 0; d < dec; d++) s += c0[j + d] + c1[j + d];
      re[i] = (s / (2 * dec)) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = k0 - 1; k <= k1 + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    let top = 0;
    for (let k = k0; k <= k1; k++) top = Math.max(top, mag[k]);
    for (let k = k0; k <= k1; k++) {
      const m = mag[k];
      if (m <= mag[k - 1] || m < mag[k + 1]) continue; // spectral peaks only
      // Parabolic peak interpolation for a better frequency estimate.
      const a = mag[k - 1];
      const b = mag[k + 1];
      const den = a - 2 * m + b;
      const delta = den < 0 ? (0.5 * (a - b)) / den : 0;
      const f = (k + delta) * binHz;
      const pitch = 69 + 12 * Math.log2(f / 440);
      const nearest = Math.round(pitch);
      const dev = Math.abs(pitch - nearest);
      if (dev > 0.35) continue;
      // Low notes (808s, bass) are strong evidence for the tonic; keep them, but tame their level.
      const w = Math.sqrt(m) * (1 - dev * 2) * (f < 120 ? 0.7 : 1);
      chroma[((nearest % 12) + 12) % 12] += w;
      if (f > 150 && m > top * 0.03) {
        // Tuning: re-interpolate on log magnitude (much less biased for a Hann window).
        const la = Math.log(a + 1e-12);
        const lm = Math.log(m + 1e-12);
        const lb = Math.log(b + 1e-12);
        const d2 = la - 2 * lm + lb;
        const fl = (k + (d2 < 0 ? (0.5 * (la - lb)) / d2 : 0)) * binHz;
        const cents = 1200 * Math.log2(fl / 440);
        const ang = (2 * Math.PI * cents) / 100;
        tc += m * Math.cos(ang);
        ts += m * Math.sin(ang);
      }
    }
  }
  if (chroma.every((v) => v === 0)) return { key: 0, scale: 'minor', confidence: 0, tuning: 0 };
  const r = estimateKey(chroma);
  const tuning = (Math.atan2(ts, tc) / (2 * Math.PI)) * 100;
  return { key: r.key, scale: r.scale, confidence: Math.max(0, Math.min(1, r.margin * 5)), tuning };
}
