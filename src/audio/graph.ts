import { AUTO_PARAMS, lanes, valueAt, type AutoParamDef } from '../core/automation';
import { Timeline } from '../core/timing';
import { DUCK_RELEASE, HPF_OFF, LPF_OFF, type Note, type Song, type Track } from '../core/types';
import { EQ_BANDS } from './analyze';
import { instrumentFor, type Voice } from './instruments';
import { playSampler } from './sampler';

export interface TrackBus {
  input: GainNode;
  /** Tone: low cut → high cut → low shelf → mid bell → high shelf. */
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  /** Sidechain gain, pulled down on every kick. */
  duck: GainNode;
  vol: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
  echo: GainNode;
  duckDb: number;
  duckRelease: number;
}

const AUTO_DEF = Object.fromEntries(AUTO_PARAMS.map((d) => [d.id, d])) as Record<AutoParamDef['id'], AutoParamDef>;

/** GM kick drums: they trigger sidechain ducking. */
const KICKS = new Set([35, 36]);

export interface SchedEvent {
  /** Song time in seconds. */
  t: number;
  end: number;
  track: Track;
  note: Note;
  glideFrom?: number;
}

const impulseCache = new Map<string, AudioBuffer>();

function makeImpulse(ctx: BaseAudioContext, seconds = 2.4, decay = 3.2): AudioBuffer {
  const key = `${ctx.sampleRate}:${seconds}`;
  const cached = impulseCache.get(key);
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
  impulseCache.set(key, buf);
  return buf;
}

const latencyCache = new Map<number, Promise<number>>();

/**
 * Seconds of delay through the master chain: the compressor and limiter look ahead (about 6 ms
 * each in current browsers). Measured once per sample rate by rendering an impulse.
 */
export function graphLatency(sampleRate: number): Promise<number> {
  let p = latencyCache.get(sampleRate);
  if (!p) {
    p = (async () => {
      const len = Math.ceil(sampleRate * 0.1);
      const ctx = new OfflineAudioContext(1, len, sampleRate);
      const g = new Graph(ctx);
      g.out.connect(ctx.destination);
      const imp = ctx.createBuffer(1, 1, sampleRate);
      imp.getChannelData(0)[0] = 0.5;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(g.masterIn);
      src.start(0);
      const d = (await ctx.startRendering()).getChannelData(0);
      let i = 0;
      while (i < d.length && Math.abs(d[i]) < 1e-5) i++;
      return i < d.length ? i / sampleRate : 0;
    })().catch(() => 0);
    latencyCache.set(sampleRate, p);
  }
  return p;
}

/** The mixer graph: track buses → synth bus → master chain. Works for live and offline contexts. */
export class Graph {
  readonly masterIn: GainNode;
  readonly synthBus: GainNode;
  readonly backing: GainNode;
  readonly out: GainNode;
  /** A/B switches: the remake (after the master compressor) and the reference, just before the limiter. */
  readonly mixGate: GainNode;
  readonly refGate: GainNode;
  /** Where to measure each side for A/B (before its switch, so the silent side can still be metered). */
  readonly mixTap: AudioNode;
  readonly reverbIn: GainNode;
  readonly echoIn: GainNode;
  readonly buses = new Map<string, TrackBus>();
  /** Master chain for the song's own tracks: graphic EQ → stereo width → output gain. */
  private readonly eq: BiquadFilterNode[] = [];
  private readonly widthGains: { same: GainNode[]; cross: GainNode[] };
  private readonly trim: GainNode;
  private readonly conv: ConvolverNode;
  private reverbSize = 2.4;
  /** Song tuning in semitones, added to every synth note. */
  tuning = 0;
  /** Song tempo (loops in the sampler are stretched to it). */
  bpm = 120;
  private readonly echoDelay: DelayNode;

  /** `dynamics: false` leaves out the master compressor and limiter (for stems that add up to the mix). */
  constructor(
    readonly ctx: BaseAudioContext,
    opts: { dynamics?: boolean } = {},
  ) {
    this.masterIn = ctx.createGain();
    this.masterIn.gain.value = 0.9;
    this.synthBus = ctx.createGain();
    // Master chain for the remake only (the reference audio bypasses it).
    let node: AudioNode = this.synthBus;
    EQ_BANDS.forEach((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = i === 0 ? 45 : i === EQ_BANDS.length - 1 ? 11000 : f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      node.connect(b);
      node = b;
      this.eq.push(b);
    });
    // Width as a 2x2 matrix: L' = aL + bR, R' = aR + bL with a = (1+w)/2, b = (1-w)/2.
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const same = [ctx.createGain(), ctx.createGain()];
    const cross = [ctx.createGain(), ctx.createGain()];
    node.connect(split);
    split.connect(same[0], 0).connect(merge, 0, 0);
    split.connect(cross[0], 1).connect(merge, 0, 0);
    split.connect(same[1], 1).connect(merge, 0, 1);
    split.connect(cross[1], 0).connect(merge, 0, 1);
    same.forEach((g) => (g.gain.value = 1));
    cross.forEach((g) => (g.gain.value = 0));
    this.widthGains = { same, cross };
    this.trim = ctx.createGain();
    merge.connect(this.trim).connect(this.masterIn);
    // The reference is already mastered: it skips the song's compressor (which would also pump the
    // remake with the reference's kicks) and only meets the final limiter.
    this.backing = ctx.createGain();
    this.mixGate = ctx.createGain();
    this.refGate = ctx.createGain();
    this.backing.connect(this.refGate);

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
    if (opts.dynamics === false) {
      this.masterIn.connect(this.mixGate).connect(this.out);
      this.refGate.connect(this.out);
      this.mixTap = this.masterIn;
    } else {
      this.masterIn.connect(comp).connect(this.mixGate).connect(limiter).connect(this.out);
      this.refGate.connect(limiter);
      this.mixTap = comp;
    }

    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx);
    this.conv = conv;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbIn.connect(hp).connect(conv).connect(wet).connect(this.synthBus);

    // Tempo-synced echo: a darkened feedback delay, shared by all tracks through their echo sends.
    this.echoIn = ctx.createGain();
    this.echoDelay = ctx.createDelay(4);
    this.echoDelay.delayTime.value = 0.35;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 4500;
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    lowCut.frequency.value = 250;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    this.echoIn.connect(this.echoDelay).connect(tone).connect(lowCut);
    lowCut.connect(fb).connect(this.echoDelay);
    lowCut.connect(this.synthBus);
  }

  bus(track: Track): TrackBus {
    let b = this.buses.get(track.id);
    if (!b) {
      const ctx = this.ctx;
      const input = ctx.createGain();
      const filter = (type: BiquadFilterType, f: number) => {
        const n = ctx.createBiquadFilter();
        n.type = type;
        n.frequency.value = f;
        n.gain.value = 0;
        return n;
      };
      // Open filters (0 Hz high-pass, Nyquist low-pass) and 0 dB shelves are exact pass-throughs.
      const hp = filter('highpass', 0);
      hp.Q.value = -3; // Butterworth (Q is in dB for these two)
      const lp = filter('lowpass', ctx.sampleRate / 2);
      lp.Q.value = -3;
      const low = filter('lowshelf', 150);
      const mid = filter('peaking', 1000);
      mid.Q.value = 0.9;
      const high = filter('highshelf', 6000);
      const duck = ctx.createGain();
      const vol = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const send = ctx.createGain();
      const echo = ctx.createGain();
      echo.gain.value = 0;
      input.connect(hp).connect(lp).connect(low).connect(mid).connect(high).connect(duck).connect(vol).connect(pan).connect(this.synthBus);
      pan.connect(send).connect(this.reverbIn);
      pan.connect(echo).connect(this.echoIn);
      b = { input, hp, lp, low, mid, high, duck, vol, pan, send, echo, duckDb: 0, duckRelease: DUCK_RELEASE };
      this.buses.set(track.id, b);
    }
    return b;
  }

  /**
   * Apply volume / pan / sends / mute / solo for all tracks, plus the song's tuning and echo time.
   * Automated settings: `autoTick` null (playing) leaves them to the automation scheduler; a tick
   * sets them to their automated value there.
   */
  applyMix(song: Song, smooth = true, autoTick: number | null = 0): void {
    const anySolo = song.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    this.tuning = (song.tuning ?? 0) / 100;
    this.bpm = song.bpm;
    const m = song.master;
    if (m) {
      const set = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, now, 0.03) : (p.value = v));
      this.eq.forEach((b, i) => set(b.gain, m.eq[i] ?? 0));
      const w = Math.max(0, m.width);
      for (const g of this.widthGains.same) set(g.gain, (1 + w) / 2);
      for (const g of this.widthGains.cross) set(g.gain, (1 - w) / 2);
      set(this.trim.gain, Math.pow(10, m.gain / 20));
      if (Math.abs(m.reverbSize - this.reverbSize) > 0.05) {
        this.reverbSize = m.reverbSize;
        this.conv.buffer = makeImpulse(this.ctx, Math.round(m.reverbSize * 10) / 10);
      }
    }
    const echoTime = Math.min(4, ((song.echoBeats ?? 0.75) * 60) / song.bpm);
    if (smooth) this.echoDelay.delayTime.setTargetAtTime(echoTime, now, 0.05);
    else this.echoDelay.delayTime.value = echoTime;
    const nyquist = this.ctx.sampleRate / 2;
    const set = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, now, 0.015) : (p.value = v));
    // An open filter jumps straight to its exact pass-through value (easing towards 0 Hz never lands).
    const snap = (p: AudioParam, v: number) => {
      p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
    };
    for (const t of song.tracks) {
      const b = this.bus(t);
      const audible = !t.mute && (!anySolo || t.solo);
      const auto = t.automation;
      /** The setting's value now: its automation at `autoTick`, else the track's own. */
      const val = (id: keyof NonNullable<Track['automation']>, own: number): number | null => {
        const pts = auto?.[id];
        if (!pts?.length) return own;
        if (autoTick === null) return null;
        return valueAt(AUTO_DEF[id], pts, autoTick);
      };
      // A param may have automation ramps queued ahead (also just after its lane was cleared or
      // undone): drop them whenever a fixed value is set, or they would win over it.
      const put = (p: AudioParam, v: number | null) => {
        if (v === null) return;
        if (smooth) p.cancelScheduledValues(now);
        set(p, v);
      };
      const vol = val('volume', t.volume);
      put(b.vol.gain, audible ? vol : 0);
      put(b.pan.pan, val('pan', t.pan));
      put(b.send.gain, val('reverb', t.reverb));
      put(b.echo.gain, val('echo', t.echo ?? 0));
      const hpf = val('hpf', t.hpf ?? HPF_OFF);
      const lpf = val('lpf', t.lpf ?? LPF_OFF);
      // Open filters are exact pass-throughs: 0 Hz high-pass, Nyquist low-pass (automated ones
      // use 1 Hz, as their exponential ramps can't reach 0).
      if (hpf !== null) {
        if (hpf > HPF_OFF) put(b.hp.frequency, hpf);
        else if (auto?.hpf?.length) put(b.hp.frequency, 1);
        else snap(b.hp.frequency, 0);
      }
      if (lpf !== null) {
        if (lpf < LPF_OFF) put(b.lp.frequency, Math.min(lpf, nyquist));
        else snap(b.lp.frequency, nyquist);
      }
      set(b.lp.Q, -3 + (t.res ?? 0) * 19);
      set(b.low.gain, t.eqLow ?? 0);
      set(b.mid.gain, t.eqMid ?? 0);
      set(b.mid.frequency, t.eqMidFreq ?? 1000);
      set(b.high.gain, t.eqHigh ?? 0);
      const duck = t.duck ?? 0;
      if (duck <= 0 && b.duckDb > 0) {
        // Ducking switched off: drop the dips already queued.
        b.duck.gain.cancelScheduledValues(now);
        b.duck.gain.setTargetAtTime(1, now, 0.01);
      }
      b.duckDb = duck;
      b.duckRelease = t.duckRelease ?? DUCK_RELEASE;
    }
  }

  /**
   * Dip every ducked track (except the kick's own) at context time `at`, like a sidechain
   * compressor: a fast attack, a short hold, then a swell back that is linear in dB over the
   * release time. The swell is a chain of setTarget steps rather than a ramp or value curve, so a
   * kick that lands mid-swell can cancel the steps still to come without touching the running one.
   */
  duckAt(sourceId: string, at: number, vel: number): void {
    const STEPS = 4;
    for (const [id, b] of this.buses) {
      if (id === sourceId || b.duckDb <= 0) continue;
      const g = b.duck.gain;
      const depth = b.duckDb * Math.min(1, vel / 0.6);
      const rel = b.duckRelease;
      g.cancelScheduledValues(at);
      g.setTargetAtTime(Math.pow(10, -depth / 20), at, 0.002);
      const hold = at + Math.min(0.03, rel * 0.1);
      for (let k = 0; k < STEPS; k++) {
        g.setTargetAtTime(Math.pow(10, (-depth * (1 - (k + 1) / STEPS)) / 20), hold + (k * rel) / STEPS, rel / STEPS / 2.5);
      }
    }
  }

  /**
   * Schedule a track's automation for song time [from, to] (seconds), mapped to context time by
   * `ctxOf`. `first`: this starts a new playback segment, so jump to the value at `from`. Each call
   * ramps through the breakpoints inside the range and on to the value at `to`, so a lane plays as
   * one continuous curve however the scheduler slices time.
   */
  automate(track: Track, song: Song, tl: Timeline, from: number, to: number, ctxOf: (sec: number) => number, first: boolean): void {
    const b = this.bus(track);
    const audible = !track.mute && (!song.tracks.some((t) => t.solo) || track.solo);
    const nyquist = this.ctx.sampleRate / 2;
    const t0 = tl.secToTick(from);
    const t1 = tl.secToTick(to);
    for (const [def, pts] of lanes(track)) {
      const p = this.autoParam(b, def.id);
      const map = (v: number) => {
        if (def.id === 'volume') return audible ? v : 0;
        // "Open" is transparent: Nyquist for the high cut, 1 Hz for the low cut.
        if (def.id === 'lpf') return v >= LPF_OFF ? nyquist : Math.min(v, nyquist);
        if (def.id === 'hpf') return v <= HPF_OFF ? 1 : v;
        return v;
      };
      const ramp = (v: number, at: number) => {
        if (def.log) p.exponentialRampToValueAtTime(Math.max(1, map(v)), at);
        else p.linearRampToValueAtTime(map(v), at);
      };
      if (first) {
        p.cancelScheduledValues(ctxOf(from));
        p.setValueAtTime(map(valueAt(def, pts, t0)), ctxOf(from));
      }
      for (const pt of pts) if (pt.tick > t0 && pt.tick <= t1) ramp(pt.value, ctxOf(tl.rawTickToSec(pt.tick)));
      ramp(valueAt(def, pts, t1), ctxOf(to));
    }
  }

  private autoParam(b: TrackBus, id: AutoParamDef['id']): AudioParam {
    switch (id) {
      case 'volume':
        return b.vol.gain;
      case 'pan':
        return b.pan.pan;
      case 'lpf':
        return b.lp.frequency;
      case 'hpf':
        return b.hp.frequency;
      case 'reverb':
        return b.send.gain;
      case 'echo':
        return b.echo.gain;
    }
  }

  /** Cancel all queued ducking (stop / seek). */
  resetDucks(t: number): void {
    for (const b of this.buses.values()) {
      b.duck.gain.cancelScheduledValues(t);
      b.duck.gain.setTargetAtTime(1, t, 0.01);
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
  /** Sampler tracks in slice or loop mode: the last chop, cut off by the next one. */
  private chops = new Map<string, { voice: Voice; t: number }>();
  private active: Playing[] = [];

  constructor(
    readonly graph: Graph,
    readonly kits: KitBuffers,
  ) {}

  /** Schedule one event at absolute context time `at`, for `dur` seconds. */
  /** `live`: a key or pad played by hand (or a preview), which must not disturb queued ducking. */
  play(track: Track, pitch: number, vel: number, at: number, dur: number | null, glideFrom?: number, live = false): Voice | null {
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
      // Ducking follows the song's kicks; a kick played by hand would cancel the dips queued ahead.
      if (KICKS.has(pitch) && !track.mute && !live) this.graph.duckAt(track.id, at, vel);
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
    const tune = this.graph.tuning + (track.tune ?? 0) / 100;
    if (track.instrument === 'sampler') {
      const s = track.sampler;
      if (!s) return null;
      // Slices are keys, not pitches: tuning only bends the pitched mode.
      const voice = playSampler(ctx, bus.input, s, { time: at, pitch: s.mode === 'pitch' ? pitch + tune : pitch, dur, vel }, this.graph.bpm);
      if (!voice) return null;
      if (s.mode !== 'pitch') {
        const prev = this.chops.get(track.id);
        if (prev && prev.t < at) prev.voice.kill(at);
        this.chops.set(track.id, { voice, t: at });
      }
      this.track(voice, dur === null ? Infinity : at + dur + 4);
      return voice;
    }
    const inst = instrumentFor(track.instrument);
    const from = glideFrom === undefined ? undefined : glideFrom + tune;
    const tail = track.release ?? 0;
    if (tail <= 0) {
      const voice = inst.build(ctx, bus.input, { time: at, pitch: pitch + tune, dur, vel, glideFrom: from });
      this.track(voice, dur === null ? Infinity : at + dur + 4);
      return voice;
    }
    // A shorter tail than the instrument's own: fade the note out on a gain of its own once it ends
    // (about -43 dB after `tail` seconds).
    const cut = ctx.createGain();
    cut.connect(bus.input);
    const inner = inst.build(ctx, cut, { time: at, pitch: pitch + tune, dur, vel, glideFrom: from });
    let faded = false;
    const fade = (t: number) => {
      if (faded) return;
      faded = true;
      cut.gain.setTargetAtTime(0, Math.max(t, at), tail / 5);
    };
    if (dur !== null) fade(at + dur);
    const voice: Voice = {
      release: (t) => {
        inner.release(t);
        fade(t);
      },
      kill: (t) => inner.kill(t),
    };
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
    this.chops.clear();
    this.graph.resetDucks(t);
  }
}
