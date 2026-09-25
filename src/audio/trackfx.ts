/**
 * Per-track colour effects, inserted after the track's EQ: saturation → lo-fi → compressor →
 * chorus → tape wobble → stereo width. Only the effects that are switched on are built, so a
 * plain track stays a plain chain; changing an amount moves parameters instead of rebuilding.
 */
import type { TrackFx } from '../core/types';

export const FX_IDS = ['saturation', 'lofi', 'comp', 'chorus', 'wobble', 'width'] as const;
export type FxId = (typeof FX_IDS)[number];

/** Which effects are on (the chain's shape); amounts don't change it. */
export function fxShape(fx: TrackFx | undefined): string {
  if (!fx) return '';
  return FX_IDS.filter((id) => isOn(fx, id)).join(',');
}

function isOn(fx: TrackFx, id: FxId): boolean {
  const v = fx[id];
  if (v === undefined) return false;
  return id === 'width' ? Math.abs(v - 1) > 0.01 : v > 0.001;
}

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  update(fx: TrackFx, smooth: boolean): void;
  /** Stop its oscillators (the chain is being replaced). */
  dispose(): void;
}

/** tanh(kx)/k: unity gain for quiet signals, rounding off everything above about 1/k. */
function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const k = 1 + drive * 15;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / k;
  }
  return c;
}

/** A staircase: the signal rounded to 2^bits levels. */
function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const steps = Math.pow(2, bits) / 2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * steps) / steps;
  }
  return c;
}

export function buildFx(ctx: BaseAudioContext, fx: TrackFx): FxChain {
  const oscs: OscillatorNode[] = [];
  const updaters: ((fx: TrackFx, set: (p: AudioParam, v: number) => void) => void)[] = [];
  const input = ctx.createGain();
  // Mono parts are spread to both channels first, or the per-side effects would leave one silent.
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  let node: AudioNode = input;
  const lfo = (freq: number, type: OscillatorType = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start();
    oscs.push(o);
    return o;
  };

  if (isOn(fx, 'saturation')) {
    // The curve keeps quiet parts at their level, so more drive means denser peaks, not a louder
    // track. It sits before the fader, where a stack of full-scale samples runs well over 0 dB:
    // pad into it by 12 dB and back out, or it would clip rather than saturate.
    const pad = ctx.createGain();
    pad.gain.value = 0.25;
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    const unpad = ctx.createGain();
    node.connect(pad).connect(shaper).connect(unpad);
    node = unpad;
    let lastDrive = -1;
    updaters.push((f, set) => {
      const d = f.saturation ?? 0;
      if (Math.abs(d - lastDrive) > 0.02) {
        shaper.curve = tanhCurve(d);
        lastDrive = d;
      }
      // Rounded-off peaks lower the level a little; give some of it back.
      set(unpad.gain, 4 * (1 + 0.6 * d));
    });
  }

  if (isOn(fx, 'lofi')) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    const crush = ctx.createWaveShaper();
    node.connect(hp).connect(crush).connect(lp);
    node = lp;
    let lastBits = -1;
    updaters.push((f, set) => {
      const a = f.lofi ?? 0;
      // Narrower band and fewer bits as it goes: a cheap sampler, then a worn cassette.
      set(hp.frequency, 60 + 240 * a);
      set(lp.frequency, 14000 * Math.pow(2600 / 14000, a));
      const bits = a < 0.25 ? 0 : Math.round(10 - 6 * a);
      if (bits !== lastBits) {
        crush.curve = bits ? crushCurve(bits) : null;
        lastBits = bits;
      }
    });
  }

  if (isOn(fx, 'comp')) {
    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.12;
    const makeup = ctx.createGain();
    node.connect(comp).connect(makeup);
    node = makeup;
    updaters.push((f, set) => {
      const a = f.comp ?? 0;
      const thr = -6 - 24 * a;
      const ratio = 2 + 6 * a;
      set(comp.threshold, thr);
      set(comp.ratio, ratio);
      // A track's peaks sit well under 0 dB, so give back only part of the reduction a full-scale
      // signal would get: about what a part that hits the threshold loses.
      set(makeup.gain, Math.pow(10, (-thr * (1 - 1 / ratio) * 0.2) / 20));
    });
  }

  if (isOn(fx, 'chorus')) {
    // Two delay lines swept in opposite directions, one per side, blended under the dry signal.
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const sum = ctx.createGain();
    const osc = lfo(0.8);
    const depthL = ctx.createGain();
    const depthR = ctx.createGain();
    const dl = ctx.createDelay(0.05);
    const dr = ctx.createDelay(0.05);
    dl.delayTime.value = 0.012;
    dr.delayTime.value = 0.012;
    osc.connect(depthL).connect(dl.delayTime);
    osc.connect(depthR).connect(dr.delayTime);
    node.connect(dry).connect(sum);
    node.connect(split);
    split.connect(dl, 0).connect(merge, 0, 0);
    split.connect(dr, 1).connect(merge, 0, 1);
    merge.connect(wet).connect(sum);
    node = sum;
    updaters.push((f, set) => {
      const a = f.chorus ?? 0;
      const depth = 0.0015 + 0.0025 * a;
      set(depthL.gain, depth);
      set(depthR.gain, -depth);
      set(wet.gain, 0.25 + 0.45 * a);
      set(dry.gain, 1 - 0.25 * a);
    });
  }

  if (isOn(fx, 'wobble')) {
    // Tape wow (slow) and flutter (fast) on a delay line: the pitch drifts, the timing doesn't.
    const d = ctx.createDelay(0.05);
    d.delayTime.value = 0.008;
    const wow = lfo(0.55);
    const flutter = lfo(6.2);
    const wowDepth = ctx.createGain();
    const flutterDepth = ctx.createGain();
    wow.connect(wowDepth).connect(d.delayTime);
    flutter.connect(flutterDepth).connect(d.delayTime);
    node.connect(d);
    node = d;
    updaters.push((f, set) => {
      const a = f.wobble ?? 0;
      // ±(depth·2π·rate) pitch: about 12 cents of wow at full.
      set(wowDepth.gain, 0.0034 * a);
      set(flutterDepth.gain, 0.00006 * a);
    });
  }

  if (isOn(fx, 'width')) {
    // Mid/side on stereo parts, plus a delayed, high-passed side made from the mid so mono parts
    // widen too. That side cancels when the two channels are summed, so mono playback is unchanged.
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const midL = ctx.createGain();
    const midR = ctx.createGain();
    const sideL = ctx.createGain();
    const sideR = ctx.createGain();
    const lToR = ctx.createGain();
    const rToL = ctx.createGain();
    node.connect(split);
    split.connect(midL, 0).connect(merge, 0, 0);
    split.connect(rToL, 1).connect(merge, 0, 0);
    split.connect(midR, 1).connect(merge, 0, 1);
    split.connect(lToR, 0).connect(merge, 0, 1);
    const mono = ctx.createGain();
    mono.gain.value = 0.5;
    node.connect(mono);
    const haas = ctx.createDelay(0.05);
    haas.delayTime.value = 0.014;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const spread = ctx.createGain();
    mono.connect(haas).connect(hp).connect(spread);
    spread.connect(sideL).connect(merge, 0, 0);
    spread.connect(sideR).connect(merge, 0, 1);
    sideL.gain.value = 1;
    sideR.gain.value = -1;
    node = merge;
    updaters.push((f, set) => {
      const w = Math.max(0, Math.min(2, f.width ?? 1));
      set(midL.gain, (1 + w) / 2);
      set(midR.gain, (1 + w) / 2);
      set(rToL.gain, (1 - w) / 2);
      set(lToR.gain, (1 - w) / 2);
      set(spread.gain, Math.max(0, w - 1) * 0.7);
    });
  }

  const output = ctx.createGain();
  node.connect(output);
  const chain: FxChain = {
    input,
    output,
    update(f, smooth) {
      const now = ctx.currentTime;
      const set = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, now, 0.02) : (p.value = v));
      for (const u of updaters) u(f, set);
    },
    dispose() {
      for (const o of oscs) {
        try {
          o.stop();
        } catch {
          /* already stopped */
        }
      }
    },
  };
  chain.update(fx, false);
  return chain;
}
