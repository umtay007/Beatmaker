/**
 * MP3 encoding with lamejs (LGPL-3.0, github.com/zhuker/lamejs via @breezystack/lamejs), loaded from
 * jsDelivr the first time it's needed.
 */
const LAME_URL = 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js';

interface Mp3Encoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
}
interface Lame {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => Mp3Encoder;
}

/** Import a module from a URL, retrying: a flaky connection shouldn't cost the export. */
async function importRetrying<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      if (i < tries - 1) return (await import(/* @vite-ignore */ url)) as T;
      // Last go: fetch it ourselves (fetch retries differently from the module loader).
      const code = await (await fetch(url)).text();
      const blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        return (await import(/* @vite-ignore */ blob)) as T;
      } finally {
        URL.revokeObjectURL(blob);
      }
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error('Could not load the MP3 encoder');
}

let lame: Promise<Lame> | null = null;
function loadLame(): Promise<Lame> {
  lame ??= importRetrying<Lame>(LAME_URL).catch((e) => {
    lame = null;
    throw new Error(`the MP3 encoder didn't download (${(e as Error).message})`);
  });
  return lame;
}

function toInt16(f: Float32Array, from: number, n: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, f[from + i] ?? 0));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Encode a (stereo or mono) AudioBuffer as a constant-bitrate MP3. */
export async function encodeMp3(buf: AudioBuffer, kbps = 256, onProgress?: (fraction: number) => void): Promise<Blob> {
  const { Mp3Encoder } = await loadLame();
  const stereo = buf.numberOfChannels > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, buf.sampleRate, kbps);
  const L = buf.getChannelData(0);
  const R = stereo ? buf.getChannelData(1) : null;
  const parts: BlobPart[] = [];
  const block = 1152 * 20;
  for (let i = 0; i < buf.length; i += block) {
    const n = Math.min(block, buf.length - i);
    const out = R ? enc.encodeBuffer(toInt16(L, i, n), toInt16(R, i, n)) : enc.encodeBuffer(toInt16(L, i, n));
    if (out.length) parts.push(new Uint8Array(out));
    if ((i / block) % 20 === 0) {
      onProgress?.(i / buf.length);
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress?.(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}
