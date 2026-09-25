/**
 * Turn transcribed audio into song parts: pitched notes split into bass, chords and melody, and
 * drum-grid scores into drum hits, all quantized to the song's grid.
 */
import type { Timeline } from '../core/timing';
import { newNoteId, STEP, type Note } from '../core/types';
import type { DrumStep, PitchNote } from './transcribe';

export interface Parts {
  bass: Note[];
  chords: Note[];
  melody: Note[];
}

export interface PartOptions {
  /** Song time of reference time 0 (the song's audioOffset). */
  offset: number;
  /** Grid in ticks (default a 16th). */
  grid?: number;
  /** Ignore notes quieter than this activation (0..1). */
  minAmp?: number;
  /** Ticks where a kick drum was found: short, very low "notes" there are the kick's thump. */
  kicks?: Set<number>;
  /** Seconds the model tends to hear a note late (slow attacks); starts are moved earlier by this. */
  lag?: number;
  /** Grid for chord starts (chords rarely change on off-16ths; pads are heard late). */
  chordGrid?: number;
}

/** Mono line: sort by start, keep one note per start (by `pick`), and cut each off at the next. */
function monophonic(notes: Note[], pick: (a: Note, b: Note) => Note): Note[] {
  const byStart = new Map<number, Note>();
  for (const n of notes) {
    const cur = byStart.get(n.start);
    byStart.set(n.start, cur ? pick(cur, n) : n);
  }
  const line = [...byStart.values()].sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < line.length; i++) line[i].dur = Math.max(1, Math.min(line[i].dur, line[i + 1].start - line[i].start));
  return line;
}

/**
 * Split pitched notes into parts by where they sit against each other, not by fixed ranges (a
 * bass line can climb into a chord's register). Bass: the lowest sounding note, clear of the
 * notes above it. Melody: the highest line, unless it is just the top of a chord struck with it.
 * Chords: the rest, up to five notes per hit.
 */
export function splitParts(raw: PitchNote[], tl: Timeline, o: PartOptions): Parts {
  const grid = o.grid ?? STEP;
  const lag = o.lag ?? 0.035;
  const q = (sec: number) => Math.max(0, Math.round(tl.unswingTick(tl.secToTick(sec + o.offset - lag)) / grid) * grid);
  const minAmp = o.minAmp ?? 0.22;
  const uniq = new Map<string, Note>();
  for (const n of raw) {
    if (n.amp < minAmp || n.pitch < 24 || n.pitch > 100) continue;
    const start = q(n.start);
    const end = Math.max(start + grid, q(n.start + n.dur));
    const note: Note = { id: 0, pitch: n.pitch, start, dur: end - start, vel: Math.max(0.35, Math.min(1, 0.4 + n.amp)) };
    // The same key twice on one step (a detection split in two): keep the longer.
    const k = `${start}:${n.pitch}`;
    const cur = uniq.get(k);
    if (!cur || note.dur > cur.dur) uniq.set(k, note);
  }
  let all = [...uniq.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // A kick's thump reads as a short low note on the kick.
  if (o.kicks) all = all.filter((n) => !(n.pitch < 40 && n.dur <= 2 * grid && o.kicks!.has(n.start)));
  // One note heard in two octaves at once (a sub's fundamental and its harmonic): keep the stronger.
  const drop = new Set<Note>();
  for (const n of all) {
    for (const m of all) {
      if (m === n || drop.has(m) || drop.has(n)) continue;
      const d = m.pitch - n.pitch;
      if ((d === 12 || d === 24) && Math.abs(m.start - n.start) <= grid && n.pitch < 55) drop.add(m.vel > n.vel + 0.1 ? n : m);
    }
  }
  all = all.filter((n) => !drop.has(n));
  /** Notes sounding at a tick (started at or before it, not yet ended). */
  const sounding = (tick: number, except: Note) => all.filter((m) => m !== except && m.start <= tick && m.start + m.dur > tick);
  const bassSet = new Set<Note>();
  for (const n of all) {
    if (n.pitch > 64) continue;
    const others = sounding(n.start, n);
    const below = others.filter((m) => m.pitch < n.pitch && !bassSet.has(m) && m.start === n.start);
    if (below.length) continue;
    const above = others.filter((m) => m.pitch > n.pitch).map((m) => m.pitch);
    const gap = above.length ? Math.min(...above) - n.pitch : 99;
    // Low enough to be bass, or clearly under whatever else is playing.
    if (n.pitch <= 50 || gap >= 5) bassSet.add(n);
  }
  const bass = monophonic([...bassSet], (a, b) => (a.pitch <= b.pitch ? a : b));
  const inBass = new Set(bass);
  const rest = all.filter((n) => !inBass.has(n));
  const melodySet = new Set<Note>();
  for (const n of rest) {
    if (n.pitch < 55) continue;
    const struck = rest.filter((m) => m !== n && m.start === n.start);
    if (struck.some((m) => m.pitch > n.pitch)) continue;
    // The top of a chord struck with it is not melody unless it stands well clear of the chord.
    if (struck.length >= 2 && n.pitch - Math.max(...struck.map((m) => m.pitch)) < 5) continue;
    const others = sounding(n.start, n).filter((m) => !inBass.has(m));
    if (others.some((m) => m.pitch > n.pitch + 2 && m.start < n.start && !struck.includes(m) && m.dur <= n.dur)) continue;
    melodySet.add(n);
  }
  const melody = monophonic([...melodySet], (a, b) => (a.pitch >= b.pitch ? a : b));
  const inMelody = new Set(melody);
  const byStart = new Map<number, Note[]>();
  for (const n of rest) if (!inMelody.has(n) && n.pitch >= 40) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n]);
  const chords: Note[] = [];
  for (const group of byStart.values()) chords.push(...group.sort((a, b) => b.vel - a.vel).slice(0, 5));
  const cg = o.chordGrid ?? grid;
  if (cg !== grid) {
    // Snap chord starts to the coarser grid (keeping their ends), one note per key per step.
    const seen = new Set<string>();
    for (let i = chords.length - 1; i >= 0; i--) {
      const n = chords[i];
      const end = n.start + n.dur;
      n.start = Math.round(n.start / cg) * cg;
      n.dur = Math.max(grid, end - n.start);
      const k = `${n.start}:${n.pitch}`;
      if (seen.has(k)) chords.splice(i, 1);
      else seen.add(k);
    }
  }
  const withIds = (list: Note[]) => list.map((n) => ({ ...n, id: newNoteId() })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { bass: withIds(bass), chords: withIds(chords), melody: withIds(melody) };
}

/** Drum notes from the grid detector's hits. `ticks[i]` is the tick of step i. */
export function drumNotes(steps: DrumStep[], ticks: number[]): Note[] {
  const out: Note[] = [];
  const add = (pitch: number, i: number, vel: number) => out.push({ id: newNoteId(), pitch, start: ticks[i], dur: STEP, vel });
  steps.forEach((s, i) => {
    if (s.kick) add(36, i, s.kick);
    if (s.snare) add(38, i, s.snare);
    if (s.hat) add(s.open ? 46 : 42, i, s.hat);
  });
  return out;
}
