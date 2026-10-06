/**
 * Split a recording into drums, bass, other and vocals with Meta's Hybrid Transformer Demucs
 * (HTDemucs v4) running in the browser.
 *
 * The network runs in onnxruntime-web, fetched from jsDelivr the first time: on WebGPU when the
 * browser has an adapter, on single-threaded WASM otherwise (the page isn't cross-origin isolated,
 * so there are no threads). The ONNX export is timcsy's (huggingface.co/timcsy/demucs-web-onnx,
 * ~180 MB, cached with the Cache Storage API). ONNX can't run the model's STFT and iSTFT, so they
 * are done here, as is demucs' splitting of the song into 7.8 s segments blended by triangular
 * overlap-add. That code follows demucs' apply.py/htdemucs.py and bakkot's JavaScript port,
 * rewritten around a packed FFT (both channels in one complex transform) and an overlap-add that
 * streams finished audio out, so a long song needs only one segment of working memory.
 *
 * All of it runs in a Worker built from a Blob URL (the app also ships as a single HTML file):
 * one segment on WASM is ~25 s of solid compute that would otherwise freeze the page.
 *
 * Ported from MIT-licensed code:
 *   Demucs, Copyright (c) Meta Platforms, Inc. and affiliates (github.com/facebookresearch/demucs)
 *   demucs-js, Copyright (c) 2014 Kevin Gibbons and contributors (github.com/bakkot/demucs-js)
 *   demucs-web, Copyright (c) 2024 timcsy (github.com/timcsy/demucs-web)
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { cdn } from '../core/cdn';

export interface Stems {
  drums: AudioBuffer;
  bass: AudioBuffer;
  other: AudioBuffer;
  vocals: AudioBuffer;
}

export interface SeparateOptions {
  /** Seconds into the buffer (default 0). */
  from?: number;
  /** Seconds into the buffer (default its end). */
  to?: number;
  /** Overall progress 0..1 (the one-off model download, then the separation) and a line for the UI. */
  onProgress?: (fraction: number, message: string) => void;
  /** Cancels the run: the promise rejects with a DOMException named 'AbortError'. */
  signal?: AbortSignal;
}

type Backend = 'webgpu' | 'wasm';

const ORT_PATH = 'onnxruntime-web@1.23.2/dist/';
// Pinned to a commit, so the bytes behind the cache entry can never change.
const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx';
const MODEL_BYTES = 180534758;
const CACHE_NAME = 'beatmaker-models';
const MODEL_SR = 44100;
/** HTDemucs' training segment: 7.8 s at 44.1 kHz. */
const SEGMENT = 343980;
/** How long a finished worker keeps its loaded model, for back-to-back runs. */
const KEEP_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// The worker

/** The bits of onnxruntime-web used here (it is loaded at runtime, so there are no npm types). */
interface OrtTensor {
  readonly dims: readonly number[];
  readonly data: Float32Array;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  env: { wasm: { wasmPaths?: string; wasmBinary?: ArrayBuffer; numThreads?: number }; webgpu?: { adapter?: unknown } };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array, opts: { executionProviders: string[] }): Promise<OrtSession> };
}

interface Job {
  backend: Backend;
  ortBase: string;
  modelUrl: string;
  modelBytes: number;
  cacheName: string;
  /** 44.1 kHz stereo, with some of the song around the range when there is any. */
  left: Float32Array;
  right: Float32Array;
  /** The range to separate, in samples of left/right. */
  start: number;
  end: number;
}

type Reply =
  | { type: 'progress'; fraction: number; message: string }
  | { type: 'backend'; backend: Backend }
  /** Finished audio for [at, at + length) of the range: 4 stems x 2 channels, one after another. */
  | { type: 'chunk'; at: number; length: number; data: Float32Array }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * The worker's whole program. It is stringified into a Blob, so it must not use anything from the
 * module around it (types are fine: they are gone by then). `importModule` is `(u) => import(u)`
 * from the worker's own source: written here, the bundler would try to resolve the import.
 */
function workerMain(importModule: (url: string) => Promise<unknown>): void {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<Job>) => void) | null;
    postMessage(msg: Reply, transfer: Transferable[]): void;
  };
  const post = (msg: Reply, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const SEG = 343980;
  const STRIDE = Math.floor(0.75 * SEG); // demucs' default 25 % overlap
  const NFFT = 4096;
  const HOP = 1024;
  const BINS = 2048; // the Nyquist bin is dropped
  const FRAMES = 336; // ceil(SEG / HOP)
  const PLANE = BINS * FRAMES;
  // HTDemucs pads by 3/4 of a hop (and centres frames), so frame j starts at j * HOP - 1536.
  const FIRST = -(HOP / 2) * 3;

  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  // demucs' triangle, peaking mid-segment: blends each segment into the next.
  const weight = new Float32Array(SEG);
  for (let i = 0; i < SEG; i++) weight[i] = i < SEG / 2 ? i + 1 : SEG - i;

  // Radix-2 FFT with tables, in place on re/im.
  const rev = new Uint16Array(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 1, x = i; b < NFFT; b <<= 1, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cosT = new Float64Array(NFFT / 2);
  const sinT = new Float64Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / NFFT);
    sinT[i] = -Math.sin((2 * Math.PI * i) / NFFT);
  }
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const fft = (xr: Float64Array, xi: Float64Array) => {
    for (let i = 0; i < NFFT; i++) {
      const j = rev[i];
      if (i < j) {
        let t = xr[i];
        xr[i] = xr[j];
        xr[j] = t;
        t = xi[i];
        xi[i] = xi[j];
        xi[j] = t;
      }
    }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const half = size >> 1;
      const step = NFFT / size;
      for (let i = 0; i < NFFT; i += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = i + k;
          const b = a + half;
          const wr = cosT[t];
          const wi = sinT[t];
          const br = xr[b] * wr - xi[b] * wi;
          const bi = xr[b] * wi + xi[b] * wr;
          xr[b] = xr[a] - br;
          xi[b] = xi[a] - bi;
          xr[a] += br;
          xi[a] += bi;
        }
      }
    }
  };

  /**
   * The model's spectrogram input (its _spec + _magnitude): torch.stft(normalized, hann 4096, hop
   * 1024) of the reflect-padded segment, frames 2..337, channels [L re, L im, R re, R im]. Left and
   * right go through one complex FFT as l + i r and are pulled apart by conjugate symmetry.
   */
  const spec = (wave: Float32Array, mag: Float32Array) => {
    const norm = 1 / Math.sqrt(NFFT);
    for (let j = 0; j < FRAMES; j++) {
      const s = FIRST + j * HOP;
      for (let n = 0; n < NFFT; n++) {
        let t = s + n;
        if (t < 0) t = -t;
        else if (t >= SEG) t = 2 * SEG - 2 - t;
        const w = win[n] * norm;
        re[n] = wave[t] * w;
        im[n] = wave[SEG + t] * w;
      }
      fft(re, im);
      for (let k = 0; k < BINS; k++) {
        const k2 = (NFFT - k) & (NFFT - 1);
        const o = k * FRAMES + j;
        mag[o] = (re[k] + re[k2]) / 2;
        mag[PLANE + o] = (im[k] - im[k2]) / 2;
        mag[2 * PLANE + o] = (im[k] + im[k2]) / 2;
        mag[3 * PLANE + o] = (re[k2] - re[k]) / 2;
      }
    }
  };

  /**
   * Add source `src`'s spectrogram output, turned back into sound (the model's _ispec), onto its
   * waveform output `out` ([2][SEG] at `at`). Every output sample sees four frames, so the Hann
   * envelope torch.istft divides by is exactly 1.5.
   */
  const ispec = (freq: Float32Array, src: number, out: Float32Array, at: number) => {
    const base = src * 4 * PLANE;
    const scale = Math.sqrt(NFFT) / NFFT / 1.5;
    for (let j = 0; j < FRAMES; j++) {
      for (let k = 0; k < BINS; k++) {
        const o = base + k * FRAMES + j;
        const a = freq[o];
        const c = freq[o + 2 * PLANE];
        // irfft ignores the DC bin's imaginary part.
        const b = k ? freq[o + PLANE] : 0;
        const d = k ? freq[o + 3 * PLANE] : 0;
        // Spectrum of l + i r from L = a + ib and R = c + id.
        re[k] = a - d;
        im[k] = b + c;
        if (k) {
          re[NFFT - k] = a + d;
          im[NFFT - k] = c - b;
        }
      }
      re[BINS] = 0;
      im[BINS] = 0;
      // A forward FFT with re and im swapped is an inverse FFT (times NFFT).
      fft(im, re);
      const s = FIRST + j * HOP;
      const n0 = Math.max(0, -s);
      const n1 = Math.min(NFFT, SEG - s);
      for (let n = n0; n < n1; n++) {
        const w = win[n] * scale;
        out[at + s + n] += re[n] * w;
        out[at + SEG + s + n] += im[n] * w;
      }
    }
  };

  let ort: Ort | null = null;
  let session: OrtSession | null = null;

  const loadOrt = async (url: string): Promise<Ort> => {
    for (let attempt = 0; ; attempt++) {
      try {
        // A failed module fetch can stay cached under its URL, so retries use a fresh one.
        return (await importModule(attempt ? `${url}?retry=${attempt}` : url)) as Ort;
      } catch (e) {
        if (attempt >= 3) throw new Error('Could not download onnxruntime-web', { cause: e });
        await sleep(800 * (attempt + 1));
      }
    }
  };

  const fetchBytes = async (url: string): Promise<ArrayBuffer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        if (attempt >= 3) throw new Error(`Could not download ${url}`, { cause: e });
        await sleep(800 * (attempt + 1));
      }
    }
  };

  /** The model's bytes, resuming a download that drops (the file is big for a flaky connection). */
  const download = async (job: Job, share: number): Promise<Uint8Array<ArrayBuffer>> => {
    const total = job.modelBytes;
    const mb = (b: number) => Math.round(b / 1e6);
    const bytes = new Uint8Array(total);
    let got = 0;
    let said = 0;
    for (let attempt = 0; ; attempt++) {
      const from = got;
      try {
        // no-store: the Cache Storage copy is the one kept, not a second one in the HTTP cache.
        const res = await fetch(job.modelUrl, { cache: 'no-store', headers: got ? { Range: `bytes=${got}-` } : {} });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        if (got && res.status !== 206) got = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (got + value.length > total) throw new Error('The stem model is larger than expected');
          bytes.set(value, got);
          got += value.length;
          if (Date.now() - said > 200) {
            said = Date.now();
            post({ type: 'progress', fraction: (share * got) / total, message: `Downloading the stem model (${mb(got)} of ${mb(total)} MB, once)…` });
          }
        }
        if (got !== total) throw new Error('The stem model download was cut short');
        return bytes;
      } catch (e) {
        if (attempt >= 4) throw e;
        // Only resume if this attempt got somewhere: a server that fails ranged requests starts over.
        if (got === from) got = 0;
        await sleep(1000 * (attempt + 1));
      }
    }
  };

  const modelBytes = async (job: Job): Promise<{ bytes: Uint8Array<ArrayBuffer>; downloaded: boolean }> => {
    let cache: Cache | null = null;
    try {
      cache = await caches.open(job.cacheName);
    } catch {
      // No Cache Storage (an insecure context, some private modes): download every time.
    }
    const hit = await cache?.match(job.modelUrl).catch(() => undefined);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.length === job.modelBytes) return { bytes, downloaded: false };
      await cache?.delete(job.modelUrl);
    }
    const bytes = await download(job, 0.4);
    try {
      await cache?.put(job.modelUrl, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch {
      // Out of quota: it still works, it just downloads again next time.
    }
    return { bytes, downloaded: true };
  };

  /** Load the model once per worker; returns where the separation's share of the progress starts. */
  const load = async (job: Job): Promise<number> => {
    post({ type: 'progress', fraction: 0, message: 'Loading the stem model…' });
    let backend = job.backend;
    let adapter: unknown = null;
    if (backend === 'webgpu') {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<unknown> } }).gpu;
      adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
      if (!adapter) backend = 'wasm';
    }
    // The default build has the WebGPU backend (and WASM); the WASM-only one is half the size.
    // The .bundle builds have ORT's glue code inside, and the binary is fetched here, so every
    // download goes through a retry instead of ORT's own one-shot imports.
    const gpuBuild = backend === 'webgpu';
    const [lib, wasm, { bytes, downloaded }] = await Promise.all([
      loadOrt(job.ortBase + (gpuBuild ? 'ort.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs')),
      fetchBytes(job.ortBase + (gpuBuild ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm')),
      modelBytes(job),
    ]);
    ort = lib;
    ort.env.wasm.wasmBinary = wasm;
    ort.env.wasm.wasmPaths = job.ortBase;
    // Threads need SharedArrayBuffer, which only a cross-origin isolated page has.
    ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    if (ort.env.webgpu && adapter) ort.env.webgpu.adapter = adapter;
    const start = downloaded ? 0.4 : 0;
    if (downloaded) post({ type: 'progress', fraction: start, message: 'Loading the stem model…' });
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [backend] });
    } catch (e) {
      if (backend !== 'webgpu') throw e;
      // A GPU that can't take the model (memory, limits): the CPU still can.
      backend = 'wasm';
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }
    post({ type: 'backend', backend });
    return start;
  };

  const separate = async (job: Job) => {
    const start = session ? 0 : await load(job);
    const s = session!;
    const o = ort!;
    const { left, right } = job;
    const a = job.start;
    const n = job.end - job.start;
    // demucs scales the whole song to unit deviation first; the model rescales each segment
    // itself, so this only keeps quiet recordings clear of its epsilon.
    let mean = 0;
    for (let i = a; i < a + n; i++) mean += left[i] + right[i];
    mean /= 2 * n;
    let v = 0;
    for (let i = a; i < a + n; i++) v += ((left[i] + right[i]) / 2 - mean) ** 2;
    const std = Math.sqrt(v / Math.max(1, n - 1)) || 1;
    for (let i = 0; i < left.length; i++) {
      left[i] /= std;
      right[i] /= std;
    }

    const total = Math.ceil(n / STRIDE);
    const wave = new Float32Array(2 * SEG);
    const mag = new Float32Array(4 * PLANE);
    // Overlap-add window starting at the current segment: 4 stems x 2 channels, and weights.
    const acc = new Float32Array(8 * SEG);
    const wsum = new Float32Array(SEG);
    const t0 = 0.02 + start;
    for (let k = 0; k < total; k++) {
      post({ type: 'progress', fraction: t0 + ((1 - t0) * k) / total, message: `Separating stems… part ${k + 1} of ${total}` });
      const off = k * STRIDE;
      const len = Math.min(SEG, n - off);
      // demucs' TensorChunk.padded: a short last segment is centred, with song around it if any.
      const pad = (SEG - len) >> 1;
      const s0 = a + off - pad;
      const lo = Math.max(0, s0);
      const hi = Math.min(left.length, s0 + SEG);
      wave.fill(0);
      wave.set(left.subarray(lo, hi), lo - s0);
      wave.set(right.subarray(lo, hi), SEG + lo - s0);
      spec(wave, mag);
      const res = await s.run({
        [s.inputNames[0]]: new o.Tensor('float32', wave, [1, 2, SEG]),
        [s.inputNames[1]]: new o.Tensor('float32', mag, [1, 4, BINS, FRAMES]),
      });
      const outs = s.outputNames.map((name) => res[name]);
      const freq = outs.find((t) => t.dims.length === 5)?.data; // [1, 4 stems, 4, BINS, FRAMES]
      const time = outs.find((t) => t.dims.length === 4)?.data; // [1, 4 stems, 2, SEG]
      if (!freq || !time) throw new Error('The stem model gave unexpected outputs');
      for (let src = 0; src < 4; src++) ispec(freq, src, time, src * 2 * SEG);
      for (let ch = 0; ch < 8; ch++) {
        const y = ch * SEG + pad;
        const dst = ch * SEG;
        for (let i = 0; i < len; i++) acc[dst + i] += weight[i] * time[y + i];
      }
      for (let i = 0; i < len; i++) wsum[i] += weight[i];
      // Everything before the next segment's start has had all its segments: send it.
      const last = k === total - 1;
      const m = last ? len : STRIDE;
      const data = new Float32Array(8 * m);
      for (let ch = 0; ch < 8; ch++) {
        for (let i = 0; i < m; i++) data[ch * m + i] = (acc[ch * SEG + i] * std) / wsum[i];
      }
      post({ type: 'chunk', at: off, length: m, data }, [data.buffer]);
      if (last) break;
      for (let ch = 0; ch < 8; ch++) {
        acc.copyWithin(ch * SEG, ch * SEG + STRIDE, (ch + 1) * SEG);
        acc.fill(0, (ch + 1) * SEG - STRIDE, (ch + 1) * SEG);
      }
      wsum.copyWithin(0, STRIDE);
      wsum.fill(0, SEG - STRIDE);
    }
  };

  scope.onmessage = (e) => {
    separate(e.data).then(
      () => post({ type: 'done' }),
      (err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };
}

// ---------------------------------------------------------------------------------------------
// The page side

let spare: { worker: Worker; timer: ReturnType<typeof setTimeout> } | null = null;

function takeWorker(): Worker {
  if (spare) {
    clearTimeout(spare.timer);
    const w = spare.worker;
    spare = null;
    return w;
  }
  const src = `const importModule = (url) => import(url);\n(${workerMain.toString()})(importModule);\n`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module', name: 'stem separation' });
  // It has read its script by the time it first talks back.
  const revoke = () => URL.revokeObjectURL(url);
  w.addEventListener('message', revoke, { once: true });
  w.addEventListener('error', revoke, { once: true });
  return w;
}

/** Park a finished worker for a while (its model loaded), then let its memory go. */
function keepWorker(w: Worker): void {
  if (spare) {
    w.terminate();
    return;
  }
  spare = {
    worker: w,
    timer: setTimeout(() => {
      w.terminate();
      spare = null;
    }, KEEP_MS),
  };
}

const abortError = () => new DOMException('Stem separation was cancelled.', 'AbortError');

function runWorker(job: Job, onChunk: (at: number, length: number, data: Float32Array) => void, onProgress?: SeparateOptions['onProgress'], signal?: AbortSignal): Promise<void> {
  const worker = takeWorker();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      if (err) {
        // Also the only way to stop a WASM run mid-segment.
        worker.terminate();
        reject(err);
      } else {
        keepWorker(worker);
        resolve();
      }
    };
    const onAbort = () => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.fraction, m.message);
      else if (m.type === 'backend') backendp = Promise.resolve(m.backend);
      else if (m.type === 'chunk') onChunk(m.at, m.length, m.data);
      else if (m.type === 'done') finish();
      else finish(new Error(m.message));
    };
    worker.onerror = (e) => finish(new Error(e.message || 'The stem separation worker failed'));
    worker.postMessage(job, [job.left.buffer, job.right.buffer]);
  });
}

/**
 * The range as 44.1 kHz stereo, with up to half a segment of the song either side: demucs centres
 * a short last segment and fills around it, and real audio there beats silence. `lead` is where
 * the range really starts, in (fractional) samples after `start`, when the rates differ.
 */
async function modelInput(buf: AudioBuffer, i0: number, i1: number): Promise<{ left: Float32Array; right: Float32Array; start: number; end: number; lead: number }> {
  const sr = buf.sampleRate;
  const margin = Math.ceil((SEGMENT / 2) * (sr / MODEL_SR));
  const c0 = Math.max(0, i0 - margin);
  const c1 = Math.min(buf.length, i1 + margin);
  if (sr === MODEL_SR && buf.numberOfChannels <= 2) {
    const left = buf.getChannelData(0).slice(c0, c1);
    const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice(c0, c1) : left.slice();
    return { left, right, start: i0 - c0, end: i1 - c0, lead: 0 };
  }
  const len = Math.max(1, Math.round(((c1 - c0) * MODEL_SR) / sr));
  const ctx = new OfflineAudioContext(2, len, MODEL_SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, c0 / sr, (c1 - c0) / sr);
  const r = await ctx.startRendering();
  const at = ((i0 - c0) * MODEL_SR) / sr;
  const start = Math.floor(at);
  // One sample past the end, for the resampler back to the song's rate.
  const end = Math.min(len, Math.ceil(at + ((i1 - i0) * MODEL_SR) / sr) + 1);
  return { left: r.getChannelData(0).slice(), right: r.getChannelData(1).slice(), start, end, lead: at - start };
}

/** A 44.1 kHz stem at the song's rate, `length` samples from `lead` samples in. */
function toRate(stem: AudioBuffer, lead: number, length: number, sr: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(stem.numberOfChannels, length, sr);
  const src = ctx.createBufferSource();
  src.buffer = stem;
  src.connect(ctx.destination);
  src.start(0, lead / MODEL_SR);
  return ctx.startRendering();
}

/**
 * Split a recording into four stems with Meta's HTDemucs (v4) running in the browser. The model
 * (~180 MB) downloads once and is cached. The stems line up sample for sample with the range, at
 * the buffer's rate (mono in gives mono stems, anything else stereo), and add up to about the
 * input. Slow on WASM: about 4 s of compute per second of audio on a fast desktop core.
 */
export async function separateStems(buf: AudioBuffer, opts: SeparateOptions = {}): Promise<Stems> {
  const { onProgress, signal } = opts;
  if (signal?.aborted) throw abortError();
  const sr = buf.sampleRate;
  const i0 = Math.min(buf.length, Math.max(0, Math.round((opts.from ?? 0) * sr)));
  const i1 = Math.min(buf.length, Math.max(i0, Math.round((opts.to ?? buf.duration) * sr)));
  if (i1 <= i0) throw new RangeError('Nothing to separate: the range is empty');
  onProgress?.(0, 'Preparing the audio…');
  const input = await modelInput(buf, i0, i1);
  if (signal?.aborted) throw abortError();
  const channels = buf.numberOfChannels === 1 ? 1 : 2;
  const len = input.end - input.start;
  const stems = [0, 1, 2, 3].map(() => new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: MODEL_SR }));
  // Written into as the worker streams audio out, so no second copy of the stems exists.
  const outs = stems.map((b) => Array.from({ length: channels }, (_, c) => b.getChannelData(c)));
  const job: Job = {
    backend: await separationBackend(),
    ortBase: cdn(ORT_PATH),
    modelUrl: MODEL_URL,
    modelBytes: MODEL_BYTES,
    cacheName: CACHE_NAME,
    ...input,
  };
  await runWorker(
    job,
    (at, length, data) => {
      for (let s = 0; s < 4; s++) {
        const l = data.subarray(2 * s * length, (2 * s + 1) * length);
        const r = data.subarray((2 * s + 1) * length, (2 * s + 2) * length);
        if (channels === 2) {
          outs[s][0].set(l, at);
          outs[s][1].set(r, at);
        } else {
          const m = outs[s][0];
          for (let i = 0; i < length; i++) m[at + i] = (l[i] + r[i]) / 2;
        }
      }
    },
    onProgress,
    signal,
  );
  const done: AudioBuffer[] = [];
  // One stem at a time, so only one extra copy is alive at once.
  for (const stem of stems) done.push(sr === MODEL_SR ? stem : await toRate(stem, input.lead, i1 - i0, sr));
  if (signal?.aborted) throw abortError();
  onProgress?.(1, 'Stems ready');
  return { drums: done[0], bass: done[1], other: done[2], vocals: done[3] };
}

let backendp: Promise<Backend> | null = null;

/** Which backend separation will use here ('webgpu' or 'wasm'). */
export function separationBackend(): Promise<Backend> {
  backendp ??= (async (): Promise<Backend> => {
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<unknown> } }).gpu;
      if (gpu && (await gpu.requestAdapter({ powerPreference: 'high-performance' }))) return 'webgpu';
    } catch {
      // No usable WebGPU.
    }
    return 'wasm';
  })();
  return backendp;
}

/** Whether the model is already cached (so the UI can say "first run downloads 180 MB"). */
export async function separationModelCached(): Promise<boolean> {
  try {
    return (await (await caches.open(CACHE_NAME)).match(MODEL_URL)) !== undefined;
  } catch {
    return false;
  }
}
