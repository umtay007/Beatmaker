/**
 * Timed lyrics: read LRC, SRT/VTT or plain text, write LRC, and find the line being sung.
 *
 * Lines are kept in ticks so they stay on the beat when the tempo or the bars change. Times shown
 * and read are seconds of the original recording when the song has one (a pasted LRC for the
 * original lines up as it is), which is song time minus the reference offset.
 */
import { Timeline } from './timing';
import { BAR, type LyricLine, type Song } from './types';

export interface TimedText {
  /** Seconds (of the original recording), or null for a line not timed yet. */
  time: number | null;
  end?: number;
  text: string;
}

const SRT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

const secOf = (h: string | undefined, m: string, s: string, ms: string) => (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000);

/** Read lyrics text: LRC tags, SRT/VTT cues, or plain lines (untimed). */
export function parseLyrics(src: string): TimedText[] {
  const text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (SRT_TIME.test(text)) return parseCues(text);
  let offset = 0;
  const out: TimedText[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const meta = /^\[(offset):\s*([+-]?\d+)\]$/i.exec(line);
    if (meta) {
      // LRC offset: positive shows the lyrics sooner.
      offset = -Number(meta[2]) / 1000;
      continue;
    }
    if (/^\[[a-z]+:.*\]$/i.test(line)) continue; // [ar:], [ti:], [length:]...
    const times: number[] = [];
    let rest = line;
    for (;;) {
      const m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest);
      if (!m) break;
      times.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    // Enhanced LRC word times (<mm:ss.xx>) are dropped: lines are what is shown.
    const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    if (times.length) for (const t of times) out.push({ time: Math.max(0, t + offset), text: words });
    else if (words) out.push({ time: null, text: words });
  }
  const timed = out.filter((l) => l.time !== null);
  // A file with some timed lines: the rest are notes, not lyrics.
  return timed.length ? timed.sort((a, b) => a.time! - b.time!) : out;
}

function parseCues(text: string): TimedText[] {
  const out: TimedText[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => SRT_TIME.test(l));
    if (at < 0) continue;
    const m = SRT_TIME.exec(lines[at])!;
    const words = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!words) continue;
    out.push({ time: secOf(m[1], m[2], m[3], m[4]), end: secOf(m[5], m[6], m[7], m[8]), text: words });
  }
  return out.sort((a, b) => a.time! - b.time!);
}

/** Seconds of the original recording ↔ song ticks. */
export function lyricClock(song: Song): { toTick(sec: number): number; toSec(tick: number): number } {
  const tl = new Timeline(song);
  return {
    toTick: (sec) => Math.max(0, Math.round(tl.secToTick(sec + song.audioOffset))),
    toSec: (tick) => tl.tickToSec(tick) - song.audioOffset,
  };
}

/** Where each bar starts, in seconds of the original (line breaks for transcribed lyrics). */
export function barTimes(song: Song): number[] {
  const clock = lyricClock(song);
  return Array.from({ length: song.bars + 1 }, (_, b) => clock.toSec(b * BAR));
}

/** Timed text → song lines (untimed lines are left out). An empty line only ends the one before. */
export function toSongLines(song: Song, lines: TimedText[]): LyricLine[] {
  const clock = lyricClock(song);
  const out: LyricLine[] = [];
  for (const l of lines) {
    if (l.time === null) continue;
    const tick = clock.toTick(l.time);
    if (!l.text) {
      const prev = out[out.length - 1];
      if (prev && tick > prev.tick) prev.end = tick;
      continue;
    }
    out.push({ tick, text: l.text, ...(l.end !== undefined ? { end: Math.max(tick + 1, clock.toTick(l.end)) } : {}) });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

const stamp = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
};

/**
 * Song lines → LRC (an end that isn't the next line's start is written as an empty line). Timed to
 * the original recording, or with `forSong` to the song itself (its exported audio starts at bar 1).
 */
export function toLrc(song: Song, lines: LyricLine[] = song.lyrics ?? [], forSong = false): string {
  const orig = lyricClock(song);
  const clock = forSong ? { toSec: (tick: number) => orig.toSec(tick) + song.audioOffset } : orig;
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(stamp(clock.toSec(l.tick)) + l.text);
    const next = lines[i + 1];
    if (l.end !== undefined && (!next || l.end < next.tick)) out.push(stamp(clock.toSec(l.end)));
  });
  return out.join('\n');
}

export interface ActiveLine {
  index: number;
  line: LyricLine;
  /** Start and end of the singing, and when the line leaves the screen (seconds of song time). */
  t0: number;
  t1: number;
  gone: number;
  next?: LyricLine;
}

/** Roughly how long a line takes to sing (for lines with no end, followed by a long gap). */
export function singTime(text: string): number {
  const syllables = (text.toLowerCase().match(/[aeiouy]+/g) ?? []).length || text.split(/\s+/).length;
  return 0.6 + syllables * 0.28;
}

/** The line on screen at song time t (seconds), if any. */
export function activeLine(lines: LyricLine[], tl: Timeline, t: number): ActiveLine | null {
  let lo = -1;
  for (let i = 0; i < lines.length && tl.tickToSec(lines[i].tick) <= t + 0.15; i++) lo = i;
  if (lo < 0) return null;
  const line = lines[lo];
  const next = lines[lo + 1];
  const t0 = tl.tickToSec(line.tick);
  const nextAt = next ? tl.tickToSec(next.tick) : Infinity;
  const t1 = line.end !== undefined ? Math.min(nextAt, tl.tickToSec(line.end)) : Math.min(nextAt, t0 + singTime(line.text));
  const gone = Math.min(nextAt, t1 + 1.2);
  if (t > gone) return null;
  return { index: lo, line, t0, t1, gone, next };
}
