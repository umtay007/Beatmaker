/**
 * Tidy a transcribed part by its repeats. Beats are built from loops, so a part that repeats every
 * few bars should say the same thing each time; a transcriber misses and invents different notes on
 * each pass. Find the loop length, group the blocks that really are repeats of each other, and
 * rewrite each group as the notes most of its blocks agree on (median length and velocity).
 * Blocks that repeat nothing (a fill, a new section) are left alone.
 */
import { BAR, newNoteId, STEP, type Note } from './types';

export interface TidyOptions {
  /** Song length in bars. */
  bars: number;
  /** Loop lengths to consider, in bars. */
  periods?: number[];
  /** How many blocks must share a pattern before it is trusted (default 3). */
  minRepeats?: number;
  /** Fraction of a group's blocks a note must appear in to be kept (default 0.5). */
  keep?: number;
  /** How alike two blocks must be to count as repeats (0..1 note overlap, default 0.35). */
  alike?: number;
}

export interface TidyResult {
  notes: Note[];
  /** The loop length used, in bars (0 when nothing repeated). */
  period: number;
  /** Blocks rewritten from a consensus. */
  tidied: number;
}

type Key = string;
const keyOf = (step: number, pitch: number): Key => `${step}:${pitch}`;

interface Block {
  index: number;
  start: number;
  notes: Note[];
  keys: Map<Key, Note>;
}

function blocks(notes: Note[], period: number, phase: number, bars: number): Block[] {
  const len = period * BAR;
  const out: Block[] = [];
  const first = phase * BAR - Math.ceil((phase * BAR) / len) * len;
  for (let start = first, i = 0; start < bars * BAR; start += len, i++) {
    const inside = notes.filter((n) => n.start >= start && n.start < start + len);
    const keys = new Map<Key, Note>();
    for (const n of inside) keys.set(keyOf(Math.round((n.start - start) / STEP), n.pitch), n);
    out.push({ index: i, start, notes: inside, keys });
  }
  return out;
}

/** Note overlap of two blocks (F1 of matching step+pitch, a step of slack either way). */
function overlap(a: Map<Key, Note>, b: Map<Key, Note>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const k of a.keys()) {
    const [s, p] = k.split(':').map(Number);
    if (b.has(k) || b.has(keyOf(s - 1, p)) || b.has(keyOf(s + 1, p))) hit++;
  }
  return (2 * hit) / (a.size + b.size);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[s.length >> 1];
};

export function tidyRepeats(notes: Note[], o: TidyOptions): TidyResult {
  const periods = o.periods ?? [8, 4, 2, 1];
  const minRepeats = o.minRepeats ?? 3;
  const keep = o.keep ?? 0.5;
  const alike = o.alike ?? 0.35;
  if (notes.length < 8) return { notes, period: 0, tidied: 0 };
  // Score each loop length by how well every block matches its best partner anywhere in the song
  // (neighbours alone would count every section change against it).
  const scored: { period: number; phase: number; score: number; bl: Block[]; sim: number[][] }[] = [];
  for (const period of periods) {
    if (period * minRepeats > o.bars) continue;
    for (let phase = 0; phase < period; phase++) {
      const bl = blocks(notes, period, phase, o.bars).filter((b) => b.notes.length);
      if (bl.length < minRepeats) continue;
      const sim = bl.map((a) => bl.map((b) => (a === b ? 1 : overlap(a.keys, b.keys))));
      const bestPartner = sim.map((row, i) => Math.max(...row.filter((_, j) => j !== i)));
      scored.push({ period, phase, score: bestPartner.reduce((x, y) => x + y, 0) / bestPartner.length, bl, sim });
    }
  }
  if (!scored.length) return { notes, period: 0, tidied: 0 };
  const top = Math.max(...scored.map((x) => x.score));
  if (top < alike) return { notes, period: 0, tidied: 0 };
  // The longest loop that repeats about as well: a shorter one would flatten bar-to-bar variation.
  const best = scored.filter((x) => x.score >= top - 0.05).sort((a, b) => b.period - a.period || b.score - a.score)[0];

  // Average-linkage clustering: merge the two most alike groups while they are alike enough.
  const { bl, sim } = best;
  let groups: number[][] = bl.map((_, i) => [i]);
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bs = alike;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let s = 0;
        for (const a of groups[i]) for (const b of groups[j]) s += sim[a][b];
        s /= groups[i].length * groups[j].length;
        if (s > bs) {
          bs = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;
    groups[bi] = [...groups[bi], ...groups[bj]];
    groups = groups.filter((_, k) => k !== bj);
  }

  const replaced = new Set<Note>();
  const added: Note[] = [];
  let tidied = 0;
  for (const gi of groups) {
    if (gi.length < minRepeats) continue;
    const g = gi.map((i) => bl[i]);
    // Votes per pitch and step; a step either way joins the nearest existing vote.
    const votes = new Map<Key, { steps: number[]; durs: number[]; vels: number[] }>();
    for (const b of g) {
      const seen = new Set<Key>();
      for (const [k, n] of b.keys) {
        const [s, p] = k.split(':').map(Number);
        const home = [k, keyOf(s - 1, p), keyOf(s + 1, p)].find((x) => votes.has(x) && !seen.has(x)) ?? k;
        if (seen.has(home)) continue;
        seen.add(home);
        const v = votes.get(home) ?? { steps: [], durs: [], vels: [] };
        v.steps.push(s);
        v.durs.push(n.dur);
        v.vels.push(n.vel);
        votes.set(home, v);
      }
    }
    const pattern: Note[] = [];
    for (const [k, v] of votes) {
      if (v.steps.length < Math.max(2, Math.ceil(g.length * keep))) continue;
      const p = Number(k.split(':')[1]);
      pattern.push({ id: 0, pitch: p, start: median(v.steps) * STEP, dur: Math.max(1, median(v.durs)), vel: median(v.vels) });
    }
    for (const b of g) {
      for (const n of b.notes) replaced.add(n);
      for (const n of pattern) added.push({ ...n, id: newNoteId(), start: b.start + n.start });
      tidied++;
    }
  }
  if (!tidied) return { notes, period: best.period, tidied: 0 };
  const out = [...notes.filter((n) => !replaced.has(n)), ...added].filter((n) => n.start >= 0 && n.start < o.bars * BAR);
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes: out, period: best.period, tidied };
}
