import { drive, pulseHarmonics, VoiceKit, wave, type Voice, type VoiceArgs } from './voice';

/**
 * More synthesized instruments: physically modelled plucked strings, mallets and bells, vintage
 * keys, bass synths, vocal tones and folk winds. All of them work offline.
 */

export interface ExtraDef {
  id: string;
  label: string;
  group: 'Keys' | 'Strings' | 'Woodwind' | 'Bass' | 'Pluck' | 'Mallet' | 'Bell' | 'Lead' | 'Vocal';
  mono?: boolean;
  octave: number;
  build(ctx: BaseAudioContext, out: AudioNode, a: VoiceArgs): Voice;
}

// ---------------------------------------------------------------------------------------------
// Physical models, computed sample by sample and cached per pitch, velocity and sample rate

const rendered = new Map<string, AudioBuffer>();

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StringModel {
  /** Seconds to render. */
  seconds: number;
  /** Time for the note to fall 60 dB. */
  t60: number;
  /** 0 = dark, 1 = bright pluck (also scaled by velocity). */
  bright: number;
  /** Pluck position along the string (0..0.5): smaller = thinner, twangier. */
  pick: number;
  /** Loop low-pass amount 0..0.5 (0.5 = classic Karplus–Strong averaging, lower = brighter ring). */
  damp: number;
  /** Sitar-style bridge buzz. */
  buzz?: number;
}

/** Extended Karplus–Strong string: filtered noise burst in a tuned, damped delay loop. */
function pluckedString(sr: number, freq: number, vel: number, m: StringModel): Float32Array<ArrayBuffer> {
  const n = Math.floor(m.seconds * sr);
  const out = new Float32Array(n);
  const period = sr / freq;
  const N = Math.max(2, Math.floor(period - m.damp));
  const frac = period - m.damp - N;
  const C = (1 - frac) / (1 + frac); // all-pass fractional delay for exact tuning
  const line = new Float32Array(N);
  const rnd = mulberry(Math.round(freq * 1000));
  const alpha = Math.min(1, 0.08 + 0.92 * m.bright * (0.4 + 0.6 * vel));
  let lp = 0;
  const exc = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lp += alpha * (rnd() * 2 - 1 - lp);
    exc[i] = lp;
  }
  const pk = Math.max(1, Math.round(m.pick * N));
  for (let i = 0; i < N; i++) line[i] = exc[i] - (i >= pk ? exc[i - pk] : 0);
  const g = Math.pow(10, -3 / (m.t60 * freq)); // loop gain per period
  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  for (let t = 0; t < n; t++) {
    const cur = line[idx];
    out[t] = cur;
    let y = g * ((1 - m.damp) * cur + m.damp * prev);
    prev = cur;
    const ap = C * y + apX - C * apY;
    apX = y;
    apY = ap;
    y = ap;
    if (m.buzz) {
      // The curved sitar bridge (jawari) clips and folds the string's swing into a buzz.
      const th = 0.3;
      if (y > th) y = th + (y - th) * (1 - m.buzz);
      else if (y < -th) y = -th + (y + th) * (1 - m.buzz);
    }
    line[idx] = y;
    idx = (idx + 1) % N;
  }
  // Normalise to a consistent peak.
  let peak = 0;
  for (let i = 0; i < Math.min(n, sr * 0.2); i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

/** Play a (cached) plucked-string render, then shape it with an optional tone chain. */
function pluck(
  ctx: BaseAudioContext,
  out: AudioNode,
  a: VoiceArgs,
  id: string,
  m: StringModel,
  level: number,
  chain?: (v: VoiceKit, input: GainNode) => AudioNode,
): Voice {
  const v = new VoiceKit(ctx, out, a, 0.12);
  const vb = Math.round(Math.max(0.05, a.vel) * 4);
  const key = `${id}:${Math.round(a.pitch * 100)}:${vb}:${ctx.sampleRate}`;
  let buf = rendered.get(key);
  if (!buf) {
    const data = pluckedString(ctx.sampleRate, v.f, vb / 4, m);
    buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    rendered.set(key, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.start(a.time);
  v.srcs.push(src);
  const g = v.gain(level * Math.pow(Math.max(0.05, a.vel), 1.2));
  src.connect(g);
  (chain ? chain(v, g) : g).connect(v.rel);
  return v.finish();
}

// ---------------------------------------------------------------------------------------------
// Helpers for additive mallets and bells

/** Sine partials [ratio, level, decay seconds] with an attack click. */
function partials(v: VoiceKit, a: VoiceArgs, parts: [number, number, number][], level: number, click = 0): GainNode {
  const sum = v.gain(1);
  for (const [ratio, lvl, decay] of parts) {
    const o = v.osc('sine', ratio);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, a.time);
    g.gain.linearRampToValueAtTime(lvl * level * a.vel, a.time + 0.002);
    g.gain.setTargetAtTime(0, a.time + 0.002, decay / 4);
    o.connect(g).connect(sum);
  }
  if (click > 0) {
    const n = v.noise();
    const bp = v.filter('bandpass', Math.min(12000, v.f * 6), 1.2);
    const ng = v.gain(0);
    ng.gain.setValueAtTime(click * a.vel, a.time);
    ng.gain.setTargetAtTime(0, a.time, 0.006);
    n.connect(bp).connect(ng).connect(sum);
  }
  return sum;
}

/** Formant filter bank for vowel sounds. */
function formants(v: VoiceKit, input: AudioNode, f: [number, number, number][]): GainNode {
  const sum = v.gain(1);
  for (const [freq, q, lvl] of f) {
    const bp = v.filter('bandpass', freq, q);
    input.connect(bp).connect(v.gain(lvl)).connect(sum);
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------

export const EXTRA: ExtraDef[] = [
  // Plucked strings (physical models)
  {
    id: 'koto',
    label: 'Koto',
    group: 'Pluck',
    octave: 4,
    build: (ctx, out, a) =>
      pluck(ctx, out, a, 'koto', { seconds: 3.2, t60: 2.6, bright: 0.85, pick: 0.12, damp: 0.25 }, 1.5, (v, g) => {
        const twang = v.filter('peaking', 2500, 1);
        twang.gain.value = 4;
        return g.connect(twang);
      }),
  },
  {
    id: 'sitar',
    label: 'Sitar',
    group: 'Pluck',
    octave: 4,
    build: (ctx, out, a) =>
      pluck(ctx, out, a, 'sitar', { seconds: 3.5, t60: 3, bright: 0.9, pick: 0.08, damp: 0.2, buzz: 0.45 }, 2.7, (v, g) => {
        const res = v.filter('bandpass', 1800, 1.4);
        const dry = v.gain(0.7);
        const mix = v.gain(1);
        g.connect(dry).connect(mix);
        g.connect(res).connect(v.gain(1.2)).connect(mix);
        return mix;
      }),
  },
  {
    id: 'pizz',
    label: 'Pizzicato Strings',
    group: 'Strings',
    octave: 4,
    build: (ctx, out, a) =>
      pluck(ctx, out, a, 'pizz', { seconds: 1.2, t60: 0.55, bright: 0.45, pick: 0.25, damp: 0.5 }, 4.3, (v, g) => {
        // Wooden body resonance.
        const body = v.filter('peaking', 280, 1.1);
        body.gain.value = 5;
        const air = v.filter('highshelf', 3000, 0.7);
        air.gain.value = -4;
        return g.connect(body).connect(air);
      }),
  },

  // Mallets and bells
  {
    id: 'kalimba',
    label: 'Kalimba',
    group: 'Mallet',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.25);
      partials(v, a, [[1, 0.5, 1.3], [5.9, 0.12, 0.12], [10.6, 0.04, 0.05]], 1, 0.15).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'musicbox',
    label: 'Music Box',
    group: 'Bell',
    octave: 6,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.5);
      partials(v, a, [[1, 0.38, 1.8], [2.02, 0.12, 0.8], [5.1, 0.06, 0.3], [8.7, 0.03, 0.12]], 1, 0.08).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'steeldrum',
    label: 'Steel Drum',
    group: 'Mallet',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.2);
      const body = partials(v, a, [[1, 0.42, 0.9], [2, 0.22, 0.6], [3, 0.12, 0.35], [4.1, 0.05, 0.2]], 1, 0.06);
      // The pan's slight "bwong": a soft swell and a band-pass that opens up.
      const bp = v.filter('lowpass', v.f * 3, 1.5);
      bp.frequency.setValueAtTime(v.f * 2, a.time);
      bp.frequency.linearRampToValueAtTime(v.f * 7, a.time + 0.03);
      body.connect(bp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'vibes',
    label: 'Vibraphone',
    group: 'Mallet',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.6);
      const body = partials(v, a, [[1, 0.42, 3.4], [4, 0.1, 0.5], [10, 0.02, 0.1]], 1, 0.05);
      const trem = v.gain(1);
      v.lfo(trem.gain, 5.2, 0.35, 0.05); // the rotating-disc motor
      body.connect(trem).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'celesta',
    label: 'Celesta',
    group: 'Bell',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.35);
      partials(v, a, [[1, 0.4, 1.2], [2, 0.1, 0.5], [3.02, 0.05, 0.25], [4.1, 0.02, 0.1]], 1, 0.06).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'tubular',
    label: 'Tubular Bells',
    group: 'Bell',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 1.2);
      partials(v, a, [[1, 0.3, 5], [2.76, 0.22, 3.2], [5.4, 0.14, 2], [8.93, 0.08, 1.2], [13.34, 0.04, 0.6]], 1, 0.1).connect(v.rel);
      return v.finish();
    },
  },

  // Keys
  {
    id: 'clav',
    label: 'Clavinet',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05);
      const o = v.osc('custom', 1, 0, wave(ctx, 'pulse12', pulseHarmonics(0.12)));
      const f = v.filter('lowpass', 1000, 4);
      f.frequency.setValueAtTime(900 + 5000 * a.vel, a.time);
      f.frequency.setTargetAtTime(700, a.time + 0.005, 0.18);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.5, 0.25, a.vel * 0.87);
      o.connect(f).connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'wurli',
    label: 'Wurlitzer',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.15);
      const o = v.osc('sine');
      const o2 = v.osc('sine', 2);
      const mix = v.gain(1);
      o.connect(mix);
      o2.connect(v.gain(0.25)).connect(mix);
      // The reed bark: soft saturation that grows with velocity.
      const pre = v.gain(0.6 + 1.6 * a.vel);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.003, 1.1, 0.35, a.vel * 0.3);
      const trem = v.gain(1);
      v.lfo(trem.gain, 5.5, 0.18, 0.1);
      mix.connect(pre).connect(drive(ctx, 2.2)).connect(v.filter('lowpass', 3200)).connect(amp).connect(trem).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'accordion',
    label: 'Accordion',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.08);
      const pulse = wave(ctx, 'pulse35', pulseHarmonics(0.35));
      const mix = v.gain(1);
      for (const d of [-9, 0, 9]) v.osc('custom', 1, d, pulse).connect(v.gain(0.33)).connect(mix); // musette tuning
      const f = formants(v, mix, [[700, 2, 1], [1400, 3, 0.6], [2600, 4, 0.3]]);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.05, 0.4, 0.85, a.vel * 3.2);
      f.connect(amp).connect(v.rel);
      return v.finish();
    },
  },

  // Bass synths
  {
    id: 'acid',
    label: 'Acid Bass (303)',
    group: 'Bass',
    mono: true,
    octave: 2,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.03, 0.06);
      const o = v.osc('sawtooth');
      const f = v.filter('lowpass', 400, 14);
      const legato = a.glideFrom !== undefined;
      f.frequency.setValueAtTime(legato ? 700 : 300 + 3200 * a.vel * a.vel, a.time);
      f.frequency.setTargetAtTime(220, a.time + 0.01, legato ? 0.2 : 0.09);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.003, 0.3, 0.7, a.vel * 0.34);
      o.connect(f).connect(drive(ctx, 1.4)).connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'wobble',
    label: 'Wobble Bass',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05, 0.05);
      const mix = v.gain(1);
      v.osc('sawtooth', 1, -8).connect(v.gain(0.5)).connect(mix);
      v.osc('sawtooth', 1, 8).connect(v.gain(0.5)).connect(mix);
      v.osc('square', 0.5).connect(v.gain(0.4)).connect(mix);
      const f = v.filter('lowpass', 500, 8);
      v.lfo(f.frequency, 3, 420, 0, 'sine');
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.005, 0.2, 0.9, a.vel * 0.3);
      mix.connect(f).connect(drive(ctx, 2)).connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'fmbass',
    label: 'FM Bass',
    group: 'Bass',
    mono: true,
    octave: 2,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.04, 0.05);
      const car = v.osc('sine');
      const mod = v.osc('sine', 1);
      const mg = v.gain(0);
      mg.gain.setValueAtTime(v.f * (0.8 + 2.2 * a.vel), a.time);
      mg.gain.setTargetAtTime(v.f * 0.4, a.time + 0.004, 0.08);
      mod.connect(mg).connect(car.frequency);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.4, 0.6, a.vel * 0.5);
      car.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'bass808d',
    label: '808 Distorted',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06, 0.09);
      const o = v.osc('sine');
      if (a.glideFrom === undefined) {
        o.frequency.cancelScheduledValues(a.time);
        o.frequency.setValueAtTime(v.f * 4, a.time);
        o.frequency.setTargetAtTime(v.f, a.time, 0.015);
      }
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.003, 0.7, 0.3, a.vel);
      // Hard clipping for the aggressive, grinding 808 of drill and rage beats.
      o.connect(amp).connect(drive(ctx, 7)).connect(v.filter('lowpass', 4000)).connect(v.gain(0.27)).connect(v.rel);
      return v.finish();
    },
  },

  // Synth, vocal and wind
  {
    id: 'stab',
    label: 'Chord Stab',
    group: 'Lead',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06);
      const mix = v.gain(1);
      v.osc('sawtooth', 1, -6).connect(mix);
      v.osc('sawtooth', 1, 6).connect(mix);
      v.osc('square', 0.5).connect(v.gain(0.5)).connect(mix);
      const f = v.filter('lowpass', 800, 3);
      f.frequency.setValueAtTime(1500 + 7000 * a.vel, a.time);
      f.frequency.setTargetAtTime(600, a.time + 0.005, 0.07);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.16, 0.12, a.vel * 0.46);
      mix.connect(f).connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'ooh',
    label: 'Vocal Ooh',
    group: 'Vocal',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.35);
      const src = v.osc('sawtooth');
      v.lfo(src.detune, 5.1, 14, 0.3);
      const f = formants(v, src, [[330, 6, 1], [750, 7, 0.45], [2400, 9, 0.1]]);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.12, 0.8, 0.85, a.vel * 1.15);
      f.connect(v.filter('lowpass', 2800)).connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'vocalchop',
    label: 'Vocal Chop',
    group: 'Vocal',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05);
      const src = v.osc('sawtooth');
      const n = v.noise();
      const mix = v.gain(1);
      src.connect(mix);
      n.connect(v.gain(0.05)).connect(mix);
      // "Ah" sliding towards "ay": the formants move during the chop.
      const f1 = v.filter('bandpass', 800, 5);
      const f2 = v.filter('bandpass', 1250, 6);
      const f3 = v.filter('bandpass', 2700, 8);
      f2.frequency.setValueAtTime(1250, a.time);
      f2.frequency.linearRampToValueAtTime(1900, a.time + 0.18);
      const sum = v.gain(1);
      mix.connect(f1).connect(sum);
      mix.connect(f2).connect(v.gain(0.6)).connect(sum);
      mix.connect(f3).connect(v.gain(0.2)).connect(sum);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.01, 0.12, 0.5, a.vel * 2.3);
      sum.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'whistle',
    label: 'Whistle',
    group: 'Woodwind',
    mono: true,
    octave: 6,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06, 0.08);
      const o = v.osc('sine');
      v.lfo(o.detune, 5.8, 18, 0.25);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.03, 0.3, 0.85, a.vel * 0.34);
      o.connect(amp);
      const n = v.noise();
      const bp = v.filter('bandpass', v.f, 12);
      const ng = v.gain(0);
      v.adsr(ng.gain, 0.02, 0.2, 0.3, a.vel * 0.06);
      n.connect(bp).connect(ng).connect(amp);
      amp.connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'harmonica',
    label: 'Harmonica',
    group: 'Woodwind',
    mono: true,
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05, 0.05);
      const o = v.osc('custom', 1, 0, wave(ctx, 'pulse40', pulseHarmonics(0.4)));
      v.lfo(o.detune, 6, 10, 0.2);
      const f = formants(v, o, [[1000, 2, 1], [2200, 3, 0.5]]);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.03, 0.4, 0.8, a.vel * 2.05);
      f.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'panflute',
    label: 'Pan Flute',
    group: 'Woodwind',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.12);
      const o = v.osc('sine');
      v.osc('sine', 3).connect(v.gain(0.06)).connect(v.rel);
      v.lfo(o.detune, 5, 8, 0.3);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.05, 0.4, 0.75, a.vel * 0.38);
      o.connect(amp).connect(v.rel);
      // Breathy "chiff" at the start of every note.
      const n = v.noise();
      const bp = v.filter('bandpass', v.f * 2, 2);
      const ng = v.gain(0);
      ng.gain.setValueAtTime(a.vel * 0.25, a.time);
      ng.gain.setTargetAtTime(a.vel * 0.04, a.time + 0.02, 0.05);
      n.connect(bp).connect(ng).connect(v.rel);
      return v.finish();
    },
  },
];

