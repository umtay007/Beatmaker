/**
 * The "ears": which of several candidate recordings sounds most like a reference, as rated by two
 * music-listening models (CLAP, run by the sidecar in the YourMT3+ folder). It judges tone and
 * texture well (a string pad against a piano, a held tone against plucks) and timing badly, so it
 * is used for choosing sounds, together with the measures that look at notes.
 */
import { desktop } from './desktop';

/** A mono 16-bit WAV. */
export function wavMono(x: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + x.length * 2));
  const tag = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  out.setUint32(4, 36 + x.length * 2, true);
  tag(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  tag(36, 'data');
  out.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return new Uint8Array(out.buffer);
}

const rms = (xs: Float32Array[]): number => {
  let s = 0;
  let n = 0;
  for (const x of xs) for (let i = 0; i < x.length; i += 2) (s += x[i] * x[i]), n++;
  return Math.sqrt(s / Math.max(1, n));
};

export async function earsAvailable(): Promise<boolean> {
  const app = desktop();
  return !!app?.earsReady && (await app.earsReady());
}

/**
 * Per candidate, the similarity to the reference clips under each model (null if the ears aren't
 * available). Each candidate's clips are brought to the reference's loudness first: how much
 * louder one is says nothing about how it sounds.
 */
export async function listen(refs: Float32Array[], candidates: Float32Array[][], rate: number): Promise<{ general: number[]; music: number[] } | null> {
  const app = desktop();
  if (!app?.earsScore) return null;
  const want = rms(refs);
  const level = (clips: Float32Array[]) => {
    const g = want / Math.max(1e-6, rms(clips));
    return clips.map((c) => c.map((v) => v * g));
  };
  const res = await app.earsScore(refs.map((r) => wavMono(r, rate)), candidates.map((c) => level(c).map((x) => wavMono(x, rate))));
  if (res.error || !res.general || !res.music) {
    console.warn('The ears failed', res.error);
    return null;
  }
  return { general: res.general, music: res.music };
}

/** Standard scores: mean 0, spread 1 (so measures on different scales can be added). */
export function zscores(xs: number[]): number[] {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  return xs.map((x) => (x - m) / sd);
}
