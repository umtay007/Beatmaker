import { EXTRA } from './extra';
import { playSample, SAMPLED } from './samples';
import { drive, GAUSS_LEN, gaussDecay, pulseHarmonics, VoiceKit, wave, type Voice, type VoiceArgs } from './voice';

/**
 * Melodic instruments, synthesized in real time from oscillators, filters and envelopes.
 * Every builder works with any BaseAudioContext, so the same code drives live playback and the
 * offline WAV / video render.
 */

export type { Voice, VoiceArgs } from './voice';

/** Instrument families, in the order the instrument menu lists them. */
export const GROUPS = ['Sampler', 'Keys', 'Guitar', 'Strings', 'Brass', 'Woodwind', 'Bass', 'Pluck', 'Mallet', 'Bell', 'Pad', 'Lead', 'Vocal'] as const;
export type InstrumentGroup = (typeof GROUPS)[number];

export interface InstrumentDef {
  id: string;
  label: string;
  group: InstrumentGroup;
  /** Recorded samples streamed on demand (see samples.ts). */
  sampled?: boolean;
  mono?: boolean;
  /** Default octave for new notes (C of this octave = 12 * (octave + 1)). */
  octave: number;
  build(ctx: BaseAudioContext, out: AudioNode, a: VoiceArgs): Voice;
}


// ---------------------------------------------------------------------------------------------

export const INSTRUMENTS: InstrumentDef[] = [
  {
    id: 'bass808',
    label: '808 Bass',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06, 0.09);
      const o = v.osc('sine');
      if (a.glideFrom === undefined) {
        o.frequency.cancelScheduledValues(a.time);
        o.frequency.setValueAtTime(v.f * 2.2, a.time);
        o.frequency.exponentialRampToValueAtTime(v.f, a.time + 0.045);
      }
      const o2 = v.osc('triangle');
      const g2 = v.gain(0.12);
      o2.connect(g2);
      const amp = v.gain(0);
      const legato = a.glideFrom !== undefined;
      if (legato) {
        amp.gain.setValueAtTime(a.vel * 0.7, a.time);
        amp.gain.setTargetAtTime(a.vel * 0.45, a.time, 0.9);
      } else v.adsr(amp.gain, 0.004, 0.9, 0.45, a.vel);
      const sh = drive(ctx, 2.4);
      const lp = v.filter('lowpass', 2200);
      o.connect(amp);
      g2.connect(amp);
      amp.connect(sh).connect(lp).connect(v.gain(0.48)).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'bass808s',
    label: '808 Smooth',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      // Long 808 with a gentle pitch settle (about a semitone) and a slow natural decay.
      const v = new VoiceKit(ctx, out, a, 0.07, 0.09);
      const o = v.osc('sine');
      const legato = a.glideFrom !== undefined;
      if (!legato) {
        o.frequency.cancelScheduledValues(a.time);
        o.frequency.setValueAtTime(v.f * Math.pow(2, 1.1 / 12), a.time);
        o.frequency.setTargetAtTime(v.f, a.time + 0.01, 0.05);
      }
      const o2 = v.osc('triangle');
      const g2 = v.gain(0.08);
      o2.connect(g2);
      const amp = v.gain(0);
      if (legato) {
        amp.gain.setValueAtTime(a.vel * 0.6, a.time);
        amp.gain.setTargetAtTime(a.vel * 0.05, a.time, 0.6);
      } else v.adsr(amp.gain, 0.003, 0.55, 0.05, a.vel);
      o.connect(amp);
      g2.connect(amp);
      amp.connect(drive(ctx, 2)).connect(v.filter('lowpass', 1600)).connect(v.gain(0.6)).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'bass808p',
    label: '808 Punch',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      // Florida-style 808 with the kick built in: a short 160 -> 80 Hz thump, and a pitch that
      // starts about 5x higher and drops into the note within ~40 ms. The sine then fades with a
      // rounded (Gaussian) decay; heavy saturation adds the harmonics that carry on small speakers.
      // Tuned against a Demucs-separated reference 808 (attack and sustain spectra within ~2 dB).
      const v = new VoiceKit(ctx, out, a, 0.05, 0.09);
      const o = v.osc('sine');
      // A quiet octave partial stands in for the even harmonics of asymmetric saturation.
      const o2 = v.osc('sine', 2);
      // No initial .value here: setting it adds an automation event at currentTime, which would
      // overlap the gain curve below whenever a note is scheduled slightly late.
      const amp = ctx.createGain();
      if (a.glideFrom !== undefined) {
        amp.gain.setValueAtTime(0, a.time);
        amp.gain.linearRampToValueAtTime(a.vel * 0.7, a.time + 0.004);
        amp.gain.setTargetAtTime(0, a.time + 0.004, 0.35);
      } else {
        o.frequency.cancelScheduledValues(a.time);
        o.frequency.setValueAtTime(v.f * 5, a.time);
        o.frequency.setTargetAtTime(v.f, a.time, 0.013);
        o2.frequency.cancelScheduledValues(a.time);
        o2.frequency.setValueAtTime(v.f * 10, a.time);
        o2.frequency.setTargetAtTime(v.f * 2, a.time, 0.013);
        amp.gain.setValueCurveAtTime(gaussDecay(a.vel, 0.49), a.time, GAUSS_LEN);
        // Kick layer: a short 160 -> 80 Hz thump, the same for every note.
        const k = v.osc('sine');
        k.frequency.cancelScheduledValues(a.time);
        k.frequency.setValueAtTime(160, a.time);
        k.frequency.exponentialRampToValueAtTime(80, a.time + 0.03);
        const kg = v.gain(0);
        kg.gain.setValueAtTime(0, a.time);
        kg.gain.linearRampToValueAtTime(a.vel * 2.2, a.time + 0.002);
        kg.gain.setTargetAtTime(0, a.time + 0.002, 0.012);
        k.connect(kg).connect(v.rel);
      }
      o.connect(amp);
      o2.connect(v.gain(0.1)).connect(amp);
      amp.connect(drive(ctx, 3.5)).connect(v.filter('lowpass', 3000)).connect(v.gain(0.62)).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'sub',
    label: 'Sub Bass',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.04, 0.05);
      const o = v.osc('sine');
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.012, 0.3, 0.95, a.vel * 0.62);
      o.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'deepbass',
    label: 'Deep Bass',
    group: 'Bass',
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05);
      const o = v.osc('triangle');
      const o2 = v.osc('sine');
      const lp = v.filter('lowpass', 800, 1.2);
      lp.frequency.setValueAtTime(400 + 1400 * a.vel, a.time);
      lp.frequency.setTargetAtTime(260, a.time + 0.01, 0.12);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.006, 0.35, 0.55, a.vel * 0.55);
      o.connect(lp);
      o2.connect(lp);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'reese',
    label: 'Reese Bass',
    group: 'Bass',
    mono: true,
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06, 0.06);
      const lp = v.filter('lowpass', 750, 2.5);
      v.lfo(lp.frequency, 0.35, 280);
      for (const d of [-16, 16]) v.osc('sawtooth', 1, d).connect(lp);
      const sub = v.osc('sine');
      const sg = v.gain(0.6);
      sub.connect(sg);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.01, 0.4, 0.9, a.vel * 0.45);
      lp.connect(amp);
      sg.connect(amp);
      amp.connect(drive(ctx, 1.6)).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'logdrum',
    label: 'Log Drum',
    group: 'Bass',
    octave: 1,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.05);
      const o = v.osc('sine');
      o.frequency.cancelScheduledValues(a.time);
      o.frequency.setValueAtTime(v.f * 1.6, a.time);
      o.frequency.exponentialRampToValueAtTime(v.f, a.time + 0.035);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.003, 0.18, 0, a.vel);
      const hp = v.filter('highpass', 35);
      o.connect(amp).connect(drive(ctx, 3.2)).connect(hp).connect(v.gain(0.5)).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'pluck',
    label: 'Pluck',
    group: 'Pluck',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.08);
      const lp = v.filter('lowpass', 1000, 2);
      lp.frequency.setValueAtTime(2200 + 5000 * a.vel, a.time);
      lp.frequency.setTargetAtTime(380, a.time + 0.005, 0.11);
      v.osc('sawtooth').connect(lp);
      const sq = v.osc('square', 1, -9);
      const sg = v.gain(0.4);
      sq.connect(sg).connect(lp);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.22, 0, a.vel * 0.5);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'marimba',
    label: 'Marimba',
    group: 'Mallet',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.06);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.28, 0, a.vel * 0.6);
      v.osc('sine').connect(amp);
      const h = v.osc('sine', 4);
      const hg = v.gain(0);
      hg.gain.setValueAtTime(0.35 * a.vel, a.time);
      hg.gain.setTargetAtTime(0, a.time, 0.03);
      h.connect(hg).connect(v.rel);
      amp.connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'epiano',
    label: 'Electric Piano',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.2);
      const car = v.osc('sine');
      const mod = v.osc('sine', 1);
      const mg = v.gain(0);
      mg.gain.setValueAtTime(v.f * (1.2 + 2.4 * a.vel), a.time);
      mg.gain.setTargetAtTime(v.f * 0.35, a.time + 0.005, 0.35);
      mod.connect(mg).connect(car.frequency);
      const tine = v.osc('sine', 14);
      const tg = v.gain(0);
      tg.gain.setValueAtTime(v.f * 1.6 * a.vel, a.time);
      tg.gain.setTargetAtTime(0, a.time, 0.018);
      tine.connect(tg).connect(car.frequency);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.003, 0.9, 0.3, a.vel * 0.34);
      const trem = v.gain(1);
      v.lfo(trem.gain, 4.6, 0.12, 0.2);
      car.connect(amp).connect(trem).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'piano',
    label: 'Piano',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.14);
      const w = wave(ctx, 'piano', [0, 1, 0.55, 0.32, 0.2, 0.13, 0.08, 0.05, 0.035, 0.02]);
      const lp = v.filter('lowpass', 3000, 0.5);
      lp.frequency.setValueAtTime(1800 + 7000 * a.vel, a.time);
      lp.frequency.setTargetAtTime(900 + 700 * a.vel, a.time + 0.005, 0.5);
      v.osc('custom', 1, -3, w).connect(lp);
      v.osc('custom', 1, 3, w).connect(lp);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 1.1, 0.0, a.vel * 0.32);
      lp.connect(amp).connect(v.rel);
      const n = v.noise();
      const bp = v.filter('bandpass', 2500, 0.8);
      const ng = v.gain(0);
      ng.gain.setValueAtTime(0.05 * a.vel, a.time);
      ng.gain.setTargetAtTime(0, a.time, 0.008);
      n.connect(bp).connect(ng).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'organ',
    label: 'Organ',
    group: 'Keys',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.03);
      const w = wave(ctx, 'organ', [0, 1, 0.75, 0.55, 0.45, 0, 0.3, 0, 0.22]);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.006, 0.1, 0.95, a.vel * 0.22);
      const trem = v.gain(1);
      v.lfo(trem.gain, 5.9, 0.14);
      v.osc('custom', 1, 0, w).connect(amp);
      v.osc('custom', 0.5, 2, w).connect(v.gain(0.4)).connect(amp);
      amp.connect(trem).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'pad',
    label: 'Warm Pad',
    group: 'Pad',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.45);
      const lp = v.filter('lowpass', 1300, 0.9);
      v.lfo(lp.frequency, 0.18, 350);
      for (const d of [-10, 0, 10]) v.osc('sawtooth', 1, d).connect(lp);
      v.osc('sine', 0.5).connect(v.gain(0.5)).connect(lp);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.5, 0.8, 0.85, a.vel * 0.16);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'strings',
    label: 'Strings',
    group: 'Strings',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.3);
      const lp = v.filter('lowpass', 2600, 0.7);
      const oscs = [v.osc('sawtooth', 1, -7), v.osc('sawtooth', 1, 7), v.osc('sawtooth', 2, 3)];
      oscs[2].connect(v.gain(0.25)).connect(lp);
      oscs[0].connect(lp);
      oscs[1].connect(lp);
      for (const o of oscs) v.lfo(o.detune, 5.3, 9, 0.3);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.2, 0.5, 0.9, a.vel * 0.2);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'darkstrings',
    label: 'Dark Strings (wide)',
    group: 'Strings',
    octave: 4,
    build(ctx, out, a) {
      // Warm, very wide string pad: detuned saw pairs hard left / right through soft low-pass filters.
      const v = new VoiceKit(ctx, out, a, 0.45);
      for (const [side, dets] of [
        [-1, [-11, 4]],
        [1, [11, -4]],
      ] as const) {
        const lp = v.filter('lowpass', 2300, 0.5);
        v.lfo(lp.frequency, side < 0 ? 0.21 : 0.17, 160);
        const lp2 = v.filter('lowpass', 4500, 0.5);
        for (const d of dets) {
          const o = v.osc('sawtooth', 1, d);
          v.lfo(o.detune, 4.6, 5, 0.4);
          o.connect(lp);
        }
        // Tone shaping measured against a reference string pad: scoop the 1.2 kHz honk, add air.
        const scoop = v.filter('peaking', 1250, 0.9);
        scoop.gain.value = -6;
        const air = v.filter('highshelf', 3500, 0.7);
        air.gain.value = 1;
        const amp = v.gain(0);
        v.adsr(amp.gain, 0.28, 0.8, 0.9, a.vel * 0.12);
        lp.connect(lp2).connect(scoop).connect(air).connect(amp).connect(v.panned(side));
      }
      const body = v.osc('triangle');
      const bg = v.gain(0);
      v.adsr(bg.gain, 0.2, 0.8, 0.9, a.vel * 0.04);
      body.connect(bg).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'choir',
    label: 'Choir',
    group: 'Vocal',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.35);
      const src = v.gain(1);
      v.osc('sawtooth', 1, -6).connect(src);
      v.osc('sawtooth', 1, 6).connect(src);
      const mix = v.gain(1);
      for (const [f, q, g] of [
        [730, 8, 1],
        [1090, 9, 0.5],
        [2440, 10, 0.25],
      ] as const) {
        const bp = v.filter('bandpass', f, q);
        src.connect(bp).connect(v.gain(g)).connect(mix);
      }
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.3, 0.6, 0.9, a.vel * 1.1);
      const vib = v.gain(1);
      v.lfo(vib.gain, 5, 0.06, 0.25);
      mix.connect(amp).connect(vib).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'supersaw',
    label: 'Supersaw',
    group: 'Lead',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.14);
      const lp = v.filter('lowpass', 5200, 0.6);
      for (const d of [-24, -12, 0, 12, 24]) v.osc('sawtooth', 1, d).connect(lp);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.008, 0.3, 0.75, a.vel * 0.11);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'lead',
    label: 'Synth Lead',
    group: 'Lead',
    mono: true,
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.07, 0.05);
      const lp = v.filter('lowpass', 3400, 1.2);
      const o1 = v.osc('square');
      const o2 = v.osc('sawtooth', 1, 7);
      o1.connect(v.gain(0.6)).connect(lp);
      o2.connect(lp);
      v.lfo(o1.detune, 5.6, 14, 0.25);
      v.lfo(o2.detune, 5.6, 14, 0.25);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.01, 0.2, 0.8, a.vel * 0.22);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'flute',
    label: 'Flute',
    group: 'Woodwind',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.09);
      const o = v.osc('sine');
      const o2 = v.osc('triangle', 2);
      v.lfo(o.detune, 5.2, 11, 0.2);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.06, 0.3, 0.85, a.vel * 0.42);
      o.connect(amp);
      o2.connect(v.gain(0.08)).connect(amp);
      const n = v.noise();
      const bp = v.filter('bandpass', v.f * 2, 3);
      const ng = v.gain(0);
      v.adsr(ng.gain, 0.03, 0.15, 0.25, a.vel * 0.12);
      n.connect(bp).connect(ng).connect(amp);
      amp.connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'sinelead',
    label: 'Sine Lead',
    group: 'Lead',
    octave: 5,
    build(ctx, out, a) {
      // Soft trap lead: a near-sine tone with a quick swell and a fast fade, a little vibrato.
      const v = new VoiceKit(ctx, out, a, 0.08);
      const o = v.osc('sine');
      v.lfo(o.detune, 5.5, 8, 0.15);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.022, 0.14, 0.12, a.vel * 0.4);
      o.connect(amp);
      v.osc('sine', 2).connect(v.gain(0.22)).connect(amp);
      v.osc('sine', 3).connect(v.gain(0.07)).connect(amp);
      amp.connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'brass',
    label: 'Brass',
    group: 'Brass',
    octave: 4,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.08);
      const lp = v.filter('lowpass', 500, 1);
      lp.frequency.setValueAtTime(400, a.time);
      lp.frequency.linearRampToValueAtTime(1200 + 2600 * a.vel, a.time + 0.07);
      lp.frequency.setTargetAtTime(1500, a.time + 0.08, 0.3);
      v.osc('sawtooth', 1, -5).connect(lp);
      v.osc('sawtooth', 1, 5).connect(lp);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.035, 0.3, 0.85, a.vel * 0.17);
      lp.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'chip',
    label: 'Chiptune',
    group: 'Lead',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.02);
      const o = v.osc('custom', 1, 0, wave(ctx, 'pulse25', pulseHarmonics(0.25)));
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 0.15, 0.7, a.vel * 0.5);
      o.connect(amp).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'bell',
    label: 'Bell',
    group: 'Bell',
    octave: 5,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.35);
      const car = v.osc('sine');
      const mod = v.osc('sine', 3.5);
      const mg = v.gain(0);
      mg.gain.setValueAtTime(v.f * 3.2 * a.vel, a.time);
      mg.gain.setTargetAtTime(v.f * 0.2, a.time, 0.5);
      mod.connect(mg).connect(car.frequency);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.002, 1.1, 0, a.vel * 0.3);
      car.connect(amp).connect(v.rel);
      const p2 = v.osc('sine', 2.76);
      const pg = v.gain(0);
      pg.gain.setValueAtTime(0.08 * a.vel, a.time);
      pg.gain.setTargetAtTime(0, a.time, 0.4);
      p2.connect(pg).connect(v.rel);
      return v.finish();
    },
  },
  {
    id: 'glock',
    label: 'Glockenspiel',
    group: 'Bell',
    octave: 6,
    build(ctx, out, a) {
      const v = new VoiceKit(ctx, out, a, 0.25);
      const amp = v.gain(0);
      v.adsr(amp.gain, 0.001, 0.6, 0, a.vel * 0.3);
      v.osc('sine').connect(amp);
      v.osc('sine', 2.756).connect(v.gain(0.3)).connect(amp);
      v.osc('sine', 5.404).connect(v.gain(0.12)).connect(amp);
      amp.connect(v.rel);
      return v.finish();
    },
  },
];

INSTRUMENTS.push(...EXTRA);

// Real, recorded instruments. While a sample downloads (or offline) a synth stand-in plays.
for (const def of SAMPLED) {
  INSTRUMENTS.push({
    id: def.id,
    label: def.label,
    group: def.group as InstrumentGroup,
    sampled: true,
    mono: def.mono,
    octave: def.octave,
    build(ctx, out, a) {
      return playSample(ctx, out, def, a) ?? instrumentFor(def.fallback).build(ctx, out, a);
    },
  });
}

// A soundfont the user loaded (see userfonts.ts; the scheduler handles it directly).
INSTRUMENTS.push({ id: 'soundfont', label: 'Soundfont (SF2 / SFZ)…', group: 'Sampler', octave: 4, build: () => ({ release: () => {}, kill: () => {} }) });

// The sampler plays the track's own sound (see sampler.ts; the scheduler handles it directly).
INSTRUMENTS.push({ id: 'sampler', label: 'Sampler (your sound)', group: 'Sampler', octave: 3, build: () => ({ release: () => {}, kill: () => {} }) });

export const INSTRUMENT_BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

export function instrumentFor(id: string): InstrumentDef {
  return INSTRUMENT_BY_ID.get(id) ?? INSTRUMENT_BY_ID.get('pluck')!;
}
