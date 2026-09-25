/**
 * MediaRecorder writes WebM without a Duration element, so players show no length and can't
 * seek. (Its fragmented MP4 files are fine: players add up the fragments.) Write the real duration
 * into the Segment's Info element without re-muxing anything.
 */
export function withDuration(data: Uint8Array<ArrayBuffer>, ext: 'mp4' | 'webm', seconds: number): Uint8Array<ArrayBuffer> {
  if (ext !== 'webm' || !(seconds > 0)) return data;
  try {
    return webmWithDuration(data, seconds);
  } catch {
    return data;
  }
}

// ---------------------------------------------------------------------------------------------
// WebM: add a Duration element to Segment > Info.

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_CLUSTER = 0x1f43b675;

function readId(d: Uint8Array, i: number): { id: number; len: number } {
  const b = d[i];
  const len = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : b >= 0x10 ? 4 : 0;
  if (!len) throw new Error('bad element id');
  let id = 0;
  for (let k = 0; k < len; k++) id = id * 256 + d[i + k];
  return { id, len };
}

function readSize(d: Uint8Array, i: number): { size: number; len: number; unknown: boolean } {
  const b = d[i];
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('bad size');
  let size = b & (0xff >> len);
  let allOnes = size === 0xff >> len;
  for (let k = 1; k < len; k++) {
    size = size * 256 + d[i + k];
    if (d[i + k] !== 0xff) allOnes = false;
  }
  return { size, len, unknown: allOnes };
}

function encodeSize(size: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let s = size;
  for (let k = len - 1; k >= 0; k--) {
    out[k] = s & 0xff;
    s = Math.floor(s / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function webmWithDuration(d: Uint8Array<ArrayBuffer>, seconds: number): Uint8Array<ArrayBuffer> {
  // Skip the EBML header, find the Segment.
  let i = 0;
  const h = readId(d, i);
  const hs = readSize(d, i + h.len);
  i += h.len + hs.len + hs.size;
  const seg = readId(d, i);
  if (seg.id !== ID_SEGMENT) throw new Error('no segment');
  const segSize = readSize(d, i + seg.len);
  const segBody = i + seg.len + segSize.len;
  // Walk the Segment's children up to the first Cluster.
  let o = segBody;
  while (o < d.length) {
    const el = readId(d, o);
    const sz = readSize(d, o + el.len);
    const body = o + el.len + sz.len;
    // A SeekHead stores byte positions that growing Info would break: leave such files alone.
    if (el.id === ID_SEEK_HEAD || el.id === ID_CLUSTER) break;
    if (el.id === ID_INFO) {
      let scale = 1e6;
      let p = body;
      while (p < body + sz.size) {
        const c = readId(d, p);
        const cs = readSize(d, p + c.len);
        if (c.id === ID_DURATION) return d; // already has one
        if (c.id === ID_TIMECODE_SCALE) {
          scale = 0;
          for (let k = 0; k < cs.size; k++) scale = scale * 256 + d[p + c.len + cs.len + k];
        }
        p += c.len + cs.len + cs.size;
      }
      const dur = new Uint8Array(11);
      dur.set([0x44, 0x89, 0x88]);
      new DataView(dur.buffer).setFloat64(3, (seconds * 1e9) / (scale || 1e6));
      const newSize = sz.size + dur.length;
      let len = sz.len;
      while (newSize >= 2 ** (7 * len) - 1) len++;
      const grow = dur.length + (len - sz.len);
      if (!segSize.unknown && segSize.size + grow >= 2 ** (7 * segSize.len) - 1) throw new Error('segment size overflow');
      const head = encodeSize(newSize, len);
      const out = new Uint8Array(d.length + dur.length + (len - sz.len));
      let w = 0;
      out.set(d.subarray(0, o + el.len), w);
      w += o + el.len;
      out.set(head, w);
      w += head.length;
      out.set(d.subarray(body, body + sz.size), w);
      w += sz.size;
      out.set(dur, w);
      w += dur.length;
      out.set(d.subarray(body + sz.size), w);
      if (!segSize.unknown) out.set(encodeSize(segSize.size + grow, segSize.len), i + seg.len);
      return out;
    }
    if (sz.unknown) break;
    o = body + sz.size;
  }
  throw new Error('no info');
}
