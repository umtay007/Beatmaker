/**
 * A/B metering: taps the remake and the reference (both keep running while only one is heard) to
 * match their loudness and to draw their spectra over each other.
 *
 * Loudness is a K-weighted mean square (a high-pass at 60 Hz and a +4 dB shelf above 1.5 kHz, the
 * shape BS.1770 uses) integrated with a slow decay, so the match settles over a few bars rather than
 * following every kick.
 */

/** Band edges for the spectrum overlay: sixth-octave bands from 30 Hz to 16 kHz. */
export const AB_BANDS = (() => {
  const out: number[] = [];
  for (let f = 30; f < 16000; f *= Math.pow(2, 1 / 6)) out.push(f);
  return out;
})();

interface Side {
  meter: AnalyserNode;
  spectrum: AnalyserNode;
  time: Float32Array<ArrayBuffer>;
  freq: Float32Array<ArrayBuffer>;
  /** Decaying integrated power (K-weighted). */
  power: number;
  /** Averaged band levels in dB (power domain). */
  bands: Float64Array;
}

export class AbMeter {
  private mix: Side;
  private ref: Side;
  private last = 0;
  /** Seconds of playback both sides have been heard for (the match is trusted after a few). */
  private seconds = 0;

  constructor(
    private ctx: AudioContext,
    mixTap: AudioNode,
    refTap: AudioNode,
  ) {
    this.mix = this.side(mixTap);
    this.ref = this.side(refTap);
  }

  private side(tap: AudioNode): Side {
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    const meter = ctx.createAnalyser();
    meter.fftSize = 4096;
    tap.connect(hp).connect(shelf).connect(meter);
    const spectrum = ctx.createAnalyser();
    spectrum.fftSize = 8192;
    spectrum.smoothingTimeConstant = 0;
    tap.connect(spectrum);
    return {
      meter,
      spectrum,
      time: new Float32Array(meter.fftSize),
      freq: new Float32Array(spectrum.frequencyBinCount),
      power: 0,
      bands: new Float64Array(AB_BANDS.length - 1).fill(-120),
    };
  }

  /** Forget the running averages (a new reference, or the song changed a lot). */
  reset(): void {
    for (const s of [this.mix, this.ref]) {
      s.power = 0;
      s.bands.fill(-120);
    }
    this.seconds = 0;
  }

  /** Call regularly while playing (every animation frame is fine; it samples about 8 times a second). */
  update(playing: boolean): void {
    const now = this.ctx.currentTime;
    if (!playing || now - this.last < 0.12) return;
    const dt = Math.min(0.5, now - this.last);
    this.last = now;
    const a = this.read(this.mix);
    const b = this.read(this.ref);
    // Only integrate while both sides make sound (the reference can start later or end sooner).
    if (a < 1e-7 || b < 1e-7) return;
    const k = 1 - Math.exp(-dt / 8);
    this.mix.power += (a - this.mix.power) * (this.seconds ? k : 1);
    this.ref.power += (b - this.ref.power) * (this.seconds ? k : 1);
    this.seconds += dt;
    const ks = 1 - Math.exp(-dt / 3);
    this.bandsInto(this.mix, ks);
    this.bandsInto(this.ref, ks);
  }

  private read(s: Side): number {
    s.meter.getFloatTimeDomainData(s.time);
    let sum = 0;
    for (const v of s.time) sum += v * v;
    return sum / s.time.length;
  }

  private bandsInto(s: Side, k: number): void {
    s.spectrum.getFloatFrequencyData(s.freq);
    const binHz = this.ctx.sampleRate / s.spectrum.fftSize;
    for (let i = 0; i + 1 < AB_BANDS.length; i++) {
      const lo = Math.max(1, Math.floor(AB_BANDS[i] / binHz));
      const hi = Math.max(lo + 1, Math.ceil(AB_BANDS[i + 1] / binHz));
      let p = 0;
      for (let j = lo; j < hi && j < s.freq.length; j++) p += Math.pow(10, s.freq[j] / 10);
      const db = 10 * Math.log10(p + 1e-12);
      s.bands[i] = s.bands[i] <= -119 ? db : s.bands[i] + (db - s.bands[i]) * k;
    }
  }

  /** dB to add to the reference so it is as loud as the remake, or null until there is enough to go on. */
  matchDb(): number | null {
    if (this.seconds < 2 || this.mix.power <= 0 || this.ref.power <= 0) return null;
    return 10 * Math.log10(this.mix.power / this.ref.power);
  }

  /** The two averaged spectra (dB per band, between AB_BANDS edges), or null before any playback. */
  spectra(): { mix: Float64Array; ref: Float64Array } | null {
    if (!this.seconds) return null;
    return { mix: this.mix.bands, ref: this.ref.bands };
  }
}
