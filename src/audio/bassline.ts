/**
 * Transcribe a bass line (an 808 above all) from a bass stem or a mix, on the song's 16th grid.
 *
 * Note models hear sub-bass poorly: an 808 sits at 30-60 Hz and is mostly a sine. So: low-pass the
 * audio, find where its level jumps at a 16th step (an onset), take the pitch by autocorrelation a
 * little after the attack (past the click), and let the note run until it falls 15 dB or the next
 * onset (the pitch is read after the attack's downward glide). A kick's thump in a mix decays within a step or two and has no steady pitch, so short or
 * pitchless hits are left out.
 */
import { newNoteId, STEP, type Note } from '../core/types';

async function lowpassed(buf: AudioBuffer, cutoff: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, buf.length, buf.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;
  for (let i = 0; i < 3; i++) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.7;
    node.connect(lp);
    node = lp;
  }
  node.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

function rms(x: Float32Array, sr: number, a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(x.length, Math.floor(b * sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
}

/** Fundamental (Hz) of a stretch by autocorrelation between 25 and 250 Hz, or null if it isn't periodic. */
function pitchOf(x: Float32Array, sr: number, a: number, b: number): number | null {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(x.length, Math.floor(b * sr));
  const n = i1 - i0;
  const minLag = Math.floor(sr / 250);
  const maxLag = Math.min(Math.floor(sr / 25), n >> 1);
  if (maxLag <= minLag + 2) return null;
  let e = 0;
  for (let i = i0; i < i1; i++) e += x[i] * x[i];
  if (e <= 0) return null;
  let best = -1;
  let bestLag = 0;
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = i0; i + lag < i1; i++) s += x[i] * x[i + lag];
    corr[lag] = s / e;
  }
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] > corr[lag - 1] && corr[lag] >= corr[lag + 1] && corr[lag] > best) {
      best = corr[lag];
      bestLag = lag;
    }
  }
  if (best < 0.5 || !bestLag) return null;
  // Parabolic interpolation around the peak.
  const y0 = corr[bestLag - 1];
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1];
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  return sr / (bestLag + Math.max(-0.5, Math.min(0.5, d)));
}

export interface BassOptions {
  /** Reference time (seconds) of every 16th step of the song, and those steps' ticks. */
  stepTimes: number[];
  stepTicks: number[];
  /** Song tuning in cents (a recording off A=440 still lands on the right keys). */
  tuning?: number;
  /** A full mix rather than a bass stem: be stricter about kicks. */
  mix?: boolean;
}

export async function transcribeBass(buf: AudioBuffer, o: BassOptions): Promise<Note[]> {
  const sr = buf.sampleRate;
  const x = await lowpassed(buf, o.mix ? 120 : 180);
  const n = o.stepTimes.length;
  const level = new Float64Array(n);
  const rise = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const t = o.stepTimes[s];
    const next = o.stepTimes[s + 1] ?? t + 0.12;
    level[s] = 20 * Math.log10(rms(x, sr, t, next) + 1e-9);
    rise[s] = 20 * Math.log10((rms(x, sr, t + 0.005, t + 0.035) + 1e-9) / (rms(x, sr, t - 0.03, t - 0.005) + 1e-9));
  }
  const loudest = Math.max(...level);
  const hits: number[] = [];
  for (let s = 0; s < n; s++) {
    if (rise[s] > 4 && level[s] > loudest - 30 && (s === 0 || rise[s] >= rise[s - 1]) && (s + 1 >= n || rise[s] >= rise[s + 1])) hits.push(s);
  }
  const notes: Note[] = [];
  const shift = (o.tuning ?? 0) / 100;
  hits.forEach((s, i) => {
    const t = o.stepTimes[s];
    const next = hits[i + 1] ?? n;
    const peak = Math.max(level[s], level[s + 1] ?? -200);
    let e = s + 1;
    while (e < next && level[e] > peak - 15) e++;
    const len = e - s;
    // An 808 starts sharp and glides down onto its note: measure the steady part after that.
    const end = o.stepTimes[e] ?? t + 0.4;
    const f = end - t > 0.3 ? pitchOf(x, sr, t + 0.15, Math.min(t + 0.4, end)) : pitchOf(x, sr, t + 0.05, end);
    if (!f) return;
    if (o.mix && len < 3) return; // a kick's thump, not a held bass note
    const pitch = Math.round(69 + 12 * Math.log2(f / 440) - shift);
    if (pitch < 18 || pitch > 60) return;
    const vel = Math.max(0.4, Math.min(1, 1 + (peak - loudest) / 30));
    notes.push({ id: newNoteId(), pitch, start: o.stepTicks[s], dur: len * STEP, vel: Math.round(vel * 100) / 100 });
  });
  return notes;
}
