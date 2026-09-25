/**
 * Drum kits synthesized from scratch. Each voice is rendered once into an AudioBuffer with an
 * OfflineAudioContext, so playback is just a buffer source (cheap and sample-accurate).
 */

interface KickP { kind: 'kick'; f0: number; f1: number; pitchDecay: number; decay: number; click: number; drive: number; tone?: number }
interface SnareP { kind: 'snare'; tone: number; toneDecay: number; noise: number; noiseDecay: number; hp: number; lp: number; body?: number }
interface ClapP { kind: 'clap'; freq: number; decay: number; spread: number; q?: number }
interface HatP { kind: 'hat'; decay: number; hp: number; bp: number; tone?: number; noiseMix?: number; steep?: boolean }
interface CymbalP { kind: 'cymbal'; decay: number; hp: number; bell?: number; noiseMix?: number }
interface TomP { kind: 'tom'; f0: number; f1: number; decay: number; noise?: number }
interface RimP { kind: 'rim'; freq: number; decay: number; q?: number; sub?: number }
interface ShakerP { kind: 'shaker'; decay: number; bp: number; attack?: number }
interface BellP { kind: 'cowbell'; f1: number; f2: number; decay: number }
/** Ringing metal (triangle, bells): inharmonic sine partials. */
interface MetalP { kind: 'metal'; freq: number; decay: number }

/** `level` scales a voice after peak normalization, to balance quiet voices inside a kit. */
export type DrumP = (KickP | SnareP | ClapP | HatP | CymbalP | TomP | RimP | ShakerP | BellP | MetalP) & { level?: number };

export interface KitDef {
  id: string;
  label: string;
  /** Post-processing applied to every rendered voice. */
  crush?: { bits: number; hold: number; lp?: number };
  gain?: number;
  voices: Record<number, DrumP>;
}

const base: Record<number, DrumP> = {
  36: { kind: 'kick', f0: 160, f1: 48, pitchDecay: 0.06, decay: 0.5, click: 0.5, drive: 1.2 },
  38: { kind: 'snare', tone: 190, toneDecay: 0.1, noise: 0.9, noiseDecay: 0.2, hp: 1400, lp: 11000 },
  39: { kind: 'clap', freq: 1300, decay: 0.2, spread: 0.011 },
  37: { kind: 'rim', freq: 1750, decay: 0.045 },
  42: { kind: 'hat', decay: 0.045, hp: 7500, bp: 10000 },
  46: { kind: 'hat', decay: 0.38, hp: 7000, bp: 9500 },
  49: { kind: 'cymbal', decay: 1.8, hp: 4500, noiseMix: 0.5 },
  51: { kind: 'cymbal', decay: 1.3, hp: 6500, bell: 0.35, noiseMix: 0.25 },
  70: { kind: 'shaker', decay: 0.07, bp: 7000, attack: 0.012 },
  56: { kind: 'cowbell', f1: 540, f2: 800, decay: 0.3 },
  63: { kind: 'tom', f0: 360, f1: 280, decay: 0.18, noise: 0.25 },
  // Hand percussion
  31: { kind: 'clap', freq: 2600, decay: 0.07, spread: 0.0015, q: 1.1 },
  54: { kind: 'hat', decay: 0.22, hp: 5500, bp: 8500, noiseMix: 0.9 },
  60: { kind: 'tom', f0: 430, f1: 390, decay: 0.13, noise: 0.25 },
  64: { kind: 'tom', f0: 215, f1: 195, decay: 0.28, noise: 0.18 },
  76: { kind: 'rim', freq: 1150, decay: 0.07, q: 3, sub: 0.25, level: 0.6 },
  81: { kind: 'metal', freq: 3700, decay: 1.4, level: 0.45 },
  45: { kind: 'tom', f0: 110, f1: 72, decay: 0.42, noise: 0.15 },
  47: { kind: 'tom', f0: 150, f1: 105, decay: 0.36, noise: 0.15 },
  50: { kind: 'tom', f0: 210, f1: 150, decay: 0.3, noise: 0.15 },
};

function kit(id: string, label: string, over: Record<number, Partial<DrumP>>, extra: Partial<KitDef> = {}): KitDef {
  const voices: Record<number, DrumP> = {};
  for (const k of Object.keys(base)) {
    const p = Number(k);
    voices[p] = { ...base[p], ...(over[p] ?? {}) } as DrumP;
  }
  return { id, label, voices, ...extra };
}

export const KITS: KitDef[] = [
  kit('trap', 'Trap 808', {
    36: { f0: 150, f1: 44, pitchDecay: 0.05, decay: 0.55, click: 0.35, drive: 1.6 },
    38: { tone: 205, toneDecay: 0.08, noise: 1, noiseDecay: 0.17, hp: 1900, lp: 13000 },
    39: { freq: 1500, decay: 0.24, spread: 0.012 },
    42: { decay: 0.032, hp: 8500, bp: 11000 },
    46: { decay: 0.3, hp: 8000, bp: 10500 },
  }),
  kit('florida', 'Florida Trap', {
    36: { f0: 190, f1: 50, pitchDecay: 0.04, decay: 0.42, click: 0.6, drive: 1.8 },
    38: { tone: 330, toneDecay: 0.04, noise: 1, noiseDecay: 0.045, hp: 1200, lp: 13000, body: 0.7 },
    39: { freq: 2500, decay: 0.055, spread: 0.005, q: 0.55 },
    37: { freq: 2400, decay: 0.11, q: 5, sub: 0.1, level: 0.18 },
    42: { decay: 0.11, hp: 7000, bp: 9000, noiseMix: 0.55, steep: true, level: 0.4 },
    46: { decay: 0.3, hp: 6500, bp: 9500, noiseMix: 0.55 },
  }),
  kit(
    'boombap',
    'Boom Bap',
    {
      36: { f0: 130, f1: 50, pitchDecay: 0.045, decay: 0.38, click: 0.8, drive: 2.2 },
      38: { tone: 175, toneDecay: 0.12, noise: 0.95, noiseDecay: 0.24, hp: 700, lp: 7500, body: 0.6 },
      39: { freq: 1100, decay: 0.22, spread: 0.013 },
      42: { decay: 0.05, hp: 6500, bp: 8500 },
      46: { decay: 0.34, hp: 6000, bp: 8000 },
    },
    { crush: { bits: 12, hold: 2, lp: 9500 } },
  ),
  kit(
    'lofi',
    'Lo-Fi Dusty',
    {
      36: { f0: 110, f1: 48, pitchDecay: 0.05, decay: 0.34, click: 0.4, drive: 1.4 },
      38: { tone: 170, toneDecay: 0.1, noise: 0.7, noiseDecay: 0.2, hp: 600, lp: 5500, body: 0.7 },
      39: { freq: 950, decay: 0.2, spread: 0.014 },
      42: { decay: 0.05, hp: 5000, bp: 7000 },
      46: { decay: 0.28, hp: 5000, bp: 6800 },
      70: { decay: 0.08, bp: 5200 },
    },
    { crush: { bits: 9, hold: 3, lp: 5200 }, gain: 1.1 },
  ),
  kit('house', 'House 909', {
    36: { f0: 230, f1: 52, pitchDecay: 0.035, decay: 0.42, click: 0.9, drive: 1.5 },
    38: { tone: 220, toneDecay: 0.07, noise: 1, noiseDecay: 0.22, hp: 1200, lp: 12000 },
    39: { freq: 1250, decay: 0.26, spread: 0.01 },
    42: { decay: 0.06, hp: 7500, bp: 9000, noiseMix: 0.6 },
    46: { decay: 0.45, hp: 7000, bp: 9000, noiseMix: 0.6 },
    51: { decay: 1.6, hp: 7000, bell: 0.45, noiseMix: 0.3 },
  }),
  kit('breaks', 'Breaks / DnB', {
    36: { f0: 140, f1: 56, pitchDecay: 0.03, decay: 0.3, click: 1, drive: 2 },
    38: { tone: 230, toneDecay: 0.06, noise: 1.1, noiseDecay: 0.16, hp: 1800, lp: 14000, body: 0.4 },
    42: { decay: 0.035, hp: 9000, bp: 11500 },
    46: { decay: 0.25, hp: 8500, bp: 11000 },
  }),
  kit(
    'retro',
    'Retro 80s',
    {
      36: { f0: 180, f1: 50, pitchDecay: 0.05, decay: 0.45, click: 0.6, drive: 1.3 },
      38: { tone: 185, toneDecay: 0.12, noise: 1, noiseDecay: 0.55, hp: 1100, lp: 9000, body: 0.5 },
      39: { freq: 1200, decay: 0.45, spread: 0.012 },
      45: { f0: 160, f1: 70, decay: 0.55, noise: 0.05 },
      47: { f0: 220, f1: 100, decay: 0.5, noise: 0.05 },
      50: { f0: 300, f1: 140, decay: 0.45, noise: 0.05 },
    },
    { gain: 0.95 },
  ),
];

KITS.push(
  kit('acoustic', 'Acoustic Kit', {
    // A real kit: a boomy kick with a beater click, a snare with body and wires, bright hats.
    36: { f0: 95, f1: 52, pitchDecay: 0.06, decay: 0.5, click: 1.2, drive: 1.1 },
    38: { tone: 200, toneDecay: 0.14, noise: 1.2, noiseDecay: 0.28, hp: 900, lp: 12000, body: 0.9 },
    39: { freq: 1400, decay: 0.3, spread: 0.012 },
    42: { decay: 0.07, hp: 6000, bp: 9500, noiseMix: 0.7 },
    46: { decay: 0.6, hp: 5500, bp: 9000, noiseMix: 0.7 },
    49: { decay: 2.4, hp: 3500, noiseMix: 0.6 },
    51: { decay: 1.9, hp: 5500, bell: 0.4, noiseMix: 0.35 },
    45: { f0: 95, f1: 80, decay: 0.6, noise: 0.25 },
    47: { f0: 140, f1: 120, decay: 0.5, noise: 0.25 },
    50: { f0: 190, f1: 165, decay: 0.45, noise: 0.25 },
  }),
  kit('afro', 'Afro Percussion', {
    // Afrobeats / amapiano: round kick, rimshot snare, log-drum toms, shakers, congas and bongos.
    36: { f0: 120, f1: 45, pitchDecay: 0.05, decay: 0.45, click: 0.5, drive: 1.4 },
    38: { tone: 330, toneDecay: 0.06, noise: 0.8, noiseDecay: 0.12, hp: 1500, lp: 11000, body: 0.8 },
    37: { freq: 1700, decay: 0.06, q: 3, sub: 0.6 },
    70: { decay: 0.1, bp: 6500, attack: 0.02 },
    45: { f0: 100, f1: 85, decay: 0.5, noise: 0.05 },
    47: { f0: 150, f1: 130, decay: 0.45, noise: 0.05 },
    50: { f0: 210, f1: 185, decay: 0.4, noise: 0.05 },
    60: { f0: 470, f1: 430, decay: 0.12, noise: 0.3 },
    64: { f0: 240, f1: 215, decay: 0.3, noise: 0.2 },
    63: { f0: 330, f1: 300, decay: 0.2, noise: 0.25 },
  }),
);

export const KIT_BY_ID = new Map(KITS.map((k) => [k.id, k]));

// ---------------------------------------------------------------------------------------------

let noiseCache: { rate: number; buf: AudioBuffer } | null = null;
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseCache && noiseCache.rate === ctx.sampleRate) {
    // AudioBuffers are context independent, reuse.
    return noiseCache.buf;
  }
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    d[i] = (seed / 4294967296) * 2 - 1;
  }
  noiseCache = { rate: ctx.sampleRate, buf };
  return buf;
}

function noise(ctx: BaseAudioContext): AudioBufferSourceNode {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  return n;
}

function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

function decayEnv(g: AudioParam, t: number, peak: number, decay: number, attack = 0.001): void {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.0008, t + attack + decay);
}

const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

function metallic(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, mult = 1): void {
  for (const f of METAL) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f * mult * 1.7;
    o.connect(out);
    o.start(t);
    o.stop(t + dur);
  }
}

function renderVoice(ctx: OfflineAudioContext, p: DrumP): void {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const t = 0.002;
  switch (p.kind) {
    case 'kick': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(p.f0 * 2.2, t);
      o.frequency.exponentialRampToValueAtTime(p.f0, t + 0.008);
      o.frequency.exponentialRampToValueAtTime(p.f1, t + 0.008 + p.pitchDecay);
      const g = ctx.createGain();
      decayEnv(g.gain, t, 1, p.decay, 0.002);
      const sh = ctx.createWaveShaper();
      sh.curve = driveCurve(p.drive);
      o.connect(g).connect(sh).connect(out);
      o.start(t);
      o.stop(t + p.decay + 0.05);
      if (p.click > 0) {
        const n = noise(ctx);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1800;
        const cg = ctx.createGain();
        decayEnv(cg.gain, t, p.click * 0.5, 0.012);
        n.connect(hp).connect(cg).connect(out);
        n.start(t);
        n.stop(t + 0.05);
      }
      break;
    }
    case 'snare': {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(p.tone * 1.4, t);
      o.frequency.exponentialRampToValueAtTime(p.tone, t + 0.03);
      const og = ctx.createGain();
      decayEnv(og.gain, t, 0.7 * (p.body ?? 0.5) * 1.6, p.toneDecay);
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + p.toneDecay + 0.05);
      const n = noise(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hp;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.lp;
      const ng = ctx.createGain();
      decayEnv(ng.gain, t, p.noise * 0.75, p.noiseDecay);
      n.connect(hp).connect(lp).connect(ng).connect(out);
      n.start(t);
      n.stop(t + p.noiseDecay + 0.05);
      break;
    }
    case 'clap': {
      const n = noise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p.freq;
      bp.Q.value = p.q ?? 0.9;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 3; i++) {
        const bt = t + i * p.spread;
        g.gain.setValueAtTime(0.0001, bt);
        g.gain.linearRampToValueAtTime(1.1, bt + 0.001);
        g.gain.exponentialRampToValueAtTime(0.12, bt + p.spread * 0.95);
      }
      const tail = t + 3 * p.spread;
      g.gain.setValueAtTime(0.0001, tail);
      g.gain.linearRampToValueAtTime(1, tail + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0008, tail + p.decay);
      n.connect(hp).connect(bp).connect(g).connect(out);
      n.start(t);
      n.stop(tail + p.decay + 0.05);
      break;
    }
    case 'rim': {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = p.freq;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = p.freq * 0.47;
      const o2g = ctx.createGain();
      o2g.gain.value = p.sub ?? 1;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p.freq;
      bp.Q.value = p.q ?? 2;
      const g = ctx.createGain();
      decayEnv(g.gain, t, 1.4, p.decay);
      o.connect(bp);
      o2.connect(o2g).connect(bp);
      bp.connect(g).connect(out);
      o.start(t);
      o2.start(t);
      o.stop(t + p.decay + 0.05);
      o2.stop(t + p.decay + 0.05);
      break;
    }
    case 'hat': {
      const bus = ctx.createGain();
      bus.gain.value = 0.35;
      metallic(ctx, bus, t, p.decay + 0.1);
      const n = noise(ctx);
      const ng = ctx.createGain();
      ng.gain.value = p.noiseMix ?? 0.35;
      n.connect(ng).connect(bus);
      n.start(t);
      n.stop(t + p.decay + 0.1);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p.bp;
      bp.Q.value = 0.8;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hp;
      const g = ctx.createGain();
      decayEnv(g.gain, t, 1.1, p.decay);
      bus.connect(bp).connect(hp);
      if (p.steep) {
        // A second high-pass stage for a thin, bright hat with almost nothing below ~5 kHz.
        const hp2 = ctx.createBiquadFilter();
        hp2.type = 'highpass';
        hp2.frequency.value = p.hp;
        hp.connect(hp2).connect(g).connect(out);
      } else hp.connect(g).connect(out);
      break;
    }
    case 'cymbal': {
      const bus = ctx.createGain();
      bus.gain.value = 0.3;
      metallic(ctx, bus, t, p.decay + 0.1, 1.15);
      const n = noise(ctx);
      const ng = ctx.createGain();
      ng.gain.value = p.noiseMix ?? 0.4;
      n.connect(ng).connect(bus);
      n.start(t);
      n.stop(t + p.decay + 0.1);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hp;
      const g = ctx.createGain();
      decayEnv(g.gain, t, 0.8, p.decay, 0.003);
      bus.connect(hp).connect(g).connect(out);
      if (p.bell) {
        const b = ctx.createOscillator();
        b.type = 'sine';
        b.frequency.value = 3150;
        const bg = ctx.createGain();
        decayEnv(bg.gain, t, p.bell * 0.25, p.decay * 0.6);
        b.connect(bg).connect(out);
        b.start(t);
        b.stop(t + p.decay);
      }
      break;
    }
    case 'tom': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(p.f0, t);
      o.frequency.exponentialRampToValueAtTime(p.f1, t + p.decay * 0.6);
      const g = ctx.createGain();
      decayEnv(g.gain, t, 1, p.decay, 0.002);
      const sh = ctx.createWaveShaper();
      sh.curve = driveCurve(1.3);
      o.connect(g).connect(sh).connect(out);
      o.start(t);
      o.stop(t + p.decay + 0.05);
      if (p.noise) {
        const n = noise(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = p.f0 * 6;
        const ng = ctx.createGain();
        decayEnv(ng.gain, t, p.noise, 0.04);
        n.connect(bp).connect(ng).connect(out);
        n.start(t);
        n.stop(t + 0.1);
      }
      break;
    }
    case 'shaker': {
      const n = noise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p.bp;
      bp.Q.value = 1.2;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3500;
      const g = ctx.createGain();
      decayEnv(g.gain, t, 0.9, p.decay, p.attack ?? 0.01);
      n.connect(bp).connect(hp).connect(g).connect(out);
      n.start(t);
      n.stop(t + p.decay + 0.1);
      break;
    }
    case 'metal': {
      for (const [ratio, lvl] of [[1, 0.5], [2.76, 0.3], [5.4, 0.18], [8.93, 0.1]] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = p.freq * ratio;
        const g = ctx.createGain();
        decayEnv(g.gain, t, lvl, p.decay / Math.sqrt(ratio), 0.001);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + p.decay + 0.05);
      }
      break;
    }
    case 'cowbell': {
      const bus = ctx.createGain();
      for (const f of [p.f1, p.f2]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        o.connect(bus);
        o.start(t);
        o.stop(t + p.decay + 0.1);
      }
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p.f2;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0008, t + p.decay);
      bus.connect(bp).connect(g).connect(out);
      break;
    }
  }
}

function voiceLength(p: DrumP): number {
  switch (p.kind) {
    case 'kick':
    case 'tom':
    case 'rim':
    case 'shaker':
    case 'cowbell':
    case 'metal':
    case 'hat':
    case 'cymbal':
      return p.decay + 0.08;
    case 'snare':
      return Math.max(p.noiseDecay, p.toneDecay) + 0.08;
    case 'clap':
      return p.decay + p.spread * 3 + 0.08;
  }
}

function postProcess(buf: AudioBuffer, kitDef: KitDef, level = 1): void {
  const d = buf.getChannelData(0);
  const crush = kitDef.crush;
  let peak = 0;
  if (crush) {
    const levels = Math.pow(2, crush.bits - 1);
    let held = 0;
    const lpA = crush.lp ? 1 - Math.exp((-2 * Math.PI * crush.lp) / buf.sampleRate) : 1;
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      if (i % crush.hold === 0) held = Math.round(d[i] * levels) / levels;
      lp += (held - lp) * lpA;
      d[i] = lp;
    }
  }
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const g = (kitDef.gain ?? 1) * level * (peak > 0.95 ? 0.95 / peak : 1);
  if (g !== 1) for (let i = 0; i < d.length; i++) d[i] *= g;
  // Tiny fade-out to avoid clicks.
  const fade = Math.min(d.length, Math.floor(buf.sampleRate * 0.01));
  for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
}

const kitCache = new Map<string, Promise<Map<number, AudioBuffer>>>();

export function loadKit(id: string, sampleRate: number): Promise<Map<number, AudioBuffer>> {
  const key = id + '@' + sampleRate;
  let p = kitCache.get(key);
  if (!p) {
    const def = KIT_BY_ID.get(id) ?? KITS[0];
    p = (async () => {
      const out = new Map<number, AudioBuffer>();
      await Promise.all(
        Object.entries(def.voices).map(async ([pitch, vp]) => {
          const len = Math.ceil(voiceLength(vp) * sampleRate);
          const ctx = new OfflineAudioContext(1, len, sampleRate);
          renderVoice(ctx, vp);
          const buf = await ctx.startRendering();
          postProcess(buf, def, vp.level);
          out.set(Number(pitch), buf);
        }),
      );
      return out;
    })();
    kitCache.set(key, p);
  }
  return p;
}
