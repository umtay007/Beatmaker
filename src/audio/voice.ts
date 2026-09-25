import { midiToFreq } from '../core/theory';

/**
 * Building blocks for synthesized voices, shared by every instrument module.
 */

export interface VoiceArgs {
  time: number;
  pitch: number;
  /** Seconds. `null` = held until release() is called (live keyboard play). */
  dur: number | null;
  vel: number;
  /** For mono instruments: slide from this pitch (legato). */
  glideFrom?: number;
}

export interface Voice {
  release(t: number): void;
  kill(t: number): void;
}


type Src = OscillatorNode | AudioBufferSourceNode;

export class VoiceKit {
  readonly rel: GainNode;
  readonly srcs: Src[] = [];
  released = false;
  private freqParams: { p: AudioParam; ratio: number }[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    out: AudioNode,
    readonly a: VoiceArgs,
    readonly releaseTau: number,
    readonly glideTime = 0.07,
  ) {
    this.rel = ctx.createGain();
    this.rel.gain.value = 1;
    this.rel.connect(out);
  }

  get f(): number {
    return midiToFreq(this.a.pitch);
  }

  osc(type: OscillatorType, ratio = 1, detune = 0, wave?: PeriodicWave): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    else o.type = type;
    o.detune.value = detune;
    if (this.f * ratio >= this.ctx.sampleRate * 0.49) {
      // A partial above the Nyquist limit would alias (or be clamped): leave it silent.
      o.frequency.value = 0;
      if (type !== 'sine') o.type = 'sine';
    } else this.freq(o.frequency, ratio);
    o.start(this.a.time);
    this.srcs.push(o);
    return o;
  }

  /** Set a frequency param to the note frequency × ratio, sliding from glideFrom when legato. */
  freq(p: AudioParam, ratio = 1): void {
    const t = this.a.time;
    const target = this.f * ratio;
    if (this.a.glideFrom !== undefined && this.a.glideFrom !== this.a.pitch) {
      p.setValueAtTime(midiToFreq(this.a.glideFrom) * ratio, t);
      p.exponentialRampToValueAtTime(target, t + this.glideTime);
    } else {
      p.setValueAtTime(target, t);
    }
    this.freqParams.push({ p, ratio });
  }

  noise(): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = noiseBuf(this.ctx);
    n.loop = true;
    n.start(this.a.time, Math.random());
    this.srcs.push(n);
    return n;
  }

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Attack → decay to sustain envelope on a gain param. */
  adsr(p: AudioParam, attack: number, decayTau: number, sustain: number, peak = 1, delay = 0): void {
    const t = this.a.time + delay;
    p.setValueAtTime(0, this.a.time);
    if (delay > 0) p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setTargetAtTime(peak * sustain, t + attack, decayTau);
  }

  /** A stereo position inside the voice (for wide, chorus-like instruments). */
  panned(value: number): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = value;
    p.connect(this.rel);
    return p;
  }

  /** LFO → param (depth in param units). */
  lfo(p: AudioParam, rate: number, depth: number, delay = 0, type: OscillatorType = 'sine'): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, this.a.time);
    g.gain.linearRampToValueAtTime(depth, this.a.time + delay + 0.05);
    o.connect(g).connect(p);
    o.start(this.a.time);
    this.srcs.push(o);
  }

  finish(): Voice {
    const voice: Voice = {
      release: (t: number) => {
        if (this.released) return;
        this.released = true;
        const at = Math.max(t, this.a.time + 0.005);
        this.rel.gain.setTargetAtTime(0, at, this.releaseTau);
        this.stopAll(at + this.releaseTau * 7 + 0.02);
      },
      kill: (t: number) => {
        this.released = true;
        this.rel.gain.cancelScheduledValues(t);
        this.rel.gain.setValueAtTime(this.rel.gain.value, t);
        this.rel.gain.setTargetAtTime(0, t, 0.008);
        this.stopAll(t + 0.08);
      },
    };
    if (this.a.dur !== null) voice.release(this.a.time + Math.max(0.01, this.a.dur));
    return voice;
  }

  private stopAll(t: number): void {
    for (const s of this.srcs) {
      try {
        s.stop(t);
      } catch {
        /* already stopped */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shared resources

const noiseBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
export function noiseBuf(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBufs.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(ctx, b);
  }
  return b;
}

const waves = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
export function wave(ctx: BaseAudioContext, name: string, harmonics: number[]): PeriodicWave {
  let m = waves.get(ctx);
  if (!m) waves.set(ctx, (m = new Map()));
  let w = m.get(name);
  if (!w) {
    const real = new Float32Array(harmonics.length);
    const imag = new Float32Array(harmonics);
    w = ctx.createPeriodicWave(real, imag);
    m.set(name, w);
  }
  return w;
}

export function pulseHarmonics(duty: number, n = 32): number[] {
  const h = [0];
  for (let k = 1; k < n; k++) h.push((2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty));
  return h;
}

/** Seconds covered by gaussDecay(): long enough to reach silence for tau up to ~0.6 s. */
export const GAUSS_LEN = 1.6;
/** Gain curve: a 3 ms attack, then peak * exp(-(t / tau)^2). */
export function gaussDecay(peak: number, tau: number): Float32Array<ArrayBuffer> {
  const n = 512;
  const c = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const t = (i / (n - 1)) * GAUSS_LEN;
    c[i] = peak * Math.exp(-((t / tau) ** 2));
  }
  return c;
}

const curves = new Map<number, Float32Array<ArrayBuffer>>();
export function drive(ctx: BaseAudioContext, amount: number): WaveShaperNode {
  let c = curves.get(amount);
  if (!c) {
    c = new Float32Array(2048);
    const norm = Math.tanh(amount);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(amount * x) / norm;
    }
    curves.set(amount, c);
  }
  const s = ctx.createWaveShaper();
  s.curve = c;
  s.oversample = '2x';
  return s;
}
