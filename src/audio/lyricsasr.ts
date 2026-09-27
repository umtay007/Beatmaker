/**
 * Lyrics from the vocals: OpenAI's Whisper (the ONNX export by onnx-community, with word times)
 * running in the browser through transformers.js, in a worker so the page keeps going.
 *
 * Only the stretches where someone sings are sent, each under Whisper's 30 s window: fed silence or
 * a long instrumental, it makes words up. The words come back with their times, are grouped into
 * lines at the pauses, or are matched against lines you typed to time those instead.
 */
import type { TimedText } from '../core/lyrics';

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
const MODEL = 'onnx-community/whisper-base_timestamped';
const REVISION = '608c49e61301901684bc36cac8f74b95ff6b5a8e';
/** transformers.js keeps its downloads in this Cache Storage cache. */
const CACHE_NAME = 'transformers-cache';
const SR = 16000;
const KEEP_MS = 120_000;

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface LyricsOptions {
  onProgress?: (message: string, fraction: number) => void;
  signal?: AbortSignal;
  /** Language code ('en', 'es'…); English by default. */
  language?: string;
  /** Bar starts (seconds of the recording): lines break at bar lines where the singing doesn't pause. */
  bars?: number[];
}

interface Job {
  libUrl: string;
  model: string;
  revision: string;
  device: 'webgpu' | 'wasm';
  language: string | null;
  chunks: { at: number; audio: Float32Array }[];
}

type Reply =
  | { type: 'progress'; message: string; fraction: number }
  | { type: 'words'; at: number; words: { text: string; timestamp: [number, number | null] }[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** The worker's whole program (it runs from its source text: nothing from outside is in scope). */
function workerMain(importModule: (url: string) => Promise<unknown>): void {
  type Pipe = (audio: Float32Array, o: object) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
  let pipe: Pipe | null = null;
  let pipeKey = '';
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  const load = async (url: string): Promise<Record<string, any>> => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return (await importModule(i ? `${url}?retry=${i}` : url)) as Record<string, any>;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw last;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mb = (b: number) => Math.round(b / 1e6);
  /** Model files so far: bytes got and expected, for one progress line over all of them. */
  const files = new Map<string, { got: number; total: number }>();
  let said = 0;
  const report = () => {
    if (Date.now() - said < 200) return;
    said = Date.now();
    let a = 0;
    let b = 0;
    for (const f of files.values()) {
      a += f.got;
      b += f.total;
    }
    if (b) post({ type: 'progress', message: `Downloading the speech model (${mb(a)} of ${mb(b)} MB, once)…`, fraction: (0.4 * a) / b });
  };
  /**
   * fetch, but a dropped connection is retried and a big file carries on where it stopped (model
   * files are tens of MB). The body is read here, so the response handed back is complete.
   */
  const sturdyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const big = /\.onnx(_data)?(\?|$)/.test(url);
    const parts: Uint8Array[] = [];
    let got = 0;
    let total = 0;
    let head: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      const from = got;
      try {
        const headers = new Headers(init?.headers);
        if (got) headers.set('Range', `bytes=${got}-`);
        const res = await fetch(url, { ...init, headers });
        if (!big || !res.ok || !res.body) {
          if (res.status >= 500 && attempt < 4) throw new Error(`HTTP ${res.status}`);
          if (!big) return res;
          if (!res.ok) return res;
        }
        if (got && res.status !== 206) {
          parts.length = 0;
          got = 0;
        }
        head ??= res;
        if (!total) total = Number(res.headers.get('content-length') ?? 0) + got;
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          files.set(url, { got, total: Math.max(total, got) });
          report();
        }
        if (total && got < total) throw new Error('The download was cut short');
        const bytes = new Uint8Array(got);
        let at = 0;
        for (const p of parts) {
          bytes.set(p, at);
          at += p.length;
        }
        return new Response(bytes, { status: 200, headers: { 'content-type': head.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(got) } });
      } catch (err) {
        if (attempt >= 4) throw err;
        // Only resume if this attempt got somewhere: a server that fails ranged requests starts over.
        if (got === from) {
          parts.length = 0;
          got = 0;
        }
        await sleep(1000 * (attempt + 1));
      }
    }
  };
  const fetchOk = async (url: string): Promise<Response> => {
    const res = await sturdyFetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status})`);
    return res;
  };
  self.onmessage = async (e: MessageEvent<Job>) => {
    const job = e.data;
    try {
      post({ type: 'progress', message: 'Loading speech recognition…', fraction: 0 });
      const T = await load(job.libUrl);
      T.env.allowLocalModels = false;
      T.env.useBrowserCache = true;
      T.env.fetch = sturdyFetch;
      // ONNX Runtime would fetch its own code and binary once, with no retry: hand them over.
      const ortEnv = T.env.backends?.onnx;
      const v = ortEnv?.versions?.web;
      if (v && ortEnv.wasm && !ortEnv.wasm.wasmBinary) {
        const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${v}/dist/ort-wasm-simd-threaded.asyncify`;
        const [glue, wasm] = await Promise.all([fetchOk(base + '.mjs').then((r) => r.text()), fetchOk(base + '.wasm').then((r) => r.arrayBuffer())]);
        ortEnv.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })) };
        ortEnv.wasm.wasmBinary = wasm;
        ortEnv.wasm.numThreads = 1;
      }
      const key = `${job.model}@${job.revision}/${job.device}`;
      if (!pipe || pipeKey !== key) {
        const make = (device: string) =>
          T.pipeline('automatic-speech-recognition', job.model, {
            revision: job.revision,
            device,
            dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
          });
        try {
          pipe = (await make(job.device)) as Pipe;
        } catch (err) {
          if (job.device !== 'webgpu') throw err;
          pipe = (await make('wasm')) as Pipe;
        }
        pipeKey = key;
      }
      for (let i = 0; i < job.chunks.length; i++) {
        post({ type: 'progress', message: `Listening to the vocals… ${i + 1} of ${job.chunks.length}`, fraction: 0.4 + (0.6 * i) / job.chunks.length });
        const c = job.chunks[i];
        const out = await pipe(c.audio, { return_timestamps: 'word', task: 'transcribe', ...(job.language ? { language: job.language } : {}) });
        post({ type: 'words', at: c.at, words: out.chunks ?? [] });
      }
      post({ type: 'done' });
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) });
    }
  };
}

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
  const w = new Worker(url, { type: 'module', name: 'lyrics' });
  const revoke = () => URL.revokeObjectURL(url);
  w.addEventListener('message', revoke, { once: true });
  w.addEventListener('error', revoke, { once: true });
  return w;
}

function keepWorker(w: Worker): void {
  if (spare) {
    w.terminate();
    return;
  }
  spare = { worker: w, timer: setTimeout(() => (w.terminate(), (spare = null)), KEEP_MS) };
}

async function device(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    // No usable WebGPU.
  }
  return 'wasm';
}

/** The vocals as 16 kHz mono. */
async function mono16k(buf: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * SR)), SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0).slice();
}

const HOP = 320; // 20 ms

/** Where someone sings: [start, end) in seconds, from the level of the vocal stem. */
export function voicedRegions(x: Float32Array): [number, number][] {
  const n = Math.floor(x.length / HOP);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) s += x[i] * x[i];
    db[f] = 10 * Math.log10(s / HOP + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.95)] ?? -20;
  // Separation leaves a little of the band in the vocals: well under the singing.
  const cut = Math.max(-50, loud - 28);
  const out: [number, number][] = [];
  let a = -1;
  let quiet = 0;
  for (let f = 0; f <= n; f++) {
    const on = f < n && db[f] > cut;
    if (on) {
      if (a < 0) a = f;
      quiet = 0;
    } else if (a >= 0 && ++quiet > 40) {
      // 0.8 s without singing ends a stretch.
      const b = f - quiet + 1;
      if ((b - a) * HOP > SR * 0.25) out.push([(a * HOP) / SR, (b * HOP) / SR]);
      a = -1;
    }
    if (f === n && a >= 0) out.push([(a * HOP) / SR, (Math.max(a + 1, n - quiet) * HOP) / SR]);
  }
  return out;
}

/** Group the sung stretches into windows of at most `max` seconds (a long one is cut where it's quietest). */
function windows(regions: [number, number][], x: Float32Array, max = 20): [number, number][] {
  const out: [number, number][] = [];
  const pad = 0.3;
  let cur: [number, number] | null = null;
  const level = (t: number) => {
    const i = Math.floor(t * SR);
    let s = 0;
    for (let k = i; k < Math.min(x.length, i + HOP * 5); k++) s += x[k] * x[k];
    return s;
  };
  for (const [a0, b0] of regions) {
    let a = a0;
    const b = b0;
    // A stretch too long for one window: cut it at its quietest moment near the limit.
    while (b - a > max) {
      let best = a + max - 4;
      let bestL = Infinity;
      for (let t = a + max - 6; t < a + max - 0.5; t += 0.1) {
        const l = level(t);
        if (l < bestL) {
          bestL = l;
          best = t;
        }
      }
      if (cur) out.push(cur);
      cur = null;
      out.push([Math.max(0, a - pad), best]);
      a = best;
    }
    if (cur && b + pad - cur[0] <= max) cur[1] = b + pad;
    else {
      if (cur) out.push(cur);
      cur = [Math.max(0, a - pad), b + pad];
    }
  }
  if (cur) out.push(cur);
  return out;
}

const NOISE = /^[\s♪♫*.,!?-]*$|^\s*[[(][^\])]*[\])]\s*$/;

/** Speech recognition's usual inventions over music. */
const MADE_UP = /^(thank you( for watching)?|thanks for watching|you|bye|subscribe[^.]*|please subscribe[^.]*|\.+)[.!]?$/i;

/** Transcribe the vocals: every word with its time (seconds, from the start of the recording), and the words as lines. */
type RawWords = { text: string; timestamp: [number, number | null] }[];

/** Run windows of the vocals through the worker; the raw words of each, by window start. */
function listen(chunks: Job['chunks'], job: Omit<Job, 'chunks'>, opts: LyricsOptions, share: [number, number]): Promise<{ at: number; words: RawWords }[]> {
  const { signal, onProgress } = opts;
  const raw: { at: number; words: RawWords }[] = [];
  const worker = takeWorker();
  let best = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      if (err) {
        worker.terminate();
        reject(err);
      } else {
        keepWorker(worker);
        resolve(raw);
      }
    };
    const onAbort = () => finish(new DOMException('Lyrics transcription was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const m = e.data;
      if (m.type === 'progress') {
        // Never backwards (a new file joins the download total, say).
        best = Math.max(best, share[0] + (share[1] - share[0]) * m.fraction);
        onProgress?.(m.message, best);
      } else if (m.type === 'words') raw.push({ at: m.at, words: m.words });
      else if (m.type === 'done') finish();
      else finish(new Error(m.message));
    };
    worker.onerror = (e) => finish(new Error(e.message || 'The speech recognition worker failed'));
    worker.postMessage({ ...job, chunks }, chunks.map((c) => c.audio.buffer));
  });
}

/**
 * Where a window's words collapse into a loop: Whisper repeating a phrase with no length and the
 * same time over and over (it has lost its place). Returns the window time it started at, or null.
 */
function loopStart(words: RawWords): number | null {
  let run = 0;
  for (let i = 0; i < words.length; i++) {
    const [a, b] = words[i].timestamp;
    const flat = b !== null && b - a < 0.02;
    run = flat ? run + 1 : 0;
    if (run >= 4) return words[i - run + 1].timestamp[0];
  }
  return null;
}

/** Transcribe the vocals: every word with its time (seconds, from the start of the recording), and the words as lines. */
export async function transcribeLyrics(vocals: AudioBuffer, opts: LyricsOptions = {}): Promise<{ words: Word[]; lines: TimedText[] }> {
  const { signal, onProgress } = opts;
  if (signal?.aborted) throw new DOMException('Lyrics transcription was cancelled.', 'AbortError');
  onProgress?.('Finding where the singing is…', 0);
  const x = await mono16k(vocals);
  const regions = voicedRegions(x);
  const wins = windows(regions, x);
  if (!wins.length) return { words: [], lines: [] };
  const job = { libUrl: LIB_URL, model: MODEL, revision: REVISION, device: await device(), language: opts.language ?? null };
  const cut = (a: number, b: number) => ({ at: a, audio: x.slice(Math.floor(a * SR), Math.min(x.length, Math.ceil(b * SR))) });
  const raw = await listen(
    wins.map(([a, b]) => cut(a, b)),
    job,
    opts,
    [0, 0.85],
  );
  // A window that fell into a loop: keep what came before it and listen to the rest again.
  const again: Job['chunks'] = [];
  for (const r of raw) {
    const at = loopStart(r.words);
    if (at === null) continue;
    const end = wins.find(([a]) => Math.abs(a - r.at) < 1e-6)?.[1] ?? r.at + at + 10;
    r.words = r.words.filter((w) => w.timestamp[0] < at - 0.01);
    if (end - (r.at + at) > 1.5) again.push(cut(r.at + at - 0.2, end));
  }
  if (again.length) {
    const more = await listen(again, job, { ...opts, onProgress: (m, f) => onProgress?.(m.replace('Listening to the vocals', 'Listening again'), f) }, [0.85, 1]);
    for (const r of more) r.words = r.words.filter((_, i, all) => loopStart(all.slice(0, i + 1)) === null);
    raw.push(...more);
  }
  const voiced = (t: number) => regions.some(([a, b]) => t >= a - 0.35 && t <= b + 0.35);
  const words: Word[] = [];
  for (const c of raw) {
    const text = c.words.map((w) => w.text).join('').trim();
    if (MADE_UP.test(text)) continue;
    for (const w of c.words) {
      const t = w.text.trim();
      if (!t || NOISE.test(t)) continue;
      const start = c.at + w.timestamp[0];
      const end = c.at + (w.timestamp[1] ?? w.timestamp[0] + 0.3);
      // No length at all: a word the model lost its place on.
      if (w.timestamp[1] !== null && end - start < 0.02) continue;
      if (!voiced(start) && !voiced(end)) continue;
      words.push({ text: t, start, end: Math.max(start + 0.05, end) });
    }
  }
  words.sort((a, b) => a.start - b.start);
  onProgress?.('Done', 1);
  return { words, lines: wordsToLines(words, opts.bars) };
}

/**
 * Break words into lines. Rap hardly pauses, so pauses alone won't do: a line breaks where there is
 * a pause, a full stop, or a bar line (lines run a bar or two), whichever reads best over the whole
 * song (a small dynamic programme over where the breaks go).
 */
export function wordsToLines(words: Word[], bars?: number[]): TimedText[] {
  const n = words.length;
  if (!n) return [];
  const barLen = bars && bars.length > 1 ? (bars[bars.length - 1] - bars[0]) / (bars.length - 1) : 2.2;
  const nearBar = (t: number) => {
    if (!bars?.length) return 0;
    let lo = 0;
    let hi = bars.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid] <= t) lo = mid;
      else hi = mid;
    }
    return Math.min(Math.abs(t - bars[lo]), Math.abs(t - bars[hi]));
  };
  // How good a break before word i is.
  const bonus = (i: number) => {
    const prev = words[i - 1];
    const gap = words[i].start - prev.end;
    let b = Math.min(3, gap * 5);
    if (/[.!?]$/.test(prev.text)) b += 1.2;
    else if (/[,;:]$/.test(prev.text)) b += 0.5;
    if (bars?.length) b += 1.5 * Math.max(0, 1 - nearBar(words[i].start) / (barLen * 0.12));
    return b;
  };
  // How good a line of words [j, i) is.
  const cost = (j: number, i: number) => {
    const k = i - j;
    const d = words[i - 1].end - words[j].start;
    let c = Math.min(((d - barLen) / barLen) ** 2, ((d - 2 * barLen) / (2 * barLen)) ** 2 + 0.3);
    if (k < 3) c += 1.2;
    for (let q = j + 1; q < i; q++) if (words[q].start - words[q - 1].end > 1) c += 6;
    return c;
  };
  const MAX = 14;
  const best = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - MAX); j < i; j++) {
      if (!Number.isFinite(best[j])) continue;
      const v = best[j] + cost(j, i) - (j > 0 ? bonus(j) : 0);
      if (v < best[i]) {
        best[i] = v;
        from[i] = j;
      }
    }
  }
  const cuts: number[] = [];
  for (let i = n; i > 0; i = from[i]) cuts.unshift(from[i]);
  cuts.push(n);
  const out: TimedText[] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const ws = words.slice(cuts[c], cuts[c + 1]);
    let text = ws.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
    text = text.charAt(0).toUpperCase() + text.slice(1);
    out.push({ time: ws[0].start, end: ws[ws.length - 1].end, text: text.replace(/[,;]$/, '') });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9']/g, '').replace(/'/g, '');

/** How alike two words are, 0..1 (edit distance). */
function likeness(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}

/**
 * Time your lines by the recognised words: line up the two word sequences (heard words are often
 * wrong, but mostly close), then each line starts at its first matched word and ends at its last.
 */
export function alignLyrics(lines: string[], heard: Word[]): { lines: TimedText[]; timed: number } {
  const mine: { line: number; w: string }[] = [];
  lines.forEach((l, i) => l.split(/\s+/).forEach((w) => norm(w) && mine.push({ line: i, w: norm(w) })));
  const hw = heard.map((w) => norm(w.text));
  const n = mine.length;
  const m = hw.length;
  const GAP = -0.6;
  const score = (i: number, j: number) => {
    const s = likeness(mine[i].w, hw[j]);
    return s >= 0.99 ? 2 : s >= 0.6 ? 1 : -1;
  };
  // Needleman-Wunsch, keeping only the moves.
  const H = new Float32Array((n + 1) * (m + 1));
  const move = new Uint8Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    H[i * (m + 1)] = i * GAP;
    move[i * (m + 1)] = 1;
  }
  for (let j = 1; j <= m; j++) {
    H[j] = j * GAP;
    move[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = H[(i - 1) * (m + 1) + j - 1] + score(i - 1, j - 1);
      const up = H[(i - 1) * (m + 1) + j] + GAP;
      const left = H[i * (m + 1) + j - 1] + GAP;
      const k = i * (m + 1) + j;
      if (diag >= up && diag >= left) {
        H[k] = diag;
        move[k] = 0;
      } else if (up >= left) {
        H[k] = up;
        move[k] = 1;
      } else {
        H[k] = left;
        move[k] = 2;
      }
    }
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const mv = move[i * (m + 1) + j];
    if (i > 0 && j > 0 && mv === 0) {
      if (likeness(mine[i - 1].w, hw[j - 1]) >= 0.6) match[i - 1] = j - 1;
      i--;
      j--;
    } else if (i > 0 && (mv === 1 || j === 0)) i--;
    else j--;
  }
  const out: TimedText[] = lines.map((text) => ({ time: null, text }));
  let timed = 0;
  let last = -Infinity;
  lines.forEach((_, li) => {
    const idx = mine.map((x, k) => (x.line === li ? k : -1)).filter((k) => k >= 0);
    const hits = idx.filter((k) => match[k] >= 0);
    // A line only half heard is still placed by the words that were, if enough of it was.
    if (!idx.length || hits.length < Math.max(1, Math.ceil(idx.length * 0.3))) return;
    const first = heard[match[hits[0]]];
    const lastW = heard[match[hits[hits.length - 1]]];
    // Words before the first match: back off a little for each.
    const before = hits[0] - idx[0];
    const time = Math.max(first.start - before * 0.3, last);
    if (time < last) return;
    out[li].time = time;
    out[li].end = Math.max(time + 0.2, lastW.end + (idx[idx.length - 1] - hits[hits.length - 1]) * 0.3);
    last = time + 0.05;
    timed++;
  });
  return { lines: out, timed };
}

/** Whether the speech model is downloaded already. */
export async function whisperCached(): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return keys.some((k) => k.url.includes(MODEL) && k.url.includes('encoder_model'));
  } catch {
    return false;
  }
}
