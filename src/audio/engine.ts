import type { Store } from '../core/store';
import { Timeline } from '../core/timing';
import { BAR, PPQ, songLengthTicks, type Song, type Track } from '../core/types';
import { loadKit } from './drums';
import { buildEvents, Graph, graphLatency, lowerBound, NoteScheduler, type KitBuffers, type SchedEvent } from './graph';
import type { Voice } from './instruments';
import { peakEnvelope } from './tempo';

const LOOKAHEAD = 0.14;
const INTERVAL = 25;

interface Segment {
  ctx: number;
  song: number;
}

/** Real-time playback: a lookahead scheduler driven by the AudioContext clock. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  graph: Graph | null = null;
  /** Look-ahead delay of the master compressor and limiter, in seconds. */
  private chainLatency = 0;
  sched: NoteScheduler | null = null;
  analyser: AnalyserNode | null = null;
  streamDest: MediaStreamAudioDestinationNode | null = null;
  kits: KitBuffers = new Map();
  backingBuffer: AudioBuffer | null = null;
  backingName = '';
  /** Peak envelope of the backing audio (200 values per second) for waveform drawing. */
  backingPeaks: Float32Array | null = null;
  private backingVol = 0.9;

  playing = false;
  /** When true (video export) loop wrapping and latency compensation are disabled. */
  exportMode = false;
  onEnded: (() => void) | null = null;
  onState: (() => void) | null = null;

  private pausedAt = 0;
  private segs: Segment[] = [];
  private schedSong = 0;
  private untilSec = 0;
  private stopCtx: number | null = null;
  private timer = 0;
  private events: SchedEvent[] = [];
  private eventsVersion = -1;
  private tl: Timeline;
  private tlKey = '';
  private backingSrcs: AudioBufferSourceNode[] = [];
  private kitLoads = new Map<string, Promise<void>>();

  constructor(private store: Store) {
    this.tl = new Timeline(store.song);
    store.on('song', () => this.songChanged());
  }

  get song(): Song {
    return this.store.song;
  }

  get timeline(): Timeline {
    this.refreshTimeline();
    return this.tl;
  }

  /** Create / resume the AudioContext. Must be called from a user gesture the first time. */
  async unlock(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const graph = new Graph(ctx);
      this.graph = graph;
      void graphLatency(ctx.sampleRate).then((s) => (this.chainLatency = s));
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.72;
      graph.out.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      try {
        this.streamDest = ctx.createMediaStreamDestination();
        graph.out.connect(this.streamDest);
      } catch {
        this.streamDest = null;
      }
      this.sched = new NoteScheduler(graph, this.kits);
      graph.backing.gain.value = this.backingVol;
      graph.applyMix(this.song, false);
      this.applySynthMute();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore – will retry on next gesture */
      }
    }
    void this.ensureKits();
    return this.ctx;
  }

  ensureKits(): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const rate = this.ctx.sampleRate;
    const ids = new Set(this.song.tracks.filter((t) => t.kind === 'drums').map((t) => t.instrument));
    const loads: Promise<void>[] = [];
    for (const id of ids) {
      if (this.kits.has(id)) continue;
      let p = this.kitLoads.get(id);
      if (!p) {
        p = loadKit(id, rate).then((bufs) => {
          this.kits.set(id, bufs);
        });
        this.kitLoads.set(id, p);
      }
      loads.push(p);
    }
    return Promise.all(loads).then(() => undefined);
  }

  private refreshTimeline(): void {
    const s = this.song;
    const key = s.bpm + '|' + s.swing + '|' + JSON.stringify(s.tempoChanges);
    if (key !== this.tlKey) {
      this.tlKey = key;
      this.tl = new Timeline(s);
    }
  }

  private getEvents(): SchedEvent[] {
    if (this.eventsVersion !== this.store.songVersion) {
      this.refreshTimeline();
      this.events = buildEvents(this.song, this.tl);
      this.eventsVersion = this.store.songVersion;
    }
    return this.events;
  }

  private songChanged(): void {
    const oldTl = this.tl;
    const oldKey = this.tlKey;
    this.refreshTimeline();
    if (this.graph) {
      this.graph.applyMix(this.song);
      this.applySynthMute();
      void this.ensureKits();
    }
    if (this.playing && oldKey !== this.tlKey && this.ctx) {
      // Tempo or swing changed while playing: keep the musical position.
      const now = this.ctx.currentTime;
      const pos = this.rawPosition(now);
      const newPos = this.tl.rawTickToSec(oldTl.secToTick(pos));
      const newSched = this.tl.rawTickToSec(oldTl.secToTick(this.schedSong));
      this.segs.push({ ctx: now, song: newPos });
      this.schedSong = Math.max(newPos, newSched);
      this.untilSec = this.songEndSec();
      this.startBacking(now, newPos);
    }
  }

  applySynthMute(): void {
    if (!this.graph) return;
    const mute = !!this.backingBuffer && !this.song.synthsWithAudio;
    this.graph.synthBus.gain.value = mute ? 0 : 1;
  }

  songEndSec(): number {
    return this.timeline.rawTickToSec(songLengthTicks(this.song));
  }

  loopRange(): { start: number; end: number } | null {
    const l = this.song.loop;
    if (!l.enabled || this.exportMode || l.end <= l.start) return null;
    const tl = this.timeline;
    return { start: tl.rawTickToSec(l.start), end: tl.rawTickToSec(Math.min(l.end, songLengthTicks(this.song))) };
  }

  /** How far what you hear (or what the video recorder captures) lags the scheduling clock. */
  private latency(): number {
    if (!this.ctx) return 0;
    if (this.exportMode) return this.chainLatency;
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return Math.min(0.25, this.chainLatency + (c.outputLatency || 0) + (c.baseLatency || 0));
  }

  private rawPosition(ctxTime: number): number {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i];
      if (s.ctx <= ctxTime || i === 0) return s.song + Math.max(0, ctxTime - s.ctx);
    }
    return this.pausedAt;
  }

  /** Current song position in seconds (what you hear right now). */
  position(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    const first = this.segs[0];
    const t = this.ctx.currentTime - this.latency();
    if (t < first.ctx) return first.song;
    return this.rawPosition(t);
  }

  positionTicks(): number {
    return this.timeline.secToTick(this.position());
  }

  async play(from = this.pausedAt, until?: number): Promise<void> {
    const ctx = await this.unlock();
    await this.ensureKits();
    if (this.playing) this.halt();
    this.getEvents();
    const start = ctx.currentTime + 0.06;
    this.segs = [{ ctx: start, song: from }];
    this.schedSong = from;
    this.untilSec = until ?? this.songEndSec();
    this.stopCtx = null;
    this.playing = true;
    this.startBacking(start, from);
    this.pump();
    this.timer = window.setInterval(() => this.pump(), INTERVAL);
    this.onState?.();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.position();
    this.halt();
    this.onState?.();
  }

  stop(): void {
    this.halt();
    this.pausedAt = 0;
    this.onState?.();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(sec: number): void {
    const s = this.exportMode ? sec : Math.max(0, sec);
    if (this.playing) {
      void this.play(s);
    } else {
      this.pausedAt = s;
      this.onState?.();
    }
  }

  private halt(): void {
    clearInterval(this.timer);
    this.timer = 0;
    this.playing = false;
    if (this.ctx && this.sched) {
      const now = this.ctx.currentTime;
      this.sched.killAll(now);
      this.stopBacking(now);
    }
  }

  private pump(): void {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const events = this.getEvents();
    for (let guard = 0; guard < 16; guard++) {
      const seg = this.segs[this.segs.length - 1];
      const loop = this.loopRange();
      const looping = !!loop && seg.song < loop.end - 1e-4;
      const boundary = looping ? loop!.end : this.untilSec;
      const songAtHorizon = seg.song + (horizon - seg.ctx);
      const upTo = Math.min(songAtHorizon, boundary);
      if (upTo > this.schedSong) {
        this.scheduleRange(events, this.schedSong, upTo, seg);
        this.schedSong = upTo;
      }
      if (songAtHorizon < boundary) break;
      const boundaryCtx = seg.ctx + (boundary - seg.song);
      if (looping) {
        this.segs.push({ ctx: boundaryCtx, song: loop!.start });
        if (this.segs.length > 6) this.segs.splice(0, this.segs.length - 6);
        this.schedSong = loop!.start;
        this.startBacking(boundaryCtx, loop!.start);
        continue;
      }
      if (this.stopCtx === null) this.stopCtx = boundaryCtx;
      break;
    }
    if (this.stopCtx !== null && ctx.currentTime >= this.stopCtx) {
      const endPos = this.untilSec;
      this.halt();
      this.pausedAt = this.exportMode ? endPos : 0;
      this.onState?.();
      this.onEnded?.();
    }
  }

  private scheduleRange(events: SchedEvent[], from: number, to: number, seg: Segment): void {
    const sched = this.sched!;
    for (let i = lowerBound(events, from); i < events.length && events[i].t < to; i++) {
      const ev = events[i];
      const at = seg.ctx + (ev.t - seg.song);
      sched.play(ev.track, ev.note.pitch, ev.note.vel, at, Math.max(0.02, ev.end - ev.t), ev.glideFrom);
    }
    if (this.store.ui.metronome && !this.exportMode) this.scheduleClicks(from, to, seg);
  }

  private scheduleClicks(from: number, to: number, seg: Segment): void {
    const ctx = this.ctx!;
    const tl = this.timeline;
    let beat = Math.ceil(tl.secToTick(from) / PPQ - 1e-6);
    for (;;) {
      const sec = tl.rawTickToSec(beat * PPQ);
      if (sec >= to) break;
      if (sec >= from) {
        const at = seg.ctx + (sec - seg.song);
        const o = ctx.createOscillator();
        o.frequency.value = (beat * PPQ) % BAR === 0 ? 1760 : 1175;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.25, at + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
        o.connect(g).connect(ctx.destination);
        o.start(at);
        o.stop(at + 0.06);
      }
      beat++;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Backing audio (for syncing an existing song with imported MIDI)

  async loadBacking(file: File): Promise<number> {
    const ctx = await this.unlock();
    const data = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(data);
    this.backingBuffer = buf;
    this.backingName = file.name;
    this.backingPeaks = peakEnvelope(buf);
    this.applySynthMute();
    return buf.duration;
  }

  clearBacking(): void {
    if (this.ctx) this.stopBacking(this.ctx.currentTime);
    this.backingBuffer = null;
    this.backingName = '';
    this.backingPeaks = null;
    this.applySynthMute();
  }

  get backingVolume(): number {
    return this.backingVol;
  }

  set backingVolume(v: number) {
    this.backingVol = v;
    if (this.graph) this.graph.backing.gain.value = v;
  }

  private startBacking(ctxTime: number, songPos: number): void {
    this.stopBacking(ctxTime);
    const buf = this.backingBuffer;
    if (!buf || !this.ctx || !this.graph) return;
    const pos = songPos - this.song.audioOffset;
    if (pos >= buf.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.graph.backing);
    if (pos >= 0) src.start(ctxTime, pos);
    else src.start(ctxTime - pos, 0);
    this.backingSrcs.push(src);
  }

  private stopBacking(t: number): void {
    for (const s of this.backingSrcs) {
      try {
        s.stop(t);
      } catch {
        /* ignore */
      }
    }
    this.backingSrcs = [];
  }

  // -------------------------------------------------------------------------------------------
  // Live notes

  noteOn(track: Track, pitch: number, vel = 0.85): Voice | null {
    if (!this.ctx || !this.sched) {
      void this.unlock();
      return null;
    }
    if (track.kind === 'drums' && !this.kits.has(track.instrument)) void this.ensureKits();
    return this.sched.play(track, pitch, vel, this.ctx.currentTime + 0.005, null);
  }

  preview(track: Track, pitch: number, vel = 0.8, dur = 0.28): void {
    if (!this.ctx || !this.sched) {
      void this.unlock().then(() => this.preview(track, pitch, vel, dur));
      return;
    }
    if (track.kind === 'drums' && !this.kits.has(track.instrument)) {
      void this.ensureKits().then(() => this.sched?.play(track, pitch, vel, this.ctx!.currentTime + 0.005, dur));
      return;
    }
    this.sched.play(track, pitch, vel, this.ctx.currentTime + 0.005, dur);
  }

  /** Low-frequency energy 0..1 for audio-reactive visuals. */
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  spectrum(): Uint8Array<ArrayBuffer> | null {
    if (!this.analyser) return null;
    if (!this.freqData || this.freqData.length !== this.analyser.frequencyBinCount) {
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  private waveData: Uint8Array<ArrayBuffer> | null = null;
  waveform(): Uint8Array<ArrayBuffer> | null {
    if (!this.analyser) return null;
    if (!this.waveData) this.waveData = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(this.waveData);
    return this.waveData;
  }
}
