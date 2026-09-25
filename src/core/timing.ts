import { PPQ, type Song } from './types';

interface Segment {
  tick: number;
  sec: number;
  secPerTick: number;
}

/**
 * Converts between ticks and seconds for a song, honouring its tempo map and swing.
 * Swing pushes the second 16th of every 8th note later (MPC style, 50% .. 75%).
 */
export class Timeline {
  readonly segs: Segment[];
  readonly swingMid: number;

  constructor(song: Pick<Song, 'bpm' | 'tempoChanges' | 'swing'>) {
    const changes = [{ tick: 0, bpm: song.bpm }, ...song.tempoChanges.filter((c) => c.tick > 0)].sort(
      (a, b) => a.tick - b.tick,
    );
    this.segs = [];
    let sec = 0;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      const secPerTick = 60 / (Math.max(20, c.bpm) * PPQ);
      if (i > 0) {
        const prev = this.segs[i - 1];
        sec = prev.sec + (c.tick - prev.tick) * prev.secPerTick;
      }
      this.segs.push({ tick: c.tick, sec, secPerTick });
    }
    const half = PPQ / 4; // one 16th
    this.swingMid = half + Math.max(0, Math.min(1, song.swing)) * (half / 2);
  }

  /** Apply the swing warp to a tick position. */
  swingTick(tick: number): number {
    if (this.swingMid === PPQ / 4) return tick;
    const eighth = PPQ / 2;
    const half = PPQ / 4;
    const base = Math.floor(tick / eighth) * eighth;
    const p = tick - base;
    const mid = this.swingMid;
    return base + (p < half ? (p * mid) / half : mid + ((p - half) * (eighth - mid)) / half);
  }

  /** Inverse of swingTick(). */
  unswingTick(tick: number): number {
    if (this.swingMid === PPQ / 4) return tick;
    const eighth = PPQ / 2;
    const half = PPQ / 4;
    const base = Math.floor(tick / eighth) * eighth;
    const p = tick - base;
    const mid = this.swingMid;
    return base + (p < mid ? (p * half) / mid : half + ((p - mid) * half) / (eighth - mid));
  }

  /** Tick → seconds without swing (for grid lines). */
  rawTickToSec(tick: number): number {
    const segs = this.segs;
    let s = segs[0];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].tick <= tick) {
        s = segs[i];
        break;
      }
    }
    return s.sec + (tick - s.tick) * s.secPerTick;
  }

  /** Tick → seconds including swing (where notes actually sound). */
  tickToSec(tick: number): number {
    return this.rawTickToSec(this.swingTick(tick));
  }

  /** Seconds → ticks (ignores swing). */
  secToTick(sec: number): number {
    const segs = this.segs;
    let s = segs[0];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].sec <= sec) {
        s = segs[i];
        break;
      }
    }
    return s.tick + (sec - s.sec) / s.secPerTick;
  }

  bpmAt(tick: number): number {
    const segs = this.segs;
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].tick <= tick) return 60 / (segs[i].secPerTick * PPQ);
    return 60 / (segs[0].secPerTick * PPQ);
  }
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
