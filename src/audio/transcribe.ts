/**
 * Transcribe a recording into notes.
 *
 * Pitched parts use Spotify's Basic Pitch model (Apache-2.0, github.com/spotify/basic-pitch-ts):
 * TensorFlow.js and the model are fetched from jsDelivr the first time. Its inference windowing
 * and note extraction are ported here (the extraction made linear-time) so only three files are
 * needed instead of the package's whole module graph.
 *
 * Drums use a grid detector: for every 16th step, how sharply the kick, snare and hi-hat bands
 * rise at that moment compared with the rest of the song.
 */

// ---------------------------------------------------------------------------------------------
// TensorFlow.js + Basic Pitch

interface Tensor {
  shape: number[];
  data(): Promise<Float32Array>;
  dispose(): void;
}
interface GraphModel {
  execute(input: Tensor, outputs: string[]): Tensor[];
}
interface TF {
  tensor(values: Float32Array, shape: number[]): Tensor;
  loadGraphModel(url: string, opts?: { fetchFunc?: typeof fetch }): Promise<GraphModel>;
  ready(): Promise<void>;
  getBackend(): string;
  setBackend(name: string): Promise<boolean>;
}

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';

/** fetch with a few retries: the model download must survive a flaky connection. */
const retryFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.ok || attempt >= 3) return res;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
};

let tfp: Promise<TF> | null = null;
function loadTf(): Promise<TF> {
  const w = window as unknown as { tf?: TF };
  if (w.tf) return Promise.resolve(w.tf);
  tfp ??= (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = TF_URL;
          s.crossOrigin = 'anonymous';
          s.onload = () => resolve();
          s.onerror = () => {
            s.remove();
            reject(new Error('Could not download TensorFlow.js'));
          };
          document.head.append(s);
        });
        break;
      } catch (e) {
        if (attempt >= 3) {
          tfp = null;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    const tf = w.tf!;
    await tf.ready();
    return tf;
  })();
  return tfp;
}

let modelp: Promise<GraphModel> | null = null;
function loadModel(tf: TF): Promise<GraphModel> {
  modelp ??= tf.loadGraphModel(MODEL_URL, { fetchFunc: retryFetch }).catch((e) => {
    modelp = null;
    throw e;
  });
  return modelp;
}

const SR = 22050;
const HOP = 256;
const FPS = Math.floor(SR / HOP);
const WINDOW_SAMPLES = SR * 2 - HOP;
const OVERLAP_FRAMES = 30;
const OVERLAP_HALF = OVERLAP_FRAMES / 2;
const OVERLAP_SAMPLES = OVERLAP_FRAMES * HOP;
const WINDOW_HOP = WINDOW_SAMPLES - OVERLAP_SAMPLES;
const ANNOT_FRAMES = FPS * 2;
const WINDOW_OFFSET = (HOP / SR) * (ANNOT_FRAMES - WINDOW_SAMPLES / HOP) + 0.0018;
const PITCHES = 88;
const MIDI_OFFSET = 21;

const frameToTime = (f: number) => (f * HOP) / SR - WINDOW_OFFSET * Math.floor(f / ANNOT_FRAMES);

export interface PitchNote {
  /** Seconds from the start of the audio given. */
  start: number;
  dur: number;
  pitch: number;
  /** Mean note activation 0..1 (a loudness/confidence mix). */
  amp: number;
}

/** Mono audio at 22.05 kHz, as Basic Pitch wants it. */
export async function toModelRate(buf: AudioBuffer, from: number, to: number): Promise<Float32Array> {
  const len = Math.max(1, Math.ceil((to - from) * SR));
  const ctx = new OfflineAudioContext(1, len, SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, Math.max(0, from), to - from);
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * Run Basic Pitch over mono 22.05 kHz audio: per-frame note and onset activations (86 fps, 88
 * keys from A0). `onProgress` gets 0..1.
 */
export async function activations(audio: Float32Array, onProgress?: (p: number) => void): Promise<{ frames: Float32Array[]; onsets: Float32Array[] }> {
  const tf = await loadTf();
  const model = await loadModel(tf);
  const padded = new Float32Array(OVERLAP_SAMPLES / 2 + audio.length);
  padded.set(audio, OVERLAP_SAMPLES / 2);
  const windows = Math.max(1, Math.ceil(padded.length / WINDOW_HOP));
  const want = Math.floor(audio.length * (FPS / SR));
  const frames: Float32Array[] = [];
  const onsets: Float32Array[] = [];
  const win = new Float32Array(WINDOW_SAMPLES);
  for (let w = 0; w < windows && frames.length < want; w++) {
    onProgress?.(w / windows);
    win.fill(0);
    win.set(padded.subarray(w * WINDOW_HOP, w * WINDOW_HOP + WINDOW_SAMPLES));
    const input = tf.tensor(win, [1, WINDOW_SAMPLES, 1]);
    const [fr, on] = model.execute(input, ['Identity_1', 'Identity_2']);
    const [fd, od] = await Promise.all([fr.data(), on.data()]);
    const t = fr.shape[1];
    for (let i = OVERLAP_HALF; i < t - OVERLAP_HALF && frames.length < want; i++) {
      frames.push(fd.slice(i * PITCHES, (i + 1) * PITCHES));
      onsets.push(od.slice(i * PITCHES, (i + 1) * PITCHES));
    }
    input.dispose();
    fr.dispose();
    on.dispose();
    // Let the page breathe between windows.
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.(1);
  return { frames, onsets };
}

/**
 * Notes from Basic Pitch activations (its outputToNotesPoly with onset inference and the
 * "melodia trick"). The trick's repeated global-maximum search is done by walking the cells in
 * descending order once: cells only ever get zeroed, so the order of maxima is the same.
 */
export function extractNotes(frames: Float32Array[], onsets: Float32Array[], onsetThresh: number, frameThresh: number, minLen: number, energyTol = 11, melodia = true): PitchNote[] {
  const n = frames.length;
  if (n < 3) return [];
  // Onsets inferred from rises in the note activations, scaled to the onset range.
  let onMax = 0;
  let dMax = 0;
  const diff = frames.map((row, t) => {
    const d = new Float32Array(PITCHES);
    if (t < 2) return d;
    for (let p = 0; p < PITCHES; p++) {
      const v = Math.max(0, Math.min(row[p] - frames[t - 1][p], row[p] - frames[t - 2][p]));
      d[p] = v;
      if (v > dMax) dMax = v;
    }
    return d;
  });
  for (const row of onsets) for (let p = 0; p < PITCHES; p++) if (row[p] > onMax) onMax = row[p];
  const inf = onsets.map((row, t) => row.map((v, p) => Math.max(v, dMax > 0 ? (onMax * diff[t][p]) / dMax : 0)));
  const remaining = frames.map((r) => r.slice());
  const zero = (t: number, p: number) => {
    remaining[t][p] = 0;
    if (p < PITCHES - 1) remaining[t][p + 1] = 0;
    if (p > 0) remaining[t][p - 1] = 0;
  };
  const notes: PitchNote[] = [];
  const add = (t0: number, t1: number, p: number) => {
    let a = 0;
    for (let t = t0; t < t1; t++) a += frames[t][p];
    const start = frameToTime(t0);
    notes.push({ start, dur: frameToTime(t1) - start, pitch: p + MIDI_OFFSET, amp: a / Math.max(1, t1 - t0) });
  };
  // Onset peaks (local maxima in time above the threshold), latest first as in the original.
  const starts: [number, number][] = [];
  for (let t = 0; t < n; t++) {
    for (let p = 0; p < PITCHES; p++) {
      const v = inf[t][p];
      if (v > onsetThresh && (t === 0 || v > inf[t - 1][p]) && (t === n - 1 || v > inf[t + 1][p])) starts.push([t, p]);
    }
  }
  for (let s = starts.length - 1; s >= 0; s--) {
    const [t0, p] = starts[s];
    if (t0 >= n - 1) continue;
    let i = t0 + 1;
    let k = 0;
    while (i < n - 1 && k < energyTol) {
      k = remaining[i][p] < frameThresh ? k + 1 : 0;
      i++;
    }
    i -= k;
    if (i - t0 <= minLen) continue;
    for (let t = t0; t < i; t++) zero(t, p);
    add(t0, i, p);
  }
  if (!melodia) return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // Melodia trick: grow notes out of the strongest leftover activations.
  const cells: [number, number, number][] = [];
  for (let t = 0; t < n; t++) for (let p = 0; p < PITCHES; p++) if (remaining[t][p] > frameThresh) cells.push([remaining[t][p], t, p]);
  cells.sort((a, b) => b[0] - a[0]);
  for (const [, tm, p] of cells) {
    if (remaining[tm][p] <= frameThresh) continue;
    remaining[tm][p] = 0;
    let i = tm + 1;
    let k = 0;
    while (i < n - 1 && k < energyTol) {
      k = remaining[i][p] < frameThresh ? k + 1 : 0;
      zero(i, p);
      i++;
    }
    const end = i - 1 - k;
    i = tm - 1;
    k = 0;
    while (i > 0 && k < energyTol) {
      k = remaining[i][p] < frameThresh ? k + 1 : 0;
      zero(i, p);
      i--;
    }
    const start = i + 1 + k;
    if (end - start > minLen) add(start, end, p);
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

export interface PitchOptions {
  /** Onset / frame confidence thresholds (Basic Pitch's defaults are 0.5 / 0.3). */
  onset?: number;
  frame?: number;
  /** Shortest note in seconds. */
  minNote?: number;
}

/**
 * Transcribe the pitched parts of a stretch of audio (downloads the model on first use). `notes`
 * include ones grown from sustained activation without a clear onset (Basic Pitch's "melodia
 * trick", good for pads); `struck` only has notes with an onset, cleaner for a bass line.
 */
export async function transcribePitches(buf: AudioBuffer, from: number, to: number, opts: PitchOptions = {}, onProgress?: (p: number) => void): Promise<{ notes: PitchNote[]; struck: PitchNote[] }> {
  const audio = await toModelRate(buf, from, to);
  const { frames, onsets } = await activations(audio, onProgress);
  const minLen = Math.max(2, Math.round((opts.minNote ?? 0.07) * FPS));
  const at = (list: PitchNote[]) => list.map((nt) => ({ ...nt, start: nt.start + from }));
  return {
    notes: at(extractNotes(frames, onsets, opts.onset ?? 0.5, opts.frame ?? 0.3, minLen)),
    struck: at(extractNotes(frames, onsets, opts.onset ?? 0.5, opts.frame ?? 0.3, minLen, 11, false)),
  };
}

/** The TensorFlow backend in use (for the UI: "webgl" is fast, "cpu" is slow). */
export async function mlBackend(): Promise<string> {
  return (await loadTf()).getBackend();
}

// ---------------------------------------------------------------------------------------------
// Drums

/** Velocity of each drum found on a step (0 = none). */
export interface DrumStep {
  kick: number;
  snare: number;
  hat: number;
  /** Whether the hat rings on (an open hat). */
  open: boolean;
}

/** Radix-2 FFT magnitudes of a Hann-windowed frame (in place on re/im scratch arrays). */
function fftMag(re: Float64Array, im: Float64Array, out: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const u = i + k;
        const v = u + len / 2;
        const xr = re[v] * cr - im[v] * ci;
        const xi = re[v] * ci + im[v] * cr;
        re[v] = re[u] - xr;
        im[v] = im[u] - xi;
        re[u] += xr;
        im[u] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
}

/** Raw per-step drum measurements (for scoring, and for tuning the detector). */
export interface DrumFeatures {
  /** Spectral flux (mean log rise per bin) of each band, peak within -25..+35 ms of the step. */
  kick: number[];
  snare: number[];
  body: number[];
  /** 700 Hz - 2.5 kHz: a clap's or snare's crack, below where hats spill. */
  mid: number[];
  hat: number[];
  /** Low band level change from the hit to 150 ms later (dB): kicks die fast, 808 notes ring. */
  lowDecay: number[];
  /** Hat band level change from the hit to 120 ms later (dB): open hats ring. */
  hatDecay: number[];
}

/**
 * Measure every grid step: how sharply the kick, snare and hi-hat bands rise around it, and how
 * fast the low and high bands die away after it. `steps` are reference-audio times.
 */
export function drumFeatures(buf: Pick<AudioBuffer, 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'>, steps: number[]): DrumFeatures {
  const sr = buf.sampleRate;
  const N = 1024;
  const hop = 256;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const lo = Math.max(0, Math.floor(((steps[0] ?? 0) - 0.2) * sr));
  const hi = Math.min(buf.length, Math.ceil(((steps[steps.length - 1] ?? 0) + 0.4) * sr));
  const nFrames = Math.max(0, Math.floor((hi - lo - N) / hop));
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const bin = (f: number) => Math.round((f * N) / sr);
  const BANDS = { kick: [bin(35), bin(110)], snare: [bin(1500), bin(5000)], body: [bin(150), bin(400)], mid: [bin(700), bin(2500)], hat: [bin(7000), Math.min(N / 2 - 1, bin(16000))] };
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float32Array(N / 2);
  let prev = new Float32Array(N / 2);
  const flux = { kick: new Float32Array(nFrames), snare: new Float32Array(nFrames), body: new Float32Array(nFrames), mid: new Float32Array(nFrames), hat: new Float32Array(nFrames) };
  const level = { low: new Float32Array(nFrames), hat: new Float32Array(nFrames) };
  for (let f = 0; f < nFrames; f++) {
    const o = lo + f * hop;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (const ch of chans) v += ch[o + i];
      re[i] = (v / chans.length) * hann[i];
      im[i] = 0;
    }
    fftMag(re, im, mag);
    const logm = mag.map((m) => Math.log(1e-6 + m));
    for (const key of ['kick', 'snare', 'body', 'mid', 'hat'] as const) {
      const [a, b] = BANDS[key];
      let s = 0;
      for (let k = a; k <= b; k++) s += Math.max(0, logm[k] - prev[k]);
      flux[key][f] = s / (b - a + 1);
    }
    const bandDb = ([a, b]: number[]) => {
      let e = 0;
      for (let k = a; k <= b; k++) e += mag[k] * mag[k];
      return 10 * Math.log10(e + 1e-12);
    };
    level.low[f] = bandDb(BANDS.kick);
    level.hat[f] = bandDb(BANDS.hat);
    prev = logm;
  }
  const frameAt = (t: number) => Math.round((t * sr - lo - N / 2) / hop);
  const clampF = (f: number) => Math.max(0, Math.min(nFrames - 1, f));
  const peak = (arr: Float32Array, t: number) => {
    let m = 0;
    for (let f = Math.max(0, frameAt(t - 0.025)); f <= Math.min(nFrames - 1, frameAt(t + 0.035)); f++) m = Math.max(m, arr[f]);
    return m;
  };
  const maxNear = (arr: Float32Array, t: number) => {
    let m = -200;
    for (let f = clampF(frameAt(t - 0.01)); f <= clampF(frameAt(t + 0.04)); f++) m = Math.max(m, arr[f]);
    return m;
  };
  const out: DrumFeatures = { kick: [], snare: [], body: [], mid: [], hat: [], lowDecay: [], hatDecay: [] };
  for (const t of steps) {
    out.kick.push(peak(flux.kick, t));
    out.snare.push(peak(flux.snare, t));
    out.body.push(peak(flux.body, t));
    out.mid.push(peak(flux.mid, t));
    out.hat.push(peak(flux.hat, t));
    out.lowDecay.push(level.low[clampF(frameAt(t + 0.15))] - maxNear(level.low, t));
    out.hatDecay.push(level.hat[clampF(frameAt(t + 0.12))] - maxNear(level.hat, t));
  }
  return out;
}

/** Scale values so a low percentile of the song is 0 and a high one is 1. */
function spread(vals: number[], floorPct: number, topPct: number): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const floor = s[Math.floor(s.length * floorPct)] ?? 0;
  const top = s[Math.min(s.length - 1, Math.floor(s.length * topPct))] ?? 1;
  return vals.map((v) => (v - floor) / Math.max(1e-6, top - floor));
}

/**
 * Split steps into hits and non-hits with Otsu's threshold (the split with the most between-class
 * variance), which adapts to how busy a part is: hats on every step, a kick twice a bar. Returns
 * velocities (0 = no hit). No hits when the two groups aren't clearly apart (the part isn't there).
 */
function hits(vals: number[], sensitivity: number): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n < 4) return vals.map(() => 0);
  const total = s.reduce((a, b) => a + b, 0);
  let best = -1;
  let cut = 0;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    sum += s[i];
    const lo = sum / (i + 1);
    const hi = (total - sum) / (n - i - 1);
    const v = (i + 1) * (n - i - 1) * (hi - lo) ** 2;
    if (v > best) {
      best = v;
      cut = i;
    }
  }
  const lower = s.slice(0, cut + 1);
  const upper = s.slice(cut + 1);
  const mLo = lower.reduce((a, b) => a + b, 0) / lower.length;
  const mHi = upper.reduce((a, b) => a + b, 0) / upper.length;
  const sd = Math.sqrt(lower.reduce((a, b) => a + (b - mLo) ** 2, 0) / lower.length) || 1e-6;
  if ((mHi - mLo) / sd < 2.5) return vals.map(() => 0);
  const thr = mLo + ((s[cut] + s[cut + 1]) / 2 - mLo) / Math.max(0.25, sensitivity);
  const top = s[Math.floor(n * 0.97)] ?? mHi;
  return vals.map((v) => (v > thr ? 0.55 + 0.45 * Math.min(1, (v - thr) / Math.max(1e-6, top - thr)) : 0));
}

/**
 * Find the drum hits on every grid step: kicks (a low rise that dies fast), snares and claps (a
 * 1.5-5 kHz crack) and hi-hats (a rise above 7 kHz; open when it still rings 120 ms later).
 * `sensitivity` above 1 finds quieter hits. Returns velocities per step (0 = none).
 */
export function drumGrid(buf: Pick<AudioBuffer, 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'>, steps: number[], sensitivity = 1): DrumStep[] {
  const f = drumFeatures(buf, steps);
  const kb = spread(f.kick, 0.3, 0.98);
  const bd = spread(f.body, 0.3, 0.98);
  const dk = spread(f.lowDecay.map((x) => -x), 0.3, 0.98);
  const kick = hits(kb.map((v, i) => v + bd[i] + 0.5 * dk[i]), sensitivity);
  // Snares are sparse, so the split sits too low for them: ask for a clearer crack.
  const snare = hits(f.snare, sensitivity * 0.7);
  const hat = hits(f.hat, sensitivity);
  return steps.map((_, i) => ({ kick: kick[i], snare: snare[i], hat: hat[i], open: f.hatDecay[i] > -6 }));
}
