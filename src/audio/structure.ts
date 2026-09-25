/**
 * Find a song's sections (intro, hook, verse, break, outro) from its audio, in 4-bar blocks.
 *
 * Per block: loudness and how much drums and vocals there are (from the separated stems when there
 * are some). Blocks without drums, or clearly quieter than the rest, are the intro, a break or the
 * outro by where they fall; vocal-less ones likewise. Among the rest, a hook is a block whose vocal
 * line comes back step for step somewhere else (hooks are usually pasted); verses don't. Without a
 * vocal stem the same test runs on the whole mix, which works as long as the hook repeats exactly.
 */
import { Timeline } from '../core/timing';
import { BAR, type Section, type Song } from '../core/types';
import { fft } from './fft';

export interface StructureInput {
  song: Song;
  mix: AudioBuffer;
  /** Song time of the recording's start (the song's audioOffset). */
  offset: number;
  vocals?: AudioBuffer;
  drums?: AudioBuffer;
}

interface BlockFeat {
  loud: number;
  drums: number;
  vocals: number;
}

const BLOCK = 4;

function segRms(buf: AudioBuffer, from: number, to: number): number {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const z = Math.min(buf.length, Math.floor(to * sr));
  let s = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < z; i += 4) {
      s += d[i] * d[i];
      n++;
    }
  }
  return n ? 10 * Math.log10(s / n + 1e-12) : -120;
}

/** A fine-grained fingerprint of a stretch: log energy in 24 bands (150 Hz–6 kHz) per step. */
function fingerprint(buf: AudioBuffer, from: number, to: number, steps: number): Float64Array {
  const sr = buf.sampleRate;
  const N = 2048;
  const out = new Float64Array(steps * 24);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const d0 = buf.getChannelData(0);
  const d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0;
  const edges = Array.from({ length: 25 }, (_, i) => Math.round((150 * Math.pow(40, i / 24) * N) / sr));
  for (let st = 0; st < steps; st++) {
    const c = Math.floor((from + ((st + 0.5) / steps) * (to - from)) * sr) - N / 2;
    for (let i = 0; i < N; i++) {
      const j = c + i;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = j >= 0 && j < d0.length ? ((d0[j] + d1[j]) / 2) * w : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < 24; b++) {
      let p = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) p += re[k] * re[k] + im[k] * im[k];
      out[st * 24 + b] = Math.log10(p + 1e-9);
    }
  }
  return out;
}

function pearson(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}


export function detectSections(o: StructureInput): Section[] {
  const tl = new Timeline(o.song);
  const bars = o.song.bars;
  const barSpan = (b: number): [number, number] => [tl.rawTickToSec(b * BAR) - o.offset, tl.rawTickToSec((b + 1) * BAR) - o.offset];
  // Each bar's vocals as 16 steps of band energies: a repeated line matches step for step.
  const voc: (Float64Array | null)[] = [];
  for (let b = 0; b < bars; b++) {
    const [from, to] = barSpan(b);
    // Without a vocal stem, the whole mix: a pasted hook repeats exactly, beat and all.
    voc.push(fingerprint(o.vocals ?? o.mix, from, to, 16));
  }
  const blocks = Math.ceil(bars / BLOCK);
  const feats: BlockFeat[] = [];
  for (let k = 0; k < blocks; k++) {
    const from = tl.rawTickToSec(k * BLOCK * BAR) - o.offset;
    const to = tl.rawTickToSec(Math.min(bars, (k + 1) * BLOCK) * BAR) - o.offset;
    const loud = segRms(o.mix, from, to);
    feats.push({
      loud,
      drums: o.drums ? segRms(o.drums, from, to) - loud : 0,
      vocals: o.vocals ? segRms(o.vocals, from, to) - loud : 0,
    });
  }
  const loudest = Math.max(...feats.map((f) => f.loud));
  const drumsOn = (f: BlockFeat) => (o.drums ? f.drums > -30 : f.loud > loudest - 8);
  const vocalsOn = (f: BlockFeat) => (o.vocals ? f.vocals > -25 : true);
  // How closely a block's vocal line comes back elsewhere, bar for bar (a hook's does).
  const repeat = feats.map((_, k) => {
    let best = 0;
    for (let j = 0; j < blocks; j++) {
      if (Math.abs(j - k) < 2) continue;
      let s = 0;
      let n = 0;
      for (let i = 0; i < BLOCK; i++) {
        const a = voc[k * BLOCK + i];
        const b = voc[j * BLOCK + i];
        if (a && b) {
          s += pearson(a, b);
          n++;
        }
      }
      if (n) best = Math.max(best, s / n);
    }
    return best;
  });
  if ((globalThis as { __secDebug?: boolean }).__secDebug) console.log(feats.map((f, k) => `${k * BLOCK + 1}: loud ${f.loud.toFixed(1)} drums ${f.drums.toFixed(1)} voc ${f.vocals.toFixed(1)} repeat ${repeat[k].toFixed(3)}`).join('\n'));
  const sung = feats.map((f) => drumsOn(f) && vocalsOn(f));
  const reps = repeat.filter((_, k) => sung[k]).sort((a, b) => a - b);
  // Hooks stand out from the verses' repeat level; with no clear gap there is no hook to name.
  const lo = reps[Math.floor(reps.length * 0.25)] ?? 0;
  const hi = reps[Math.floor(reps.length * 0.9)] ?? 0;
  const hookCut = hi - lo > 0.02 ? lo + (hi - lo) * 0.55 : Infinity;
  const sungLoud = feats.filter((_, k) => sung[k]).map((f) => f.loud).sort((a, b) => a - b);
  const typical = sungLoud[sungLoud.length >> 1] ?? loudest;
  const label = feats.map((f, k): string => {
    const first = feats.slice(0, k).every((g) => !drumsOn(g) || g.loud < typical - 3.5);
    const last = feats.slice(k).every((g) => !drumsOn(g) || !vocalsOn(g) || g.loud < typical - 3.5);
    if (!drumsOn(f) || f.loud < typical - 3.5) return first ? 'Intro' : last ? 'Outro' : 'Break';
    if (!vocalsOn(f)) return k === 0 ? 'Intro' : last ? 'Outro' : 'Break';
    return repeat[k] >= hookCut ? 'Hook' : 'Verse';
  });
  // Sections are runs of one label; a lone 4-bar hook or verse inside the other joins its neighbours.
  for (let k = 1; k + 1 < blocks; k++) {
    if ((label[k] === 'Hook' || label[k] === 'Verse') && label[k - 1] === label[k + 1] && label[k - 1] !== label[k] && (label[k - 1] === 'Hook' || label[k - 1] === 'Verse')) label[k] = label[k - 1];
  }
  // A short last block (the song's final bar or two) belongs to the section before it.
  if (blocks > 1 && bars % BLOCK && bars % BLOCK < BLOCK / 2) label[blocks - 1] = label[blocks - 2];
  // A last vocal stretch of 4 bars between the final hook and the outro is the outro starting.
  const lastSung = label.map((l) => l === 'Verse').lastIndexOf(true);
  if (lastSung > 0 && lastSung + 1 < blocks && label[lastSung + 1] === 'Outro' && label[lastSung - 1] === 'Hook') label[lastSung] = 'Outro';
  const out: Section[] = [];
  for (let k = 0; k < blocks; k++) if (k === 0 || label[k] !== label[k - 1]) out.push({ tick: k * BLOCK * BAR, name: label[k] });
  // A break made of one 4-bar block right after the intro is part of the intro.
  const verses = out.filter((x) => x.name === 'Verse').length;
  let n = 0;
  for (const x of out) if (x.name === 'Verse' && verses > 1) x.name = `Verse ${++n}`;
  return out;
}
