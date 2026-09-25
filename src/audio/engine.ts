import { AbMeter } from './abmeter';
import type { Store } from '../core/store';
import { Timeline } from '../core/timing';
import { BAR, PPQ, songLengthTicks, type Song, type Track } from '../core/types';
import { KIT_BY_ID, loadKit } from './drums';
import { buildEvents, Graph, graphLatency, lowerBound, NoteScheduler, type KitBuffers, type SchedEvent } from './graph';
import type { Voice } from './instruments';
import { ensureSamplerFiles } from './sampler';
import { ensureSongSamples } from './samples';
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
  /** Whether play() was given an explicit end (exports), so length edits don't move it. */
  private untilExplicit = false;
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
  /**
   * A/B listening: hear only the original or only the remake while both keep playing in sync
   * ('off' = the usual: both, or the original alone when the song's tracks are switched off).
   */
  ab: 'off' | 'original' | 'remake' = 'off';
  /** While comparing, bring the original to the remake's loudness so only the sound differs. */
  abMatch = true;
  meter: AbMeter | null = null;
  private abGainDb = 0;

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
      this.meter = new AbMeter(ctx, graph.mixTap, graph.backing);
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

  /**
   * Load drum kits and the recorded samples the song uses. Live playback waits at most a few
   * seconds for recordings (synthesized stand-ins cover the rest until they arrive); exports wait
   * for everything.
   */
  ensureKits(sampleWait = 4): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const wait = (p: Promise<void>) => (sampleWait === Infinity ? p : Promise.race([p, new Promise<void>((r) => setTimeout(r, sampleWait * 1000))]));
    return Promise.all([this.loadStandIns(), wait(this.loadKits()), wait(ensureSongSamples(this.song.tracks)), ensureSamplerFiles(this.song.tracks)]).then(() => undefined);
  }

  /** Give recorded kits that are still downloading their synthesized fallback voices meanwhile. */
  private loadStandIns(): Promise<void> {
    const rate = this.ctx!.sampleRate;
    const ids = new Set(this.song.tracks.filter((t) => t.kind === 'drums' && !this.kits.has(t.instrument)).map((t) => t.instrument));
    return Promise.all(
      [...ids].map((id) => {
        const fb = KIT_BY_ID.get(id)?.fallback;
        if (!fb) return undefined;
        return loadKit(fb, rate).then((bufs) => {
          if (!this.kits.has(id)) this.kits.set(id, bufs);
        });
      }),
    ).then(() => undefined);
  }

  private loadKits(): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const rate = this.ctx.sampleRate;
    const ids = new Set(this.song.tracks.filter((t) => t.kind === 'drums').map((t) => t.instrument));
    // loadKit is cached; asking again picks up a kit that was re-registered or is due a retry.
    return Promise.all(
      [...ids].map((id) =>
        loadKit(id, rate).then((bufs) => {
          this.kits.set(id, bufs);
        }),
      ),
    ).then(() => undefined);
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
      this.graph.applyMix(this.song, true, this.playing ? null : this.timeline.secToTick(Math.max(0, this.pausedAt)));
      this.applySynthMute();
      void this.ensureKits();
    }
    if (this.playing && oldKey !== this.tlKey && this.ctx) {
      // Tempo or swing changed while playing: keep the musical position. Anchor after any segment
      // that is already queued (a loop wrap in the next few ms) so nothing is scheduled twice.
      const at = Math.max(this.ctx.currentTime, this.segs[this.segs.length - 1].ctx);
      const pos = this.rawPosition(at);
      const newPos = this.tl.rawTickToSec(oldTl.secToTick(pos));
      // Notes are scheduled up to a note tick, not a time: map that tick through both swing warps
      // so no note is repeated (swing up) or skipped (swing down).
      const noteTick = oldTl.unswingTick(oldTl.secToTick(this.schedSong));
      const newSched = this.tl.tickToSec(noteTick);
      this.segs.push({ ctx: at, song: newPos });
      this.schedSong = Math.max(newPos, newSched);
      if (!this.untilExplicit) this.untilSec = this.songEndSec();
      this.startBacking(at, newPos);
    } else if (this.playing && !this.untilExplicit) {
      // Length changed while playing: follow the new end of the song.
      const end = this.songEndSec();
      if (end > this.untilSec) this.stopCtx = null;
      this.untilSec = end;
    }
  }

  applySynthMute(): void {
    const g = this.graph;
    if (!g) return;
    const ab = this.backingBuffer ? this.ab : 'off';
    // Comparing keeps the song's tracks running (and metered) even while only the original is heard.
    const mute = !!this.backingBuffer && !this.song.synthsWithAudio && ab === 'off';
    g.synthBus.gain.value = mute ? 0 : 1;
    const t = g.ctx.currentTime;
    const refDb = ab === 'original' && this.abMatch ? this.abGainDb : 0;
    g.mixGate.gain.setTargetAtTime(ab === 'original' ? 0 : 1, t, 0.008);
    g.refGate.gain.setTargetAtTime(ab === 'remake' ? 0 : Math.pow(10, refDb / 20), t, 0.008);
  }

  /** Switch A/B listening (see `ab`). */
  setAb(mode: 'off' | 'original' | 'remake'): void {
    this.ab = this.backingBuffer ? mode : 'off';
    this.applySynthMute();
    this.onState?.();
  }

  /** Run from the UI's animation frame: feeds the A/B meter and follows the loudness match. */
  abFrame(): void {
    const m = this.meter;
    if (!m || !this.backingBuffer) return;
    m.update(this.playing && !this.exportMode);
    const db = m.matchDb();
    if (db === null) return;
    const next = Math.max(-12, Math.min(12, db));
    if (Math.abs(next - this.abGainDb) < 0.1) return;
    this.abGainDb = next;
    if (this.ab === 'original') this.applySynthMute();
  }

  /** The dB the original is moved by to match the remake's loudness (null until measured). */
  abMatchDb(): number | null {
    return this.meter?.matchDb() ?? null;
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
    this.untilExplicit = until !== undefined;
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
    this.restMix();
    this.onState?.();
  }

  stop(): void {
    this.halt();
    this.pausedAt = 0;
    this.restMix();
    this.onState?.();
  }

  /** Stopped: automated settings sit at their value under the playhead. */
  private restMix(): void {
    this.graph?.applyMix(this.song, true, this.timeline.secToTick(Math.max(0, this.pausedAt)));
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
      // Only wrap if the playhead has not passed the loop end yet: turning the loop on (or moving
      // its end) behind the playhead plays on to the end instead of wrapping into the past.
      const looping = !!loop && seg.song < loop.end - 1e-4 && this.schedSong <= loop.end + 1e-6;
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
      this.restMix();
      this.onState?.();
      this.onEnded?.();
    }
  }

  private scheduleRange(events: SchedEvent[], from: number, to: number, seg: Segment): void {
    const sched = this.sched!;
    const now = this.ctx!.currentTime;
    for (let i = lowerBound(events, from); i < events.length && events[i].t < to; i++) {
      const ev = events[i];
      const at = seg.ctx + (ev.t - seg.song);
      // After a long main-thread stall, drop notes that are well overdue rather than firing a burst.
      if (at < now - 0.05) continue;
      try {
        sched.play(ev.track, ev.note.pitch, ev.note.vel, Math.max(at, now), Math.max(0.02, ev.end - ev.t), ev.glideFrom);
      } catch (e) {
        // One bad voice must not stall the scheduler (it would re-schedule this range forever).
        console.warn('Could not schedule a note', e);
      }
    }
    // Automation, as one continuous curve per lane across these chunks.
    const first = Math.abs(from - seg.song) < 1e-9;
    for (const t of this.song.tracks) {
      if (t.automation) this.graph!.automate(t, this.song, this.timeline, from, to, (sec) => seg.ctx + (sec - seg.song), first);
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
    this.meter?.reset();
    this.abGainDb = 0;
    this.applySynthMute();
    return buf.duration;
  }

  clearBacking(): void {
    if (this.ctx) this.stopBacking(this.ctx.currentTime);
    this.backingBuffer = null;
    this.backingName = '';
    this.backingPeaks = null;
    this.ab = 'off';
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
    return this.sched.play(track, pitch, vel, this.ctx.currentTime + 0.005, null, undefined, true);
  }

  preview(track: Track, pitch: number, vel = 0.8, dur = 0.28): void {
    if (!this.ctx || !this.sched) {
      void this.unlock().then(() => this.preview(track, pitch, vel, dur));
      return;
    }
    if (track.kind === 'drums' && !this.kits.has(track.instrument)) {
      // Don't hold a preview back for a download: a stand-in voice is fine for a click.
      void this.ensureKits(0).then(() => this.sched?.play(track, pitch, vel, this.ctx!.currentTime + 0.005, dur, undefined, true));
      return;
    }
    this.sched.play(track, pitch, vel, this.ctx.currentTime + 0.005, dur, undefined, true);
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
