/**
 * The sampler: plays one of the user's own sounds (a vocal chop, a loop, a one-shot) in three ways.
 *
 * - pitch: across the keyboard, at its original pitch on the root note.
 * - slice: chopped at its transients (or into equal parts), one chop per key from C3 up.
 * - loop:  stretched to the song tempo (by playback rate), repeating for as long as the note lasts.
 *
 * The sound itself lives in the library (IndexedDB); tracks keep only its id and these settings.
 */
import { getFile } from '../core/library';
import type { SamplerSettings, Track } from '../core/types';
import type { Voice, VoiceArgs } from './voice';

/** The key the first slice is on (C3); slice n is on SLICE_BASE + n. */
export const SLICE_BASE = 48;
export const MAX_SLICES = 32;

const buffers = new Map<string, AudioBuffer>();
const reversed = new Map<string, AudioBuffer>();
const loads = new Map<string, Promise<AudioBuffer | null>>();
let decoder: BaseAudioContext | null = null;

/** Decode a library sound (cached). Resolves null if it isn't in this browser or can't be read. */
export function loadSamplerFile(id: string): Promise<AudioBuffer | null> {
  let p = loads.get(id);
  if (!p) {
    p = (async () => {
      try {
        decoder ??= new OfflineAudioContext(2, 1, 48000);
        const buf = await decoder.decodeAudioData(await getFile(id));
        buffers.set(id, buf);
        return buf;
      } catch {
        loads.delete(id);
        return null;
      }
    })();
    loads.set(id, p);
  }
  return p;
}

export function samplerBuffer(id: string): AudioBuffer | undefined {
  return buffers.get(id);
}

/** Load every sound the song's sampler tracks use. */
export function ensureSamplerFiles(tracks: Track[]): Promise<void> {
  const ids = new Set(tracks.filter((t) => t.instrument === 'sampler' && t.sampler?.file).map((t) => t.sampler!.file));
  return Promise.all([...ids].map(loadSamplerFile)).then(() => undefined);
}

function reverse(id: string, buf: AudioBuffer): AudioBuffer {
  let r = reversed.get(id);
  if (!r) {
    r = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) r.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
    reversed.set(id, r);
  }
  return r;
}

/**
 * Chop points (seconds, ascending, the first at the region start) at the sound's transients:
 * rises in a 5 ms energy envelope, at least 70 ms apart, the strongest `max` of them.
 */
export function detectSlices(buf: AudioBuffer, from: number, to: number, max = 16): number[] {
  const sr = buf.sampleRate;
  const hop = Math.round(sr * 0.005);
  const a = Math.floor(from * sr);
  const b = Math.min(buf.length, Math.floor(to * sr));
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const env: number[] = [];
  for (let i = a; i + hop <= b; i += hop) {
    let s = 0;
    for (const ch of chans) for (let j = i; j < i + hop; j++) s += ch[j] * ch[j];
    env.push(10 * Math.log10(s / hop / chans.length + 1e-10));
  }
  const peak = Math.max(...env, -100);
  // Onset strength: how much louder this frame is than the recent past (quiet frames don't count).
  const flux = env.map((e, i) => (e < peak - 45 ? 0 : Math.max(0, e - Math.max(...env.slice(Math.max(0, i - 4), i), -100))));
  const minGap = Math.round(0.07 / 0.005);
  const cands = flux
    .map((f, i) => [f, i] as const)
    .filter(([f, i]) => f > 6 && i > minGap && f >= Math.max(...flux.slice(Math.max(0, i - 2), i + 3)))
    .sort((x, y) => y[0] - x[0]);
  const picked: number[] = [];
  for (const [, i] of cands) {
    if (picked.length >= max - 1) break;
    if (picked.every((p) => Math.abs(p - i) >= minGap)) picked.push(i);
  }
  picked.sort((x, y) => x - y);
  const times = picked.map((i) => from + ((i - 1) * hop) / sr);
  // Silence before the first hit is not a chop of its own.
  const lead = picked.length ? Math.max(...env.slice(0, Math.max(1, picked[0] - 1)), -100) : 0;
  return picked.length && lead < peak - 35 ? times : [from, ...times];
}

/** Slice boundaries in seconds: n + 1 values from the region start to its end. */
export function sliceBounds(s: SamplerSettings, buf: AudioBuffer): number[] {
  const from = s.start * buf.duration;
  const to = Math.max(from + 0.01, s.end * buf.duration);
  const starts = s.points?.length ? s.points.filter((p) => p >= from && p < to) : Array.from({ length: s.slices }, (_, i) => from + ((to - from) * i) / s.slices);
  if (!starts.length) starts.push(from);
  return [...starts, to];
}

/** A likely length in beats for a loop at this tempo: the power of two that fits best. */
export function guessBeats(seconds: number, bpm: number): number {
  const beats = (seconds * bpm) / 60;
  let best = 1;
  for (let b = 1; b <= 64; b *= 2) if (Math.abs(Math.log2(beats / b)) < Math.abs(Math.log2(beats / best))) best = b;
  return best;
}

/** Play the sampler for one note. Returns null when there's nothing to play (sound missing, key off the slices). */
export function playSampler(ctx: BaseAudioContext, out: AudioNode, s: SamplerSettings, a: VoiceArgs, bpm: number): Voice | null {
  const raw = buffers.get(s.file);
  if (!raw) return null;
  const buf = s.reverse ? reverse(s.file, raw) : raw;
  // With reverse on, the trim still means the same part of the sound: mirror it.
  const [lo, hi] = s.reverse ? [1 - s.end, 1 - s.start] : [s.start, s.end];
  let offset = lo * buf.duration;
  let length = Math.max(0.005, (hi - lo) * buf.duration);
  let rate = 1;
  let loop = false;
  if (s.mode === 'pitch') {
    rate = Math.pow(2, (a.pitch - s.root) / 12);
  } else if (s.mode === 'slice') {
    const b = sliceBounds({ ...s, start: lo, end: hi, points: s.reverse ? undefined : s.points }, buf);
    const i = Math.round(a.pitch) - SLICE_BASE;
    if (i < 0 || i >= b.length - 1) return null;
    offset = b[i];
    length = b[i + 1] - b[i];
  } else {
    // Loop: stretch the region to `beats` beats of the song.
    rate = Math.max(0.25, Math.min(4, length / ((s.beats * 60) / bpm)));
    loop = true;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  const level = Math.pow(Math.max(0.05, a.vel), 1.2) * Math.pow(10, s.gain / 20);
  const t = a.time;
  const atk = Math.max(0.002, s.attack);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + atk);
  src.connect(g).connect(out);
  if (loop) {
    src.loop = true;
    src.loopStart = offset;
    src.loopEnd = offset + length;
    src.start(t, offset);
  } else src.start(t, offset, length);
  const playEnd = loop ? Infinity : t + length / rate;
  /** When the fade-out starts, once one is scheduled. */
  let fadeAt = Infinity;
  const stopAt = (when: number, fade: number) => {
    const at = Math.max(when, t + atk);
    if (at >= fadeAt) {
      // Already fading out by then: just make sure it's gone quickly.
      if (fade < 0.01) {
        try {
          src.stop(at + fade + 0.01);
        } catch {
          /* already stopped */
        }
      }
      return;
    }
    fadeAt = at;
    g.gain.cancelScheduledValues(at);
    g.gain.setValueAtTime(level, at);
    g.gain.linearRampToValueAtTime(0, at + fade);
    try {
      src.stop(at + fade + 0.01);
    } catch {
      /* already stopped */
    }
  };
  if (a.dur !== null) {
    const noteEnd = t + a.dur;
    // A one-shot that ends by itself before the note does needs no release.
    if (noteEnd < playEnd) stopAt(noteEnd, Math.max(0.005, s.release));
  }
  return {
    release: (when) => stopAt(Math.min(when, playEnd), Math.max(0.005, s.release)),
    kill: (when) => stopAt(when, 0.008),
  };
}
