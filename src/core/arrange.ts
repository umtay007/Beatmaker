/**
 * Song-wide arrangement edits: insert, delete and duplicate whole bars, moving everything that
 * lives on the timeline with them (notes, automation, section markers, tempo changes, the loop).
 * They mutate the song in place, so call them inside store.update() for one undo step.
 */
import { AUTO_BY_ID, valueAt } from './automation';
import { BAR, MAX_BARS, newNoteId, type AutoParam, type Section, type Song } from './types';

/** Section names offered in menus. */
export const SECTION_NAMES = ['Intro', 'Verse', 'Pre-hook', 'Hook', 'Bridge', 'Breakdown', 'Drop', 'Outro'];

/** The section a tick falls in: [start, end) in ticks, or null before the first marker. */
export function sectionAt(song: Song, tick: number): { section: Section; start: number; end: number } | null {
  const list = song.sections ?? [];
  let found: Section | null = null;
  for (const s of list) if (s.tick <= tick) found = s;
  if (!found) return null;
  const next = list.find((s) => s.tick > found!.tick);
  return { section: found, start: found.tick, end: next ? next.tick : song.bars * BAR };
}

/** Add (or rename) a section marker at a bar. */
export function setSection(song: Song, tick: number, name: string): void {
  const at = Math.round(tick / BAR) * BAR;
  const list = (song.sections ??= []);
  const cur = list.find((s) => s.tick === at);
  if (cur) cur.name = name;
  else list.push({ tick: at, name });
  list.sort((a, b) => a.tick - b.tick);
}

export function removeSection(song: Song, tick: number): void {
  song.sections = (song.sections ?? []).filter((s) => s.tick !== tick);
  if (!song.sections.length) delete song.sections;
}

/** Everything at or after `at` moves by `by` ticks (negative moves earlier). */
function shiftFrom(song: Song, at: number, by: number): void {
  for (const t of song.tracks) {
    for (const n of t.notes) if (n.start >= at) n.start += by;
    for (const pts of Object.values(t.automation ?? {})) for (const p of pts ?? []) if (p.tick >= at) p.tick += by;
  }
  for (const s of song.sections ?? []) if (s.tick >= at) s.tick += by;
  for (const c of song.tempoChanges) if (c.tick >= at) c.tick += by;
}

/** Insert `bars` empty bars at a bar line. */
export function insertBars(song: Song, at: number, bars: number): number {
  const n = Math.max(0, Math.min(bars, MAX_BARS - song.bars));
  if (!n) return 0;
  const tick = Math.round(at / BAR) * BAR;
  const len = n * BAR;
  shiftFrom(song, tick, len);
  const l = song.loop;
  if (l.start >= tick) l.start += len;
  if (l.end > tick) l.end += len;
  song.bars += n;
  return n;
}

/** Delete the bars in [from, to) (bar lines). Notes that start before and ring into it are cut short. */
export function deleteBars(song: Song, from: number, to: number): number {
  const a = Math.round(from / BAR) * BAR;
  const b = Math.min(song.bars * BAR, Math.round(to / BAR) * BAR);
  const n = Math.min((b - a) / BAR, song.bars - 1);
  if (n <= 0) return 0;
  const end = a + n * BAR;
  const len = end - a;
  for (const t of song.tracks) {
    t.notes = t.notes.filter((x) => x.start < a || x.start >= end);
    for (const x of t.notes) if (x.start < a && x.start + x.dur > a) x.dur = a - x.start;
    for (const k of Object.keys(t.automation ?? {}) as AutoParam[]) {
      const all = t.automation![k]!;
      const pts = all.filter((p) => p.tick < a || p.tick >= end);
      // The lane carries on from the cut at the value it had at the cut's end.
      if (pts.length !== all.length && !pts.some((p) => p.tick === end)) pts.push({ tick: end, value: valueAt(AUTO_BY_ID.get(k)!, all, end) });
      pts.sort((x, y) => x.tick - y.tick);
      if (pts.length) t.automation![k] = pts;
      else delete t.automation![k];
    }
  }
  // Likewise the tempo: the one in force at the cut's end carries on from the cut.
  const cutTempo = song.tempoChanges.filter((c) => c.tick >= a && c.tick < end);
  const carriedTempo = cutTempo.length && !song.tempoChanges.some((c) => c.tick === end) ? cutTempo[cutTempo.length - 1].bpm : null;
  // A section whose start is deleted but which carries on past the cut starts at the cut instead.
  const cutSections = (song.sections ?? []).filter((s) => s.tick >= a && s.tick < end);
  const carried = cutSections.length ? cutSections[cutSections.length - 1] : null;
  if (song.sections) song.sections = song.sections.filter((s) => s.tick < a || s.tick >= end);
  song.tempoChanges = song.tempoChanges.filter((c) => c.tick < a || c.tick >= end);
  shiftFrom(song, end, -len);
  if (carriedTempo !== null) {
    if (a === 0) song.bpm = carriedTempo;
    else {
      song.tempoChanges.push({ tick: a, bpm: carriedTempo });
      song.tempoChanges.sort((x, y) => x.tick - y.tick);
    }
  }
  if (carried && !(song.sections ?? []).some((s) => s.tick === a) && a < (song.bars - n) * BAR) {
    (song.sections ??= []).push({ tick: a, name: carried.name });
    song.sections.sort((x, y) => x.tick - y.tick);
  }
  if (song.sections && !song.sections.length) delete song.sections;
  const l = song.loop;
  const map = (t: number) => (t >= end ? t - len : t > a ? a : t);
  l.start = map(l.start);
  l.end = map(l.end);
  if (l.end <= l.start) l.enabled = false;
  song.bars -= n;
  return n;
}

/** Copy the bars in [from, to) right after themselves (everything later moves along). */
export function duplicateBars(song: Song, from: number, to: number): number {
  const a = Math.round(from / BAR) * BAR;
  const b = Math.min(song.bars * BAR, Math.round(to / BAR) * BAR);
  const n = insertBars(song, b, (b - a) / BAR);
  if (!n) return 0;
  const len = n * BAR;
  for (const t of song.tracks) {
    const copies = t.notes.filter((x) => x.start >= a && x.start < a + len).map((x) => ({ ...x, id: newNoteId(), start: x.start + len }));
    t.notes.push(...copies);
    t.notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
    for (const pts of Object.values(t.automation ?? {})) {
      if (!pts) continue;
      pts.push(...pts.filter((p) => p.tick >= a && p.tick < a + len).map((p) => ({ tick: p.tick + len, value: p.value })));
      pts.sort((x, y) => x.tick - y.tick);
    }
  }
  const secs = (song.sections ?? []).filter((s) => s.tick >= a && s.tick < a + len).map((s) => ({ tick: s.tick + len, name: s.name }));
  if (secs.length) {
    song.sections!.push(...secs);
    song.sections!.sort((x, y) => x.tick - y.tick);
  }
  return n;
}
