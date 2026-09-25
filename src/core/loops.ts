/**
 * Linked loops: a stretch of bars whose copies stay the same. Edit the notes of any copy and the
 * others follow, the way a pattern works in a loop-based DAW, while the song stays a plain list of
 * notes that everything else (playback, export, the visualizer) reads as usual.
 *
 * The store calls syncLoops after every change: whichever copy differs from how it was last time
 * is the one that was edited, and it is written over the others.
 */
import { BAR, newNoteId, type LinkedLoop, type Note, type Song, type Track } from './types';

/** Covered tracks of a loop (all tracks when it lists none). */
function covered(song: Song, loop: LinkedLoop): Track[] {
  return loop.tracks?.length ? song.tracks.filter((t) => loop.tracks!.includes(t.id)) : song.tracks;
}

function copyNotes(t: Track, start: number, length: number): Note[] {
  return t.notes.filter((n) => n.start >= start && n.start < start + length);
}

function signature(song: Song, loop: LinkedLoop, start: number): string {
  return covered(song, loop)
    .map((t) => `${t.id}|${copyNotes(t, start, loop.length).map((n) => `${n.start - start}:${n.pitch}:${n.dur}:${Math.round(n.vel * 1000)}`).sort().join(',')}`)
    .join(';');
}

export type LoopSigs = Map<string, string[]>;

export function loopSignatures(song: Song): LoopSigs {
  return new Map((song.loops ?? []).map((l) => [l.id, l.starts.map((s) => signature(song, l, s))]));
}

/** Write copy `from` of a loop over its copy at `to`. */
function writeCopy(song: Song, loop: LinkedLoop, from: number, to: number): void {
  for (const t of covered(song, loop)) {
    const src = copyNotes(t, from, loop.length);
    t.notes = t.notes.filter((n) => !(n.start >= to && n.start < to + loop.length));
    for (const n of src) t.notes.push({ ...n, id: newNoteId(), start: n.start - from + to });
    t.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }
}

/** Make every loop's copies match the one that was just edited. Returns the new signatures. */
export function syncLoops(song: Song, before: LoopSigs): LoopSigs {
  for (const loop of song.loops ?? []) {
    const prev = before.get(loop.id);
    const now = loop.starts.map((s) => signature(song, loop, s));
    if (now.every((s) => s === now[0])) continue;
    // The edited copy: one that changed since last time (the first, if several did).
    let master = prev && prev.length === now.length ? now.findIndex((s, i) => s !== prev[i]) : -1;
    if (master < 0) master = 0;
    for (let i = 0; i < loop.starts.length; i++) if (i !== master && now[i] !== now[master]) writeCopy(song, loop, loop.starts[master], loop.starts[i]);
  }
  return loopSignatures(song);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Make [start, end) (bar lines) a linked loop, over some tracks or all of them. */
export function makeLoop(song: Song, start: number, end: number, tracks?: string[], name?: string): LinkedLoop {
  const a = Math.floor(start / BAR) * BAR;
  const b = Math.max(a + BAR, Math.ceil(end / BAR) * BAR);
  const loops = (song.loops ??= []);
  const loop: LinkedLoop = {
    id: 'lp' + Math.random().toString(36).slice(2, 8),
    name: name ?? `Loop ${LETTERS[loops.length % 26]}`,
    length: b - a,
    starts: [a],
    ...(tracks?.length ? { tracks } : {}),
  };
  loops.push(loop);
  return loop;
}

/** Where a copy could go without overlapping the loop's other copies. */
function fits(loop: LinkedLoop, at: number, bars: number): boolean {
  return at >= 0 && at + loop.length <= bars * BAR && loop.starts.every((s) => at + loop.length <= s || at >= s + loop.length);
}

/** Put a copy of the loop at a bar line (replacing what its tracks had there). False if it would overlap another copy or run off the end. */
export function placeLoop(song: Song, loopId: string, at: number): boolean {
  const loop = song.loops?.find((l) => l.id === loopId);
  if (!loop) return false;
  const t = Math.floor(at / BAR) * BAR;
  if (!fits(loop, t, song.bars)) return false;
  writeCopy(song, loop, loop.starts[0], t);
  loop.starts.push(t);
  loop.starts.sort((x, y) => x - y);
  return true;
}

/** Repeat the loop back to back after its last copy, up to `until` (the song's end by default). */
export function fillLoop(song: Song, loopId: string, until = song.bars * BAR): number {
  const loop = song.loops?.find((l) => l.id === loopId);
  if (!loop) return 0;
  let n = 0;
  for (let at = loop.starts[loop.starts.length - 1] + loop.length; at + loop.length <= until; at += loop.length) if (placeLoop(song, loopId, at)) n++;
  return n;
}

/** Stop linking a copy (its notes stay). The loop goes when it has no copies left. */
export function unlinkCopy(song: Song, loopId: string, start: number): void {
  const loop = song.loops?.find((l) => l.id === loopId);
  if (!loop) return;
  loop.starts = loop.starts.filter((s) => s !== start);
  if (loop.starts.length < 1) removeLoop(song, loopId);
}

/** Forget a loop (the notes stay as they are). */
export function removeLoop(song: Song, loopId: string): void {
  song.loops = (song.loops ?? []).filter((l) => l.id !== loopId);
  if (!song.loops.length) delete song.loops;
}

/** The loop copy a tick falls in, for the tracks shown (a loop over other tracks doesn't count). */
export function loopAt(song: Song, tick: number, trackId?: string): { loop: LinkedLoop; start: number } | null {
  for (const loop of song.loops ?? []) {
    if (trackId && loop.tracks?.length && !loop.tracks.includes(trackId)) continue;
    const start = loop.starts.find((s) => tick >= s && tick < s + loop.length);
    if (start !== undefined) return { loop, start };
  }
  return null;
}
