import { Timeline } from '../core/timing';
import type { Note, Song, Track } from '../core/types';
import { instrumentFor, type Voice } from './instruments';

export interface TrackBus {
  input: GainNode;
  vol: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

export interface SchedEvent {
  /** Song time in seconds. */
  t: number;
  end: number;
  track: Track;
  note: Note;
  glideFrom?: number;
}

const impulseCache = new Map<number, AudioBuffer>();

function makeImpulse(ctx: BaseAudioContext, seconds = 2.4, decay = 3.2): AudioBuffer {
  const cached = impulseCache.get(ctx.sampleRate);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * (0.25 + 0.6 * (1 - x));
      d[i] = lp * Math.pow(1 - x, decay) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
    }
  }
  impulseCache.set(ctx.sampleRate, buf);
  return buf;
}

/** The mixer graph: track buses → synth bus → master chain. Works for live and offline contexts. */
export class Graph {
  readonly masterIn: GainNode;
  readonly synthBus: GainNode;
  readonly backing: GainNode;
  readonly out: GainNode;
  readonly reverbIn: GainNode;
  readonly buses = new Map<string, TrackBus>();

  constructor(readonly ctx: BaseAudioContext) {
    this.masterIn = ctx.createGain();
    this.masterIn.gain.value = 0.9;
    this.synthBus = ctx.createGain();
    this.synthBus.connect(this.masterIn);
    this.backing = ctx.createGain();
    this.backing.connect(this.masterIn);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.out = ctx.createGain();
    this.masterIn.connect(comp).connect(limiter).connect(this.out);

    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbIn.connect(hp).connect(conv).connect(wet).connect(this.synthBus);
  }

  bus(track: Track): TrackBus {
    let b = this.buses.get(track.id);
    if (!b) {
      const input = this.ctx.createGain();
      const vol = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const send = this.ctx.createGain();
      input.connect(vol).connect(pan).connect(this.synthBus);
      pan.connect(send).connect(this.reverbIn);
      b = { input, vol, pan, send };
      this.buses.set(track.id, b);
    }
    return b;
  }

  /** Apply volume / pan / mute / solo for all tracks. */
  applyMix(song: Song, smooth = true): void {
    const anySolo = song.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    for (const t of song.tracks) {
      const b = this.bus(t);
      const audible = !t.mute && (!anySolo || t.solo);
      const g = audible ? t.volume : 0;
      if (smooth) {
        b.vol.gain.setTargetAtTime(g, now, 0.015);
        b.pan.pan.setTargetAtTime(t.pan, now, 0.015);
        b.send.gain.setTargetAtTime(t.reverb, now, 0.015);
      } else {
        b.vol.gain.value = g;
        b.pan.pan.value = t.pan;
        b.send.gain.value = t.reverb;
      }
    }
  }
}

/** Flatten a song into time-ordered note events, resolving mono legato/glide. */
export function buildEvents(song: Song, tl: Timeline): SchedEvent[] {
  const events: SchedEvent[] = [];
  for (const track of song.tracks) {
    const notes = [...track.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const mono = track.kind === 'synth' && !!instrumentFor(track.instrument).mono;
    let prev: SchedEvent | null = null;
    for (const note of notes) {
      const t = tl.tickToSec(note.start);
      const end = tl.tickToSec(note.start + Math.max(1, note.dur));
      const ev: SchedEvent = { t, end, track, note };
      if (mono && prev) {
        const prevEndTick = prev.note.start + prev.note.dur;
        if (prevEndTick > note.start + 1 && prev.note.start < note.start) {
          ev.glideFrom = prev.note.pitch;
          prev.end = Math.min(prev.end, t);
        } else if (prev.note.start === note.start) {
          continue; // mono: ignore stacked notes
        }
      }
      events.push(ev);
      prev = ev;
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

/** First index with events[i].t >= t. */
export function lowerBound(events: SchedEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type KitBuffers = Map<string, Map<number, AudioBuffer>>;

interface Playing {
  voice: Voice;
  end: number;
}

/** Turns note events into sound on a Graph. */
export class NoteScheduler {
  private openHats = new Map<string, { g: GainNode; src: AudioBufferSourceNode; t: number }>();
  private active: Playing[] = [];

  constructor(
    readonly graph: Graph,
    readonly kits: KitBuffers,
  ) {}

  /** Schedule one event at absolute context time `at`, for `dur` seconds. */
  play(track: Track, pitch: number, vel: number, at: number, dur: number | null, glideFrom?: number): Voice | null {
    const ctx = this.graph.ctx;
    const bus = this.graph.bus(track);
    if (track.kind === 'drums') {
      const buf = this.kits.get(track.instrument)?.get(pitch);
      if (!buf) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = Math.pow(Math.max(0.05, vel), 1.2);
      src.connect(g).connect(bus.input);
      src.start(at);
      // Closed hat chokes a ringing open hat.
      if (pitch === 42 || pitch === 46) {
        const prev = this.openHats.get(track.id);
        if (prev && prev.t < at) {
          prev.g.gain.setTargetAtTime(0, at, 0.012);
        }
        if (pitch === 46) this.openHats.set(track.id, { g, src, t: at });
      }
      const voice: Voice = {
        release: () => {},
        kill: (t) => {
          g.gain.cancelScheduledValues(t);
          g.gain.setTargetAtTime(0, t, 0.01);
          try {
            src.stop(t + 0.06);
          } catch {
            /* ignore */
          }
        },
      };
      this.track(voice, at + buf.duration);
      return voice;
    }
    const inst = instrumentFor(track.instrument);
    const voice = inst.build(ctx, bus.input, { time: at, pitch, dur, vel, glideFrom });
    this.track(voice, dur === null ? Infinity : at + dur + 4);
    return voice;
  }

  private track(voice: Voice, end: number): void {
    this.active.push({ voice, end });
    if (this.active.length > 256) {
      const now = this.graph.ctx.currentTime;
      this.active = this.active.filter((p) => p.end > now);
    }
  }

  killAll(t: number): void {
    for (const p of this.active) p.voice.kill(t);
    this.active = [];
    this.openHats.clear();
  }
}
