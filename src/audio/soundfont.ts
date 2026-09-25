/**
 * SoundFonts: sample-based instruments the user brings along, as a .sf2 / .sf3 bank or an .sfz
 * instrument with its folder of samples. Parsed here and played with Web Audio as ordinary voices,
 * in a live AudioContext and in offline renders alike.
 *
 * - SF2 (SoundFont 2.01): presets → instruments → samples through their zones and generators: key
 *   and velocity splits, tuning, sample offsets and loops, the volume and modulation envelopes, both
 *   LFOs, the lowpass filter, exclusive classes and stereo pairs. Modulators (pmod/imod) are not
 *   applied, apart from the spec's default velocity → attenuation curve, which is built in.
 * - SF3: SF2 with Ogg Vorbis samples. Those decode asynchronously: await `ready` before playing.
 * - SFZ: a practical subset of the opcodes (see parseSfz).
 *
 * Level: soundfont samples are normalised close to full scale and meant to be turned down by the
 * soundfont's own attenuation and velocity curve, then panned with equal power (-3 dB per side for
 * a centred mono sample, as in FluidSynth). That alone leaves GM banks about 2 dB under the app's
 * recorded instruments (whose -3 dB-peak samples come out at -9 to -5.5 dBFS at velocity 0.8), so
 * LEVEL adds 2 dB: the 128 GM presets of GeneralUser GS then peak at a median of -7.5 dBFS at C4,
 * velocity 0.8 (TimGM6mb: -9.4), where the app's own instruments are.
 */
import type { Voice, VoiceArgs } from './voice';

export interface SfPreset {
  name: string;
  bank: number;
  program: number;
}

/** One recording. SF2 samples are mono: a stereo recording is two samples linked to each other. */
export interface SfSample {
  readonly name: string;
  /** The recording's own sample rate. */
  readonly rate: number;
  /** -1 / 1: the left / right half of an SF2 stereo pair (`link` is the other half); 0: anything else. */
  readonly side: -1 | 0 | 1;
  readonly link: number;
  /** The key it was recorded at, and a correction in cents. */
  readonly root: number;
  readonly correction: number;
  /** The recording's own loop in frames from its start (end exclusive); none when end <= start. */
  readonly loopStart: number;
  readonly loopEnd: number;
  /** The audio. SF2: built from `pcm` on first use; SF3: decoded by `ready`; SFZ: decoded while parsing. */
  buffer: AudioBuffer | null;
  pcm?: Int16Array;
  /** The low bytes of 24-bit SF2 samples (the sm24 chunk). */
  pcm24?: Uint8Array;
}

export interface SfVolEnv {
  /** Seconds (hold and decay as at key 60). */
  delay: number;
  attack: number;
  hold: number;
  /** Seconds for a fall of `fullDb` (the rate of the decay; it stops at the sustain level). */
  decay: number;
  release: number;
  /** Timecents per key that hold / decay shorten by above key 60 (SF2 keynumToVolEnvHold/Decay). */
  holdKey: number;
  decayKey: number;
  /** Sustain level as attenuation in dB; at or past `fullDb` it is silence. */
  sustainDb: number;
  fullDb: number;
}

export interface SfModEnv {
  delay: number;
  attack: number;
  hold: number;
  /** Seconds for a full-scale (1 → 0) change; decay and release are linear. */
  decay: number;
  release: number;
  holdKey: number;
  decayKey: number;
  /** 0..1 */
  sustain: number;
  /** Cents at the envelope's peak. */
  toPitch: number;
  toFc: number;
}

export interface SfLfo {
  delay: number;
  freq: number;
  /** Cents / cents / centibels at full excursion. */
  toPitch: number;
  toFc: number;
  toVol: number;
}

/** A key/velocity region with everything needed to play it (resolved SF2 generators or SFZ opcodes). */
export interface SfZone {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  /** Index into `samples`. */
  sample: number;
  /** Frames from the sample start; `end` is exclusive (Infinity = the sample's end), then moved by `endShift`. */
  start: number;
  end: number;
  endShift: number;
  /** Loop in frames (end exclusive); NaN = the sample's own loop. Either is then moved by the shifts. */
  loopStart: number;
  loopEnd: number;
  loopStartShift: number;
  loopEndShift: number;
  /** 0: no loop, 1: loop, 3: loop while held, then play on to the end. */
  loopMode: 0 | 1 | 3;
  /** Ignores note-off and plays to the end (SFZ one_shot). */
  oneShot: boolean;
  root: number;
  /** Cents per key away from the root (100: chromatic, 0: the same pitch on every key). */
  keyTrack: number;
  tune: number;
  /** Linear gain (attenuation, volume), before velocity. */
  gain: number;
  /** How much of the velocity curve applies: 1 = all of it (level ∝ (vel / 127)²). */
  velTrack: number;
  /** -1..1 */
  pan: number;
  /** SF2 zones with no pan of their own: the halves of a stereo pair go hard left / right. */
  autoPan: boolean;
  /** SF2 keynum / velocity generators (-1: off). */
  fixedKey: number;
  fixedVel: number;
  /** Seconds before it starts (SFZ delay). */
  delay: number;
  env: SfVolEnv;
  modEnv: SfModEnv | null;
  vibLfo: SfLfo | null;
  modLfo: SfLfo | null;
  /** Web Audio terms: Hz, and Q (dB for lowpass / highpass). */
  filter: { type: BiquadFilterType; freq: number; q: number } | null;
  /** A note of group g cuts sounding notes whose offBy is g (SF2 exclusiveClass is both; 0: none). */
  group: number;
  offBy: number;
  /** Round robin: plays on the seqPosition-th of every seqLength notes of a key (1-based). */
  seqLength: number;
  seqPosition: number;
  /** Random choice: plays when a random 0..1 falls in [loRand, hiRand). */
  loRand: number;
  hiRand: number;
}

export interface SoundFont {
  /** INAM (sf2) or file name (sfz). */
  name: string;
  /** Sorted by bank, then program. An SFZ gives exactly one. */
  presets: SfPreset[];
  readonly format: 'sf2' | 'sf3' | 'sfz';
  /**
   * Resolves once every sample can play: at once for SF2 and SFZ, after decoding the compressed
   * samples for SF3 (it rejects if none of them decode). Until then those samples are silent.
   */
  readonly ready: Promise<void>;
  /** SFZ sample files that weren't among the files given or couldn't be decoded (their regions are skipped). */
  readonly missing: string[];
  readonly samples: SfSample[];
  /** The zones of a preset (an index into `presets`), resolved on first use. */
  zones(preset: number): SfZone[];
}

class Font implements SoundFont {
  private cache = new Map<number, SfZone[]>();

  constructor(
    public name: string,
    public presets: SfPreset[],
    readonly format: 'sf2' | 'sf3' | 'sfz',
    readonly samples: SfSample[],
    private readonly resolve: (preset: number) => SfZone[],
    readonly ready: Promise<void>,
    readonly missing: string[],
  ) {}

  zones(preset: number): SfZone[] {
    let z = this.cache.get(preset);
    if (!z) {
      z = preset >= 0 && preset < this.presets.length ? this.resolve(preset) : [];
      this.cache.set(preset, z);
    }
    return z;
  }
}

/** The index in `sf.presets` of a bank / program, or -1. */
export function findPreset(sf: SoundFont, bank: number, program: number): number {
  return sf.presets.findIndex((p) => p.bank === bank && p.program === program);
}

/** parseSoundFont, then wait for SF3 samples to decode. */
export async function loadSoundFont(data: ArrayBuffer, fileName?: string): Promise<SoundFont> {
  const sf = parseSoundFont(data, fileName);
  await sf.ready;
  return sf;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** AudioBuffer rates every browser accepts; others play at one of these with the rate corrected. */
const bufferRate = (rate: number): number => clamp(rate, 8000, 192000);

const decoders = new Map<number, OfflineAudioContext>();
/** A context to decode at the file's own rate, so frame offsets and loop points stay valid. */
function decoder(rate: number): OfflineAudioContext {
  let d = decoders.get(rate);
  if (!d) {
    d = new OfflineAudioContext(1, 1, rate);
    decoders.set(rate, d);
  }
  return d;
}

/** Run `job` over `items`, a few at a time. */
async function pool<T>(items: T[], n: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await job(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function fourcc(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

interface Chunk {
  id: string;
  start: number;
  size: number;
}

/** The RIFF chunks between two offsets (a chunk cut short by the end of the file is clipped to it). */
function riffChunks(v: DataView, from: number, to: number): Chunk[] {
  const out: Chunk[] = [];
  let o = from;
  while (o + 8 <= to) {
    const start = o + 8;
    const size = Math.min(v.getUint32(o + 4, true), to - start);
    out.push({ id: fourcc(v, o), start, size });
    o = start + size + (size & 1);
  }
  return out;
}

function str(v: DataView, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(o + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function baseName(path: string): string {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? '';
  return file.replace(/\.[^.]*$/, '') || file;
}

// ---------------------------------------------------------------------------------------------
// SF2 / SF3

/** Generator numbers (SF2.01 §8.1.2). */
const G = {
  startOfs: 0,
  endOfs: 1,
  loopStartOfs: 2,
  loopEndOfs: 3,
  startCoarse: 4,
  modLfoToPitch: 5,
  vibLfoToPitch: 6,
  modEnvToPitch: 7,
  fc: 8,
  q: 9,
  modLfoToFc: 10,
  modEnvToFc: 11,
  endCoarse: 12,
  modLfoToVol: 13,
  pan: 17,
  delayModLfo: 21,
  freqModLfo: 22,
  delayVibLfo: 23,
  freqVibLfo: 24,
  delayModEnv: 25,
  attackModEnv: 26,
  holdModEnv: 27,
  decayModEnv: 28,
  sustainModEnv: 29,
  releaseModEnv: 30,
  keyToModEnvHold: 31,
  keyToModEnvDecay: 32,
  delayVolEnv: 33,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  keyToVolEnvHold: 39,
  keyToVolEnvDecay: 40,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  loopStartCoarse: 45,
  keynum: 46,
  velocity: 47,
  attenuation: 48,
  loopEndCoarse: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleId: 53,
  sampleModes: 54,
  scaleTuning: 56,
  exclusiveClass: 57,
  rootKey: 58,
} as const;
const GENS = 61;

const DEFAULTS = new Int32Array(GENS);
DEFAULTS[G.fc] = 13500;
for (const g of [21, 23, 25, 26, 27, 28, 30, 33, 34, 35, 36, 38]) DEFAULTS[g] = -12000;
DEFAULTS[G.keynum] = -1;
DEFAULTS[G.velocity] = -1;
DEFAULTS[G.scaleTuning] = 100;
DEFAULTS[G.rootKey] = -1;

/** Generators a preset zone can't offset: sample addresses and instrument-only ones (and the ranges and links). */
const NOT_ADDITIVE = new Uint8Array(GENS);
for (const g of [0, 1, 2, 3, 4, 12, 41, 43, 44, 45, 46, 47, 50, 53, 54, 57, 58]) NOT_ADDITIVE[g] = 1;

/**
 * FluidSynth's (and E-mu hardware's) reading of initialAttenuation: 0.4 cB (0.04 dB) per unit
 * rather than the spec's 0.1 dB, which soundfonts are generally voiced for. The velocity curve is
 * applied at full strength.
 */
const ATTEN_FACTOR = 0.4;

interface Table {
  o: number;
  n: number;
}

interface RawZone {
  gen: Int32Array;
  set: Uint8Array;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  /** Instrument (preset zones) or sample (instrument zones); -1 for a global zone. */
  link: number;
}

interface Zones {
  global: RawZone | null;
  zones: RawZone[];
}

/** The zones in bags [from, to). The first one is global if it doesn't end in the `term` generator. */
function readZones(v: DataView, bag: Table, gen: Table, from: number, to: number, term: number): Zones {
  let global: RawZone | null = null;
  const zones: RawZone[] = [];
  for (let b = from; b < Math.min(to, bag.n - 1); b++) {
    const g0 = v.getUint16(bag.o + b * 4, true);
    const g1 = Math.min(v.getUint16(bag.o + (b + 1) * 4, true), gen.n);
    const z: RawZone = { gen: new Int32Array(GENS), set: new Uint8Array(GENS), keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, link: -1 };
    for (let i = g0; i < g1; i++) {
      const o = gen.o + i * 4;
      const op = v.getUint16(o, true);
      if (op === G.keyRange || op === G.velRange) {
        const lo = v.getUint8(o + 2);
        const hi = v.getUint8(o + 3);
        if (op === G.keyRange) [z.keyLo, z.keyHi] = [lo, hi];
        else [z.velLo, z.velHi] = [lo, hi];
        z.set[op] = 1;
      } else if (op === term) {
        // Anything after the instrument / sample generator is to be ignored.
        z.link = v.getUint16(o + 2, true);
        break;
      } else if (op < GENS) {
        z.gen[op] = v.getInt16(o + 2, true);
        z.set[op] = 1;
      }
    }
    if (z.link >= 0) zones.push(z);
    else if (b === from) global = z;
  }
  return { global, zones };
}

/** A zone's generators over its global zone's, over `base` (the defaults, or zeros for preset offsets). */
function combine(base: Int32Array, global: RawZone | null, local: RawZone) {
  const gen = base.slice();
  const set = new Uint8Array(GENS);
  let [keyLo, keyHi, velLo, velHi] = [0, 127, 0, 127];
  for (const z of global ? [global, local] : [local]) {
    for (let k = 0; k < GENS; k++) {
      if (!z.set[k]) continue;
      gen[k] = z.gen[k];
      set[k] = 1;
    }
    if (z.set[G.keyRange]) [keyLo, keyHi] = [z.keyLo, z.keyHi];
    if (z.set[G.velRange]) [velLo, velHi] = [z.velLo, z.velHi];
  }
  return { gen, set, keyLo, keyHi, velLo, velHi };
}

/** Timecents to seconds; the minimum (-12000, about 1 ms) counts as none. */
const tc = (v: number, max: number): number => (v <= -12000 ? 0 : Math.pow(2, Math.min(v, max) / 1200));
/** Absolute cents to Hz. */
const absCents = (c: number): number => 8.176 * Math.pow(2, c / 1200);

function sf2Zone(g: Int32Array, panSet: boolean, keyLo: number, keyHi: number, velLo: number, velHi: number, sample: number, s: SfSample): SfZone {
  const lfo = (delay: number, freq: number, toPitch: number, toFc: number, toVol: number): SfLfo | null =>
    toPitch || toFc || toVol
      ? {
          delay: tc(clamp(g[delay], -12000, 5000), 5000),
          freq: absCents(clamp(g[freq], -16000, 4500)),
          toPitch: clamp(toPitch, -12000, 12000),
          toFc: clamp(toFc, -12000, 12000),
          toVol: clamp(toVol, -960, 960),
        }
      : null;
  const envPitch = clamp(g[G.modEnvToPitch], -12000, 12000);
  const envFc = clamp(g[G.modEnvToFc], -12000, 12000);
  const fc = clamp(g[G.fc], 1500, 13500);
  const modes = g[G.sampleModes] & 3;
  const time = (gen: number, max: number) => tc(clamp(g[gen], -12000, max), max);
  return {
    keyLo,
    keyHi,
    velLo,
    velHi,
    sample,
    start: g[G.startOfs] + 32768 * g[G.startCoarse],
    end: Infinity,
    endShift: g[G.endOfs] + 32768 * g[G.endCoarse],
    loopStart: NaN,
    loopEnd: NaN,
    loopStartShift: g[G.loopStartOfs] + 32768 * g[G.loopStartCoarse],
    loopEndShift: g[G.loopEndOfs] + 32768 * g[G.loopEndCoarse],
    loopMode: modes === 1 ? 1 : modes === 3 ? 3 : 0,
    oneShot: false,
    root: g[G.rootKey] >= 0 && g[G.rootKey] <= 127 ? g[G.rootKey] : s.root,
    keyTrack: clamp(g[G.scaleTuning], 0, 1200),
    tune: g[G.coarseTune] * 100 + g[G.fineTune],
    gain: Math.pow(10, (-clamp(g[G.attenuation], 0, 1440) * ATTEN_FACTOR) / 200),
    velTrack: 1,
    pan: clamp(g[G.pan], -500, 500) / 500,
    autoPan: !panSet,
    fixedKey: g[G.keynum] >= 0 && g[G.keynum] <= 127 ? g[G.keynum] : -1,
    fixedVel: g[G.velocity] >= 1 && g[G.velocity] <= 127 ? g[G.velocity] : -1,
    delay: 0,
    env: {
      delay: time(G.delayVolEnv, 5000),
      attack: time(G.attackVolEnv, 8000),
      hold: time(G.holdVolEnv, 5000),
      decay: time(G.decayVolEnv, 8000),
      release: time(G.releaseVolEnv, 8000),
      holdKey: clamp(g[G.keyToVolEnvHold], -1200, 1200),
      decayKey: clamp(g[G.keyToVolEnvDecay], -1200, 1200),
      sustainDb: clamp(g[G.sustainVolEnv], 0, 1440) / 10,
      // The spec's decay and release rates: 100 dB per decay / release time.
      fullDb: 100,
    },
    modEnv:
      envPitch || envFc
        ? {
            delay: time(G.delayModEnv, 5000),
            attack: time(G.attackModEnv, 8000),
            hold: time(G.holdModEnv, 5000),
            decay: time(G.decayModEnv, 8000),
            release: time(G.releaseModEnv, 8000),
            holdKey: clamp(g[G.keyToModEnvHold], -1200, 1200),
            decayKey: clamp(g[G.keyToModEnvDecay], -1200, 1200),
            sustain: 1 - clamp(g[G.sustainModEnv], 0, 1000) / 1000,
            toPitch: envPitch,
            toFc: envFc,
          }
        : null,
    vibLfo: lfo(G.delayVibLfo, G.freqVibLfo, g[G.vibLfoToPitch], 0, 0),
    modLfo: lfo(G.delayModLfo, G.freqModLfo, g[G.modLfoToPitch], g[G.modLfoToFc], g[G.modLfoToVol]),
    // Below 13500 cents (about 20 kHz) or when something sweeps it. FluidSynth's Q: 0 cB = no resonance peak.
    filter: fc < 13500 || envFc || g[G.modLfoToFc] ? { type: 'lowpass', freq: absCents(fc), q: clamp(g[G.q], 0, 960) / 10 - 3.01 } : null,
    group: Math.max(0, g[G.exclusiveClass]),
    offBy: Math.max(0, g[G.exclusiveClass]),
    seqLength: 1,
    seqPosition: 1,
    loRand: 0,
    hiRand: 1,
  };
}

/** Decode SF3's Ogg Vorbis samples into their buffers. Rejects only if none of them decode. */
async function decodeOgg(jobs: [SfSample, Uint8Array<ArrayBuffer>][]): Promise<void> {
  let ok = 0;
  await pool(jobs, 6, async ([s, bytes]) => {
    try {
      s.buffer = await decoder(bufferRate(s.rate)).decodeAudioData(bytes.slice().buffer);
      ok++;
    } catch {
      /* this sample stays silent */
    }
  });
  if (!ok) throw new Error('The compressed (Ogg Vorbis) samples of this SF3 file could not be decoded.');
}

/**
 * Parse a .sf2 (or .sf3: Ogg Vorbis samples, decoded asynchronously, await `ready`) file. Throws
 * an Error with a short, human-readable message on bad input.
 */
export function parseSoundFont(data: ArrayBuffer, fileName = ''): SoundFont {
  const v = new DataView(data);
  if (data.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'sfbk') throw new Error('This is not a SoundFont (.sf2) file.');
  // The RIFF size is sometimes wrong: read up to the end of the file instead.
  const top = riffChunks(v, 12, data.byteLength);
  const list = (type: string): Chunk[] => {
    const c = top.find((c) => c.id === 'LIST' && c.size >= 4 && fourcc(v, c.start) === type);
    return c ? riffChunks(v, c.start + 4, c.start + c.size) : [];
  };
  const info = list('INFO');
  const sdta = list('sdta');
  const pdta = list('pdta');
  if (!pdta.length) throw new Error('This soundfont is damaged or incomplete (no preset data).');
  const table = (id: string, size: number): Table => {
    const c = pdta.find((c) => c.id === id);
    const n = c ? Math.floor(c.size / size) : 0;
    if (!c || n < 1) throw new Error(`This soundfont is damaged (its ${id} table is missing).`);
    return { o: c.start, n };
  };
  const phdr = table('phdr', 38);
  const pbag = table('pbag', 4);
  const pgen = table('pgen', 4);
  const inst = table('inst', 22);
  const ibag = table('ibag', 4);
  const igen = table('igen', 4);
  const shdr = table('shdr', 46);
  const inam = info.find((c) => c.id === 'INAM');
  const name = (inam && str(v, inam.start, inam.size)) || baseName(fileName) || 'SoundFont';

  // Samples. The PCM stays in the file's buffer (16-bit) until a note needs it.
  const smpl = sdta.find((c) => c.id === 'smpl');
  const frames = smpl ? smpl.size >> 1 : 0;
  const pcm = !smpl ? null : smpl.start % 2 === 0 ? new Int16Array(data, smpl.start, frames) : new Int16Array(data.slice(smpl.start, smpl.start + frames * 2));
  const sm24 = sdta.find((c) => c.id === 'sm24');
  // The spec says to ignore an sm24 chunk that doesn't match smpl in length.
  const low = sm24 && sm24.size >= frames && sm24.size <= frames + 1 ? new Uint8Array(data, sm24.start, frames) : null;
  const samples: SfSample[] = [];
  const playable: boolean[] = [];
  const ogg: [SfSample, Uint8Array<ArrayBuffer>][] = [];
  for (let i = 0; i < shdr.n - 1; i++) {
    const o = shdr.o + i * 46;
    const start = v.getUint32(o + 20, true);
    const end = v.getUint32(o + 24, true);
    const loopStart = v.getUint32(o + 28, true);
    const loopEnd = v.getUint32(o + 32, true);
    const rate = v.getUint32(o + 36, true);
    const pitch = v.getUint8(o + 40);
    const type = v.getUint16(o + 44, true);
    const compressed = (type & 0x10) !== 0;
    // ROM samples live in a synth's memory, not in the file.
    const ok = !!smpl && !(type & 0x8000) && rate > 0 && end > start && end <= (compressed ? smpl.size : frames);
    const s: SfSample = {
      name: str(v, o, 20),
      rate: rate || 44100,
      side: type & 4 ? -1 : type & 2 ? 1 : 0,
      link: v.getUint16(o + 42, true),
      root: pitch <= 127 ? pitch : 60,
      correction: v.getInt8(o + 41),
      // SF3 loop points are already relative to the sample.
      loopStart: compressed ? loopStart : loopStart - start,
      loopEnd: compressed ? loopEnd : loopEnd - start,
      buffer: null,
    };
    if (ok && compressed) ogg.push([s, new Uint8Array(data, smpl.start + start, end - start)]);
    else if (ok && pcm) {
      s.pcm = pcm.subarray(start, end);
      if (low) s.pcm24 = low.subarray(start, end);
    }
    samples.push(s);
    playable.push(ok);
  }

  // Presets, sorted; their zones are resolved when first played.
  const raw: (SfPreset & { from: number; to: number })[] = [];
  for (let i = 0; i < phdr.n - 1; i++) {
    const o = phdr.o + i * 38;
    raw.push({ name: str(v, o, 20), program: v.getUint16(o + 20, true), bank: v.getUint16(o + 22, true), from: v.getUint16(o + 24, true), to: v.getUint16(o + 38 + 24, true) });
  }
  if (!raw.length) throw new Error('This soundfont has no presets.');
  raw.sort((a, b) => a.bank - b.bank || a.program - b.program);

  const instruments = new Map<number, Zones>();
  const instrument = (i: number): Zones | null => {
    if (i >= inst.n - 1) return null;
    let z = instruments.get(i);
    if (!z) {
      const o = inst.o + i * 22;
      z = readZones(v, ibag, igen, v.getUint16(o + 20, true), v.getUint16(o + 22 + 20, true), G.sampleId);
      instruments.set(i, z);
    }
    return z;
  };
  const zeros = new Int32Array(GENS);
  const resolve = (p: number): SfZone[] => {
    const r = raw[p];
    const pz = readZones(v, pbag, pgen, r.from, r.to, G.instrument);
    const out: SfZone[] = [];
    for (const z of pz.zones) {
      const ins = instrument(z.link);
      if (!ins) continue;
      // Preset generators are offsets on the instrument's; ranges are intersected.
      const P = combine(zeros, pz.global, z);
      for (const iz of ins.zones) {
        if (!playable[iz.link]) continue;
        const I = combine(DEFAULTS, ins.global, iz);
        const keyLo = Math.max(P.keyLo, I.keyLo);
        const keyHi = Math.min(P.keyHi, I.keyHi);
        const velLo = Math.max(P.velLo, I.velLo);
        const velHi = Math.min(P.velHi, I.velHi);
        if (keyLo > keyHi || velLo > velHi) continue;
        const g = I.gen;
        for (let k = 0; k < GENS; k++) if (P.set[k] && !NOT_ADDITIVE[k]) g[k] += P.gen[k];
        out.push(sf2Zone(g, !!(P.set[G.pan] || I.set[G.pan]), keyLo, keyHi, velLo, velHi, iz.link, samples[iz.link]));
      }
    }
    return out;
  };

  const ready = ogg.length ? decodeOgg(ogg) : Promise.resolve();
  // Whoever needs the samples awaits this; meanwhile a failure isn't an unhandled rejection.
  ready.catch(() => undefined);
  return new Font(
    name,
    raw.map(({ name, bank, program }) => ({ name, bank, program })),
    ogg.length ? 'sf3' : 'sf2',
    samples,
    resolve,
    ready,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// SFZ

/** Decay / release rate of SFZ envelopes: e^-9 (about -78 dB) per decay / release time, as sfizz does. */
const SFZ_FULL_DB = (9 * 20) / Math.LN10;

const NOTE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** A key as a number or a note name (c4 = 60, c#4, db4). NaN if it's neither. */
function sfzKey(v: string): number {
  const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(v.trim());
  if (!m) return v.trim() ? Number(v) : NaN;
  return 12 * (Number(m[3]) + 1) + NOTE[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

function normPath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    // Above the top of the folder the user picked: nothing to go up to.
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Strip comments, apply #define and inline #include (up to 8 deep). */
function preprocess(text: string, include: (path: string) => string | null, defines: Map<string, string>, depth: number): string {
  const out: string[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, '');
  for (let line of clean.split(/\r\n|\r|\n/)) {
    const def = /^\s*#define\s+(\$\w+)\s+(.*?)\s*$/.exec(line);
    if (def) {
      defines.set(def[1], def[2]);
      continue;
    }
    if (defines.size) line = line.replace(/\$\w+/g, (m) => defines.get(m) ?? m);
    const inc = /^\s*#include\s+"([^"]+)"/.exec(line);
    if (inc) {
      const t = depth < 8 ? include(inc[1]) : null;
      if (t !== null) out.push(preprocess(t, include, defines, depth + 1));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

type Ops = [string, string][];

interface SfzRaw {
  /** Opcodes in the order they apply: global, master, group, then the region's own. */
  ops: Ops;
  defaultPath: string;
  /** note_offset + 12 × octave_offset. */
  shift: number;
}

/** Headers and opcodes into regions (with what they inherit), and the <control> CC defaults. */
function readSfz(src: string): { regions: SfzRaw[]; cc: Map<number, number> } {
  const regions: SfzRaw[] = [];
  const cc = new Map<number, number>([
    [7, 100],
    [10, 64],
    [11, 127],
  ]);
  let global: Ops = [];
  let master: Ops = [];
  let group: Ops = [];
  let region: Ops | null = null;
  let cur: Ops | null = null;
  let control = false;
  let defaultPath = '';
  let noteOffset = 0;
  let octaveOffset = 0;
  const flush = () => {
    if (region) regions.push({ ops: [...global, ...master, ...group, ...region], defaultPath, shift: noteOffset + 12 * octaveOffset });
    region = null;
  };
  for (const line of src.split('\n')) {
    const toks = [...line.matchAll(/<(\w+)>|([A-Za-z0-9_]+)=/g)];
    for (let i = 0; i < toks.length; i++) {
      const m = toks[i];
      if (m[1] !== undefined) {
        flush();
        control = false;
        cur = null;
        switch (m[1].toLowerCase()) {
          case 'control':
            control = true;
            break;
          case 'global':
            cur = global = [];
            master = [];
            group = [];
            break;
          case 'master':
            cur = master = [];
            group = [];
            break;
          case 'group':
            cur = group = [];
            break;
          case 'region':
            cur = region = [];
            break;
          // <curve>, <effect>, <midi>, <sample>…: not supported, their opcodes are skipped.
        }
        continue;
      }
      // A value runs to the next opcode or header: sample paths may contain spaces.
      const end = i + 1 < toks.length ? toks[i + 1].index : line.length;
      const value = line.slice(m.index + m[0].length, end).trim();
      const op = m[2].toLowerCase();
      if (control) {
        if (op === 'default_path') defaultPath = value;
        else if (op === 'note_offset') noteOffset = num(Number(value), 0);
        else if (op === 'octave_offset') octaveOffset = num(Number(value), 0);
        else if (op.startsWith('set_cc')) cc.set(Number(op.slice(6)), num(Number(value), 0));
      } else cur?.push([op, value]);
    }
  }
  flush();
  return { regions, cc };
}

interface SfzSpec {
  sample: string;
  lokey: number;
  hikey: number;
  center: number | 'sample';
  lovel: number;
  hivel: number;
  tune: number;
  transpose: number;
  volume: number;
  amplitude: number;
  pan: number;
  offset: number;
  end: number;
  loopMode: string;
  loopStart: number;
  loopEnd: number;
  delay: number;
  /** ampeg_ delay, attack, hold, decay, sustain (%), release. */
  eg: number[];
  trigger: string;
  seqLength: number;
  seqPosition: number;
  lorand: number;
  hirand: number;
  group: number;
  offBy: number;
  keytrack: number;
  veltrack: number;
  cutoff: number;
  resonance: number;
  filType: string;
  swLast: number;
  swDefault: number;
  cc: [number, number, number][];
  /** Triggered by a controller rather than a note. */
  onCc: boolean;
}

function sfzSpec(ops: Ops): SfzSpec {
  const r: SfzSpec = {
    sample: '',
    lokey: 0,
    hikey: 127,
    center: 60,
    lovel: 0,
    hivel: 127,
    tune: 0,
    transpose: 0,
    volume: 0,
    amplitude: 100,
    pan: 0,
    offset: 0,
    end: Infinity,
    loopMode: '',
    loopStart: NaN,
    loopEnd: NaN,
    delay: 0,
    eg: [0, 0, 0, 0, 100, 0],
    trigger: 'attack',
    seqLength: 1,
    seqPosition: 1,
    lorand: 0,
    hirand: 1,
    group: 0,
    offBy: 0,
    keytrack: 100,
    veltrack: 100,
    cutoff: NaN,
    resonance: 0,
    filType: 'lpf_2p',
    swLast: NaN,
    swDefault: NaN,
    cc: [],
    onCc: false,
  };
  const eg = ['ampeg_delay', 'ampeg_attack', 'ampeg_hold', 'ampeg_decay', 'ampeg_sustain', 'ampeg_release'];
  for (const [op, val] of ops) {
    const n = Number(val);
    const e = eg.indexOf(op);
    if (e >= 0) {
      r.eg[e] = num(n, r.eg[e]);
      continue;
    }
    switch (op) {
      case 'sample':
        r.sample = val;
        break;
      case 'lokey':
        r.lokey = sfzKey(val);
        break;
      case 'hikey':
        r.hikey = sfzKey(val);
        break;
      case 'key':
        r.lokey = r.hikey = sfzKey(val);
        r.center = r.lokey;
        break;
      case 'pitch_keycenter':
        r.center = val.toLowerCase() === 'sample' ? 'sample' : sfzKey(val);
        break;
      case 'lovel':
        r.lovel = n;
        break;
      case 'hivel':
        r.hivel = n;
        break;
      case 'tune':
      case 'pitch':
        r.tune = n;
        break;
      case 'transpose':
        r.transpose = n;
        break;
      case 'volume':
      case 'gain':
        r.volume = n;
        break;
      case 'amplitude':
        r.amplitude = n;
        break;
      case 'pan':
        r.pan = n;
        break;
      case 'offset':
        r.offset = n;
        break;
      case 'end':
        r.end = n;
        break;
      case 'loop_mode':
      case 'loopmode':
        r.loopMode = val.toLowerCase();
        break;
      case 'loop_start':
      case 'loopstart':
        r.loopStart = n;
        break;
      case 'loop_end':
      case 'loopend':
        r.loopEnd = n;
        break;
      case 'delay':
        r.delay = n;
        break;
      case 'trigger':
        r.trigger = val.toLowerCase();
        break;
      case 'seq_length':
        r.seqLength = n;
        break;
      case 'seq_position':
        r.seqPosition = n;
        break;
      case 'lorand':
        r.lorand = n;
        break;
      case 'hirand':
        r.hirand = n;
        break;
      case 'group':
        r.group = n;
        break;
      case 'off_by':
      case 'offby':
        r.offBy = n;
        break;
      case 'pitch_keytrack':
        r.keytrack = n;
        break;
      case 'amp_veltrack':
        r.veltrack = n;
        break;
      case 'cutoff':
        r.cutoff = n;
        break;
      case 'resonance':
        r.resonance = n;
        break;
      case 'fil_type':
      case 'filtype':
        r.filType = val.toLowerCase();
        break;
      case 'sw_last':
        r.swLast = sfzKey(val);
        break;
      case 'sw_default':
        r.swDefault = sfzKey(val);
        break;
      default: {
        const c = /^(lo|hi)cc(\d+)$/.exec(op);
        if (c) r.cc.push([Number(c[2]), c[1] === 'lo' ? n : NaN, c[1] === 'hi' ? n : NaN]);
        else if (/^(on|start)_(lo|hi)cc\d+$/.test(op)) r.onCc = true;
      }
    }
  }
  return r;
}

interface FileInfo {
  rate: number;
  root?: number;
  loopStart?: number;
  loopEnd?: number;
}

/** The native sample rate of a WAV / FLAC / Ogg file, and a WAV's smpl-chunk root key and loop. */
function fileInfo(b: ArrayBuffer): FileInfo {
  const v = new DataView(b);
  if (b.byteLength < 12) return { rate: 0 };
  const id = fourcc(v, 0);
  if (id === 'RIFF' && fourcc(v, 8) === 'WAVE') {
    const info: FileInfo = { rate: 0 };
    for (const c of riffChunks(v, 12, b.byteLength)) {
      if (c.id === 'fmt ' && c.size >= 8) info.rate = v.getUint32(c.start + 4, true);
      else if (c.id === 'smpl' && c.size >= 36) {
        const unity = v.getUint32(c.start + 12, true);
        if (unity <= 127) info.root = unity;
        if (v.getUint32(c.start + 28, true) > 0 && c.size >= 60) {
          info.loopStart = v.getUint32(c.start + 44, true);
          // WAV loop ends are inclusive.
          info.loopEnd = v.getUint32(c.start + 48, true) + 1;
        }
      }
    }
    return info;
  }
  if (id === 'fLaC' && b.byteLength >= 21) return { rate: (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4) };
  if (id === 'OggS') {
    const bytes = new Uint8Array(b, 0, Math.min(b.byteLength, 512));
    const text = String.fromCharCode(...bytes);
    const vorbis = text.indexOf('\x01vorbis');
    if (vorbis >= 0 && vorbis + 16 <= bytes.length) return { rate: v.getUint32(vorbis + 12, true) };
    if (text.includes('OpusHead')) return { rate: 48000 };
  }
  return { rate: 0 };
}

/**
 * Parse an .sfz instrument. `files` maps sample paths (relative to the .sfz's folder, forward
 * slashes, as the user's folder pick gives them) to their bytes; paths are matched
 * case-insensitively, also relative to `sfzPath`'s folder. Regions whose sample is missing are
 * skipped (listed in `missing`); throws only if nothing is playable.
 *
 * Supported: <control> (default_path, note_offset, octave_offset, set_ccN), <global>, <master>,
 * <group>, <region>; #define and #include; sample, lokey/hikey/key (numbers or note names),
 * pitch_keycenter (or "sample"), lovel/hivel, tune, transpose, pitch_keytrack, volume, amplitude,
 * amp_veltrack, pan, offset, end, loop_mode, loop_start/loop_end, delay, ampeg_delay / attack / hold /
 * decay / sustain / release, cutoff / resonance / fil_type, seq_length / seq_position, lorand /
 * hirand, group / off_by, loccN / hiccN (against the default CC values), sw_last / sw_default (the
 * default keyswitch only). Regions with trigger=release / release_key / legato, or triggered by a
 * CC, are skipped; trigger=first plays as attack. LFOs, filter / pitch envelopes, velocity curves
 * and other opcodes are ignored.
 */
export async function parseSfz(text: string, files: Map<string, ArrayBuffer>, sfzPath: string): Promise<SoundFont> {
  const here = normPath(sfzPath);
  const dir = here.includes('/') ? here.slice(0, here.lastIndexOf('/') + 1) : '';
  const index = new Map<string, string>();
  for (const k of files.keys()) index.set(normPath(k).toLowerCase(), k);
  const find = (rel: string): string | null => {
    const p = normPath(rel).toLowerCase();
    const exact = index.get(normPath(dir + rel).toLowerCase()) ?? index.get(p);
    if (exact) return exact;
    // The folder pick may key files from another root than the .sfz path: match the path's tail.
    let best: string | null = null;
    for (const [low, k] of index) if ((low === p || low.endsWith('/' + p)) && (!best || k.length < best.length)) best = k;
    return best;
  };
  const include = (p: string): string | null => {
    const k = find(p);
    const b = k ? files.get(k) : undefined;
    return b ? new TextDecoder().decode(b) : null;
  };
  const { regions, cc } = readSfz(preprocess(text, include, new Map(), 0));

  let specs = regions
    .map((r) => ({ r, s: sfzSpec(r.ops) }))
    .filter(({ s }) => {
      if (!s.sample || s.onCc || !(s.hikey >= s.lokey) || s.hikey < 0) return false;
      if (s.trigger === 'release' || s.trigger === 'release_key' || s.trigger === 'legato') return false;
      return s.cc.every(([n, lo, hi]) => {
        const val = cc.get(n) ?? 0;
        return !(val < lo) && !(val > hi);
      });
    });
  // Keyswitched instruments: play the default articulation (or the lowest one).
  const switches = specs.filter(({ s }) => Number.isFinite(s.swLast));
  if (switches.length) {
    const sw = specs.find(({ s }) => Number.isFinite(s.swDefault))?.s.swDefault ?? Math.min(...switches.map(({ s }) => s.swLast));
    specs = specs.filter(({ s }) => !Number.isFinite(s.swLast) || s.swLast === sw);
  }

  const missing = new Set<string>();
  const wanted = new Map<string, string>(); // file key → the path as written
  const keyOf = new Map<SfzSpec, string>();
  for (const { r, s } of specs) {
    const path = r.defaultPath + s.sample;
    // Built-in generators (*sine, *noise…) aren't supported.
    const k = s.sample.startsWith('*') ? null : find(path);
    if (!k) missing.add(normPath(path));
    else {
      keyOf.set(s, k);
      wanted.set(k, path);
    }
  }

  const samples: SfSample[] = [];
  const sampleOf = new Map<string, number>();
  await pool([...wanted.keys()], 6, async (k) => {
    const bytes = files.get(k)!;
    const info = fileInfo(bytes);
    try {
      // slice: decodeAudioData takes the buffer away, and it's the caller's.
      const buf = await decoder(bufferRate(info.rate || 44100)).decodeAudioData(bytes.slice(0));
      sampleOf.set(k, samples.length);
      samples.push({
        name: k,
        rate: buf.sampleRate,
        side: 0,
        link: -1,
        root: info.root ?? 60,
        correction: 0,
        loopStart: info.loopStart ?? -1,
        loopEnd: info.loopEnd ?? -1,
        buffer: buf,
      });
    } catch {
      missing.add(normPath(wanted.get(k)!));
    }
  });

  const zones: SfZone[] = [];
  for (const { r, s } of specs) {
    const k = keyOf.get(s);
    const idx = k === undefined ? undefined : sampleOf.get(k);
    if (idx === undefined) continue;
    const smp = samples[idx];
    const frames = smp.buffer!.length;
    const offset = Math.max(0, num(s.offset, 0));
    // SFZ ends (sample and loop) are inclusive.
    const end = Number.isFinite(s.end) ? s.end + 1 : Infinity;
    // end=0 / end=-1 silence a region.
    if (end <= Math.max(1, offset)) continue;
    const hasLoop = smp.loopEnd > smp.loopStart;
    const mode = s.loopMode || (hasLoop || Number.isFinite(s.loopStart) ? 'loop_continuous' : 'no_loop');
    const loopMode = mode === 'loop_continuous' ? 1 : mode === 'loop_sustain' ? 3 : 0;
    const [delay, attack, hold, decay, sustain, release] = s.eg.map((x) => Math.max(0, x));
    const filter = s.cutoff > 0 ? s.filType : '';
    const ftype: BiquadFilterType = filter.startsWith('hpf') ? 'highpass' : filter.startsWith('bpf') ? 'bandpass' : filter.startsWith('brf') ? 'notch' : 'lowpass';
    const center = s.center === 'sample' ? smp.root : num(s.center, 60);
    zones.push({
      keyLo: s.lokey - r.shift,
      keyHi: s.hikey - r.shift,
      velLo: num(s.lovel, 0),
      velHi: num(s.hivel, 127),
      sample: idx,
      start: offset,
      end,
      endShift: 0,
      loopStart: Number.isFinite(s.loopStart) ? s.loopStart : hasLoop ? smp.loopStart : 0,
      loopEnd: Number.isFinite(s.loopEnd) ? s.loopEnd + 1 : hasLoop ? smp.loopEnd : frames,
      loopStartShift: 0,
      loopEndShift: 0,
      loopMode,
      oneShot: mode === 'one_shot',
      root: center - r.shift,
      keyTrack: num(s.keytrack, 100),
      tune: num(s.tune, 0) + 100 * num(s.transpose, 0),
      gain: Math.pow(10, num(s.volume, 0) / 20) * (clamp(num(s.amplitude, 100), 0, 100) / 100),
      velTrack: clamp(num(s.veltrack, 100) / 100, 0, 1),
      pan: clamp(num(s.pan, 0) / 100, -1, 1),
      autoPan: false,
      fixedKey: -1,
      fixedVel: -1,
      delay: num(s.delay, 0),
      env: {
        delay,
        attack,
        hold,
        decay,
        release,
        holdKey: 0,
        decayKey: 0,
        sustainDb: sustain >= 100 ? 0 : sustain <= 0 ? Infinity : -20 * Math.log10(sustain / 100),
        fullDb: SFZ_FULL_DB,
      },
      modEnv: null,
      vibLfo: null,
      modLfo: null,
      filter: filter ? { type: ftype, freq: s.cutoff, q: ftype === 'lowpass' || ftype === 'highpass' ? num(s.resonance, 0) - 3.01 : Math.max(0.1, 0.707 * Math.pow(10, num(s.resonance, 0) / 20)) } : null,
      group: num(s.group, 0),
      offBy: num(s.offBy, 0),
      seqLength: Math.max(1, num(s.seqLength, 1)),
      seqPosition: num(s.seqPosition, 1),
      loRand: num(s.lorand, 0),
      hiRand: num(s.hirand, 1),
    });
  }
  const lost = [...missing].sort();
  if (!zones.length) {
    throw new Error(lost.length ? `Nothing to play in this SFZ: ${lost.length} sample file${lost.length > 1 ? 's are' : ' is'} missing (e.g. ${lost[0]}).` : 'Nothing to play in this SFZ (no regions with a sample).');
  }
  const name = baseName(sfzPath) || 'SFZ';
  return new Font(name, [{ name, bank: 0, program: 0 }], 'sfz', samples, () => zones, Promise.resolve(), lost);
}

// ---------------------------------------------------------------------------------------------
// Playback

/** Output gain of a full-scale sample at full velocity and no attenuation (see the note at the top). */
const LEVEL = 1.25;
/** kill(): about -22 dB after 10 ms. */
const KILL_TAU = 0.004;
/** The shortest release (time constant), against clicks. */
const MIN_TAU = 0.003;
const GLIDE = 0.08;
/** Cross-fade from the looping source to the tail on release (loop mode 3). */
const XFADE = 0.005;

/** SF2 sample data as an AudioBuffer (made once, then cached on the sample). */
function sampleBuffer(s: SfSample): AudioBuffer | null {
  if (s.buffer || !s.pcm || !s.pcm.length) return s.buffer;
  const pcm = s.pcm;
  const low = s.pcm24;
  const buf = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate: bufferRate(s.rate) });
  const d = buf.getChannelData(0);
  if (low) for (let i = 0; i < pcm.length; i++) d[i] = (pcm[i] * 256 + low[i]) / 8388608;
  else for (let i = 0; i < pcm.length; i++) d[i] = pcm[i] / 32768;
  s.buffer = buf;
  s.pcm = s.pcm24 = undefined;
  return buf;
}

/**
 * Build the audio a preset plays ahead of its first notes (SF2 samples are otherwise converted on
 * first use, which for a long sample is a few ms of work in the middle of scheduling).
 */
export function preparePreset(sf: SoundFont, preset: number): void {
  for (const z of sf.zones(preset)) {
    const s = sf.samples[z.sample];
    sampleBuffer(s);
    if (s.side && sf.samples[s.link]) sampleBuffer(sf.samples[s.link]);
  }
}

/**
 * An envelope on a param that knows its own value at any time, so a release or a cut can carry on
 * from exactly where it is (the `.value` of an automated param can't be relied on). Volume
 * envelopes decay linearly in dB (exponential ramps), `linear` ones (SF2's modulation envelope) in
 * value.
 */
class Envelope {
  private readonly tD: number;
  private readonly tA: number;
  private readonly tH: number;
  private readonly tS: number;
  private readonly sus: number;
  /** Where the decay ramp ends: an exponential ramp can't reach 0, so a silent sustain goes to -100 dB, then cuts. */
  private readonly low: number;
  private readonly exp: boolean;
  private readonly peak: number;
  private fadeAt = Infinity;
  private fadeFrom = 0;
  private fadeTau = 1;

  constructor(
    private readonly p: AudioParam,
    t0: number,
    delay: number,
    attack: number,
    hold: number,
    decay: number,
    peak: number,
    sustain: number,
    private readonly linear = false,
  ) {
    // No decay time: rise straight to the sustain level rather than jump down to it after the attack.
    if (decay <= 0 && sustain < 1) {
      peak *= sustain;
      sustain = 1;
    }
    this.peak = peak;
    this.exp = !linear && peak > 0;
    this.tD = t0 + delay;
    this.tA = this.tD + Math.max(0.001, attack);
    this.tH = this.tA + hold;
    this.sus = peak * sustain;
    this.low = this.exp ? Math.max(this.sus, peak * 1e-5) : this.sus;
    this.tS = sustain < 1 ? this.tH + decay : this.tH;
    p.setValueAtTime(0, t0);
    if (this.tD > t0) p.setValueAtTime(0, this.tD);
    p.linearRampToValueAtTime(peak, this.tA);
    if (this.tH > this.tA) p.setValueAtTime(peak, this.tH);
    if (this.tS > this.tH) {
      if (this.exp) p.exponentialRampToValueAtTime(this.low, this.tS);
      else p.linearRampToValueAtTime(this.low, this.tS);
    }
    if (sustain < 1 && (this.tS === this.tH || this.low !== this.sus)) p.setValueAtTime(this.sus, this.tS);
  }

  /** When the sustain is silent, the time it gets there (otherwise Infinity). */
  get silentAt(): number {
    return this.sus > 0 ? Infinity : this.tS;
  }

  valueAt(t: number): number {
    if (t >= this.fadeAt) return this.fadeFrom * Math.exp(-(t - this.fadeAt) / this.fadeTau);
    if (t <= this.tD) return 0;
    if (t < this.tA) return (this.peak * (t - this.tD)) / (this.tA - this.tD);
    if (t <= this.tH) return this.peak;
    if (t <= this.tS) return this.decayAt(t);
    return this.sus;
  }

  private decayAt(t: number): number {
    const x = (t - this.tH) / (this.tS - this.tH);
    return this.exp ? this.peak * Math.pow(this.low / this.peak, x) : this.peak + (this.low - this.peak) * x;
  }

  /**
   * Fade out from `t`: towards 0 with time constant `time` (volume), or linearly over `time` ×
   * the current level (linear envelopes).
   */
  fade(t: number, time: number): void {
    const p = this.p;
    const v = this.valueAt(t);
    const before = t < this.fadeAt;
    p.cancelScheduledValues(t);
    if (before) {
      // Cancelling removed the end of the segment playing at `t`: draw it again, up to `t`.
      if (this.exp && t > this.tH && t <= this.tS) p.exponentialRampToValueAtTime(v, t);
      else p.linearRampToValueAtTime(v, t);
    }
    // After an earlier fade, a second setTarget carries on from wherever the first has got to.
    if (this.linear) p.linearRampToValueAtTime(0, t + time * (this.peak > 0 ? v / this.peak : 0) + 0.001);
    else p.setTargetAtTime(0, t, time);
    this.fadeAt = t;
    this.fadeFrom = v;
    this.fadeTau = time;
  }
}

/** One zone of a note. */
interface Layer {
  t0: number;
  offBy: number;
  end(): number;
  release(t: number): void;
  kill(t: number): void;
}

function startZone(ctx: BaseAudioContext, out: AudioNode, s: SfSample, z: SfZone, pan: number, key: number, vel: number, a: VoiceArgs): Layer | null {
  const buf = sampleBuffer(s);
  if (!buf) return null;
  const sr = buf.sampleRate;
  const frames = buf.length;
  const start = clamp(Math.floor(z.start), 0, frames - 1);
  const end = clamp((z.end === Infinity ? frames : z.end) + z.endShift, start + 1, frames);
  const ls = (Number.isNaN(z.loopStart) ? s.loopStart : z.loopStart) + z.loopStartShift;
  const le = (Number.isNaN(z.loopEnd) ? s.loopEnd : z.loopEnd) + z.loopEndShift;
  const loop = z.loopMode !== 0 && !z.oneShot && ls >= 0 && le <= frames && le - ls >= 2 && start < le;
  const t0 = a.time + z.delay;
  const k = z.fixedKey >= 0 ? z.fixedKey : key;
  const v = z.fixedVel >= 0 ? z.fixedVel : vel;
  // The fractional part of the pitch (song tuning) bends like a pitch wheel, whatever the key tracking.
  const cents = (k - z.root) * z.keyTrack + z.tune + s.correction + (a.pitch - key) * 100;
  const rate = Math.pow(2, cents / 1200) * (s.rate / sr);
  const from = a.glideFrom;
  const glide = from !== undefined && from !== a.pitch;
  const pitchMod = glide || !!z.vibLfo?.toPitch || !!z.modLfo?.toPitch || !!z.modEnv?.toPitch;
  const nodes = new Set<AudioScheduledSourceNode>();

  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (glide) {
    src.playbackRate.setValueAtTime(rate * Math.pow(2, (from - a.pitch) / 12), t0);
    src.playbackRate.exponentialRampToValueAtTime(rate, t0 + GLIDE);
  } else src.playbackRate.value = rate;

  // src → [filter] → amp (volume envelope) → [tremolo] → pan → out
  const amp = ctx.createGain();
  // Silent until the note starts, so a ramp scheduled before any other event starts from 0.
  amp.gain.value = 0;
  let head: AudioNode = amp;
  let filter: BiquadFilterNode | null = null;
  if (z.filter) {
    filter = ctx.createBiquadFilter();
    filter.type = z.filter.type;
    filter.frequency.value = Math.min(z.filter.freq, ctx.sampleRate * 0.45);
    filter.Q.value = z.filter.q;
    filter.connect(amp);
    head = filter;
  }
  let last: AudioNode = amp;
  let trem: GainNode | null = null;
  if (z.modLfo?.toVol) {
    trem = ctx.createGain();
    amp.connect(trem);
    last = trem;
  }
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  last.connect(panner).connect(out);

  // Loop mode 3 hands over to a non-looping copy at release, which needs a steady rate to know
  // where the loop is; with glide or pitch modulation it keeps looping through the release instead.
  const handover = loop && z.loopMode === 3 && !pitchMod;
  const loopOut = handover ? ctx.createGain() : null;
  if (loopOut) src.connect(loopOut).connect(head);
  else src.connect(head);
  if (loop) {
    src.loop = true;
    src.loopStart = ls / sr;
    src.loopEnd = le / sr;
    src.start(t0, start / sr);
  } else src.start(t0, start / sr, (end - start) / sr);
  nodes.add(src);

  const route = (node: AudioNode, param: AudioParam, amount: number) => {
    const g = ctx.createGain();
    g.gain.value = amount;
    node.connect(g).connect(param);
  };
  const keyScale = (perKey: number) => Math.pow(2, (perKey * (60 - k)) / 1200);

  const e = z.env;
  const sustain = e.sustainDb >= e.fullDb ? 0 : Math.pow(10, -e.sustainDb / 20);
  const peak = LEVEL * z.gain * (1 - z.velTrack + z.velTrack * (v / 127) ** 2);
  const env = new Envelope(amp.gain, t0, e.delay, e.attack, e.hold * keyScale(e.holdKey), e.decay * keyScale(e.decayKey) * Math.min(1, e.sustainDb / e.fullDb), peak, sustain);
  // The release falls `fullDb` over the release time: that is a time constant of release / ln(10^(fullDb/20)).
  const releaseTau = Math.max(MIN_TAU, (e.release * 20) / (e.fullDb * Math.LN10));

  let modEnv: Envelope | null = null;
  const m = z.modEnv;
  if (m) {
    const cs = ctx.createConstantSource();
    cs.offset.value = 0;
    modEnv = new Envelope(cs.offset, t0, m.delay, m.attack, m.hold * keyScale(m.holdKey), m.decay * keyScale(m.decayKey) * (1 - m.sustain), 1, m.sustain, true);
    if (m.toPitch) route(cs, src.detune, m.toPitch);
    if (m.toFc && filter) route(cs, filter.detune, m.toFc);
    cs.start(t0);
    nodes.add(cs);
  }
  for (const l of [z.vibLfo, z.modLfo]) {
    if (!l) continue;
    // SF2 LFOs are triangles, starting at 0 and rising.
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = l.freq;
    if (l.toPitch) route(o, src.detune, l.toPitch);
    if (l.toFc && filter) route(o, filter.detune, l.toFc);
    if (l.toVol && trem) route(o, trem.gain, (Math.pow(10, l.toVol / 200) - Math.pow(10, -l.toVol / 200)) / 2);
    o.start(t0 + l.delay);
    nodes.add(o);
  }

  let stopAt = Infinity;
  const stop = (t: number) => {
    if (t >= stopAt) return;
    stopAt = t;
    for (const n of nodes) {
      try {
        n.stop(t);
      } catch {
        /* already stopped */
      }
    }
  };
  // Once a silent sustain is reached there's nothing left to hear.
  if (env.silentAt < Infinity) stop(env.silentAt + 0.01);
  const natural = loop || pitchMod ? Infinity : t0 + (end - start) / sr / rate;

  const tail = (at: number) => {
    if (!loopOut || at >= stopAt) return;
    // Where the looping playhead is at `at`, in frames (the rate is steady).
    let pos = start + Math.max(0, at - t0) * rate * sr;
    if (pos >= le) pos = ls + ((pos - ls) % (le - ls));
    if (pos >= end - 1) return;
    const rest = ctx.createBufferSource();
    rest.buffer = buf;
    rest.playbackRate.value = rate;
    const fadeIn = ctx.createGain();
    fadeIn.gain.value = 0;
    fadeIn.gain.setValueAtTime(0, at);
    fadeIn.gain.linearRampToValueAtTime(1, at + XFADE);
    rest.connect(fadeIn).connect(head);
    rest.start(at, pos / sr, (end - pos) / sr);
    loopOut.gain.setValueAtTime(1, at);
    loopOut.gain.linearRampToValueAtTime(0, at + XFADE);
    nodes.delete(src);
    src.stop(at + XFADE + 0.005);
    nodes.add(rest);
  };

  let released = false;
  return {
    t0,
    offBy: z.offBy,
    end: () => Math.min(stopAt, natural),
    release: (t) => {
      if (released || z.oneShot) return;
      released = true;
      const at = Math.max(t, t0 + 0.002);
      env.fade(at, releaseTau);
      modEnv?.fade(at, m!.release);
      tail(at);
      // About -87 dB.
      stop(at + releaseTau * 10 + 0.02);
    },
    kill: (t) => {
      released = true;
      const at = Math.max(t, a.time);
      env.fade(at, KILL_TAU);
      stop(at + KILL_TAU * 12);
    },
  };
}

/** Per context and soundfont: round-robin counters and the notes that exclusive classes may cut. */
interface FontState {
  rr: Map<string, number>;
  sounding: Map<number, Layer[]>;
}
const states = new WeakMap<BaseAudioContext, WeakMap<SoundFont, FontState>>();
function stateOf(ctx: BaseAudioContext, sf: SoundFont): FontState {
  let m = states.get(ctx);
  if (!m) states.set(ctx, (m = new WeakMap()));
  let s = m.get(sf);
  if (!s) m.set(sf, (s = { rr: new Map(), sounding: new Map() }));
  return s;
}

/**
 * Play one note of a preset (an index into `sf.presets`). Returns null if no zone covers the
 * key / velocity (or its samples aren't decoded yet). Works in AudioContext and OfflineAudioContext.
 */
export function playSoundFont(ctx: BaseAudioContext, out: AudioNode, sf: SoundFont, preset: number, a: VoiceArgs): Voice | null {
  const zones = sf.zones(preset);
  if (!zones.length) return null;
  const key = clamp(Math.round(a.pitch), 0, 127);
  const vel = clamp(Math.round(a.vel * 127), 1, 127);
  let hits = zones.filter((z) => key >= z.keyLo && key <= z.keyHi && vel >= z.velLo && vel <= z.velHi);
  if (!hits.length) return null;
  const st = stateOf(ctx, sf);
  if (hits.some((z) => z.seqLength > 1)) {
    const id = preset + '/' + key;
    const n = st.rr.get(id) ?? 0;
    st.rr.set(id, n + 1);
    hits = hits.filter((z) => z.seqLength <= 1 || (n % z.seqLength) + 1 === z.seqPosition);
  }
  if (hits.some((z) => z.loRand > 0 || z.hiRand < 1)) {
    const r = Math.random();
    hits = hits.filter((z) => r >= z.loRand && (r < z.hiRand || z.hiRand >= 1));
  }
  const plays = hits.map((z) => {
    const s = sf.samples[z.sample];
    return { z, pan: z.autoPan && s.side ? s.side : z.pan };
  });
  // A stereo half whose other half no zone plays: play that one too, on the other side.
  for (const z of hits) {
    const s = sf.samples[z.sample];
    const mate = s.side ? sf.samples[s.link] : undefined;
    if (!mate || mate.side !== -s.side || hits.some((o) => o.sample === s.link)) continue;
    plays.push({ z: { ...z, sample: s.link }, pan: z.autoPan ? mate.side : -z.pan });
  }
  const t = a.time;
  const groups = new Set(plays.map((p) => p.z.group).filter((g) => g > 0));
  let sounding = st.sounding.get(preset) ?? [];
  if (groups.size) {
    for (const l of sounding) if (groups.has(l.offBy) && l.t0 <= t && l.end() > t) l.kill(t);
  }
  const layers: Layer[] = [];
  for (const p of plays) {
    const l = startZone(ctx, out, sf.samples[p.z.sample], p.z, p.pan, key, vel, a);
    if (l) layers.push(l);
  }
  if (!layers.length) return null;
  const cuttable = layers.filter((l) => l.offBy > 0);
  if (cuttable.length || sounding.length) {
    sounding = sounding.filter((l) => l.end() > t);
    sounding.push(...cuttable);
    st.sounding.set(preset, sounding);
  }
  const voice: Voice = {
    release: (at) => {
      for (const l of layers) l.release(at);
    },
    kill: (at) => {
      for (const l of layers) l.kill(at);
    },
  };
  if (a.dur !== null) voice.release(t + Math.max(0.01, a.dur));
  return voice;
}
