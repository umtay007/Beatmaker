/**
 * Real, recorded instruments, streamed on demand from the tonejs-instruments sample set
 * (github.com/nbrosowsky/tonejs-instruments, CC BY 3.0) through the jsDelivr npm CDN.
 *
 * Only the samples a song needs are fetched (the nearest recorded note to every pitch used), then
 * decoded once and cached. Until a sample is ready, or when offline, a synthesized stand-in plays.
 */

export interface SampledDef {
  id: string;
  label: string;
  group: string;
  /** npm package (without the tonejs-instrument- prefix and -mp3 suffix) and version. */
  pkg: string;
  version: string;
  /** Recorded notes, as file names (e.g. "As3" = A#3). */
  notes: string;
  /** Keep every n-th recorded note (dense chromatic sets would mean a lot of downloading). */
  stride?: number;
  /** Synth instrument used while the samples load or when they can't be fetched. */
  fallback: string;
  attack?: number;
  /** Release time constant in seconds. */
  release: number;
  gain: number;
  /** Plucked/struck sounds get darker at low velocity. */
  velocityTone?: boolean;
  /** Sustained instruments: extend notes longer than the recording by cross-fading loops. */
  sustain?: boolean;
  mono?: boolean;
  octave: number;
}

export const SAMPLED: SampledDef[] = [
  { id: 'spiano', label: 'Grand Piano', group: 'Keys', pkg: 'piano', version: '1.1.2', notes: 'C1 Ds1 Fs1 A1 C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6 Ds6 Fs6 A6 C7 Ds7 Fs7 A7 C8', fallback: 'piano', release: 0.35, gain: 0.9, velocityTone: true, octave: 4 },
  { id: 'sorgan', label: 'Pipe Organ', group: 'Keys', pkg: 'organ', version: '1.1.1', notes: 'C1 Ds1 Fs1 A1 C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6', fallback: 'organ', attack: 0.02, release: 0.15, gain: 0.55, sustain: true, octave: 4 },
  { id: 'sharmonium', label: 'Harmonium', group: 'Keys', pkg: 'harmonium', version: '1.1.1', notes: 'C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Gs4 C5', fallback: 'organ', attack: 0.04, release: 0.15, gain: 0.65, sustain: true, octave: 4 },
  { id: 'sguitar', label: 'Acoustic Guitar', group: 'Guitar', pkg: 'guitar-acoustic', version: '1.1.2', notes: 'D2 E2 Fs2 Gs2 As2 C3 D3 E3 Fs3 Gs3 As3 C4 D4 E4 Fs4 Gs4 As4 C5 D5', fallback: 'pluck', release: 0.25, gain: 0.85, velocityTone: true, octave: 3 },
  { id: 'snylon', label: 'Nylon Guitar', group: 'Guitar', pkg: 'guitar-nylon', version: '1.1.1', notes: 'B1 D2 E2 Fs2 Gs2 A2 B2 Cs3 E3 Fs3 G3 A3 B3 Cs4 Ds4 E4 Fs4 Gs4 A4 B4 Cs5 D5 E5 Fs5 G5 Gs5 A5 As5', fallback: 'pluck', release: 0.25, gain: 0.85, velocityTone: true, octave: 3 },
  { id: 'selectric', label: 'Electric Guitar (clean)', group: 'Guitar', pkg: 'guitar-electric', version: '1.1.1', notes: 'Cs2 E2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6', fallback: 'pluck', release: 0.25, gain: 0.8, velocityTone: true, octave: 3 },
  { id: 'sebass', label: 'Electric Bass', group: 'Bass', pkg: 'bass-electric', version: '1.1.2', notes: 'Cs1 E1 G1 As1 Cs2 E2 G2 As2 Cs3 E3 G3 As3 Cs4 E4 G4 As4 Cs5', fallback: 'deepbass', release: 0.12, gain: 1, velocityTone: true, mono: true, octave: 2 },
  { id: 'scontrabass', label: 'Upright Bass', group: 'Bass', pkg: 'contrabass', version: '1.1.2', notes: 'Fs1 G1 As1 C2 D2 E2 Fs2 Gs2 A2 Cs3 E3 Gs3 B3', fallback: 'deepbass', release: 0.2, gain: 1, velocityTone: true, octave: 2 },
  { id: 'sviolin', label: 'Violin', group: 'Strings', pkg: 'violin', version: '1.1.1', notes: 'G3 A3 C4 E4 G4 A4 C5 E5 G5 A5 C6 E6 G6 A6 C7', fallback: 'strings', attack: 0.04, release: 0.25, gain: 0.7, sustain: true, octave: 5 },
  { id: 'scello', label: 'Cello', group: 'Strings', pkg: 'cello', version: '1.1.1', notes: 'C2 D2 E2 Gs2 As2 C3 D3 E3 Fs3 Gs3 As3 C4 D4 E4 Fs4 Gs4 As4 C5', fallback: 'strings', attack: 0.05, release: 0.3, gain: 0.8, sustain: true, octave: 3 },
  { id: 'sharp', label: 'Harp', group: 'Strings', pkg: 'harp', version: '1.1.1', notes: 'E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4 A4 C5 E5 G5 B5 D6 F6 A6 B6 D7 F7', fallback: 'pluck', release: 0.6, gain: 0.85, velocityTone: true, octave: 4 },
  { id: 'strumpet', label: 'Trumpet', group: 'Brass', pkg: 'trumpet', version: '1.1.2', notes: 'C3 F3 A3 As3 Ds4 F4 G4 D5 F5 A5 C6', fallback: 'brass', attack: 0.02, release: 0.15, gain: 0.65, sustain: true, mono: true, octave: 4 },
  { id: 'strombone', label: 'Trombone', group: 'Brass', pkg: 'trombone', version: '1.1.2', notes: 'As1 Cs2 Ds2 F2 Gs2 As2 C3 D3 Ds3 F3 Gs3 As3 C4 Cs4 D4 Ds4 F4', fallback: 'brass', attack: 0.03, release: 0.15, gain: 0.7, sustain: true, mono: true, octave: 3 },
  { id: 'shorn', label: 'French Horn', group: 'Brass', pkg: 'french-horn', version: '1.1.2', notes: 'A1 C2 Ds2 G2 A3 C4 D3 F3 D5 F5', fallback: 'brass', attack: 0.04, release: 0.2, gain: 0.75, sustain: true, octave: 3 },
  { id: 'stuba', label: 'Tuba', group: 'Brass', pkg: 'tuba', version: '1.1.2', notes: 'F1 As1 Ds2 F2 As2 D3 F3 As3 D4', fallback: 'brass', attack: 0.03, release: 0.15, gain: 0.85, sustain: true, mono: true, octave: 2 },
  { id: 'ssax', label: 'Saxophone', group: 'Woodwind', pkg: 'saxophone', version: '1.1.2', notes: 'Cs3 Ds3 F3 G3 A4 As3 B3 Cs4 Ds4 F4 G4 A4 B4 Cs5 Ds5 F5 G5 A5', fallback: 'brass', attack: 0.02, release: 0.15, gain: 0.7, sustain: true, mono: true, octave: 4 },
  { id: 'sflute', label: 'Flute', group: 'Woodwind', pkg: 'flute', version: '1.1.2', notes: 'C4 E4 A4 C5 E5 A5 C6 E6 A6 C7', fallback: 'flute', attack: 0.03, release: 0.15, gain: 0.75, sustain: true, mono: true, octave: 5 },
  { id: 'sclarinet', label: 'Clarinet', group: 'Woodwind', pkg: 'clarinet', version: '1.1.2', notes: 'D3 F3 As3 D4 F4 As4 D5 F5 As5 D6 Fs6', fallback: 'flute', attack: 0.03, release: 0.15, gain: 0.7, sustain: true, mono: true, octave: 4 },
  { id: 'sbassoon', label: 'Bassoon', group: 'Woodwind', pkg: 'bassoon', version: '1.1.2', notes: 'G2 A2 C3 G3 A3 C4 E4 G4 A4 C5', fallback: 'brass', attack: 0.03, release: 0.15, gain: 0.75, sustain: true, mono: true, octave: 3 },
  { id: 'sxylo', label: 'Xylophone', group: 'Mallet', pkg: 'xylophone', version: '1.1.2', notes: 'G4 C5 G5 C6 G6 C7 G7 C8', fallback: 'marimba', release: 0.4, gain: 0.8, velocityTone: true, octave: 5 },
];

export const SAMPLED_BY_ID = new Map(SAMPLED.map((d) => [d.id, d]));

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name: string): number {
  const m = /^([A-G])(s?)(-?\d)$/.exec(name);
  if (!m) return NaN;
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] ? 1 : 0);
}

interface Recorded {
  name: string;
  pitch: number;
}

const recordedCache = new Map<string, Recorded[]>();
function recorded(def: SampledDef): Recorded[] {
  let r = recordedCache.get(def.id);
  if (!r) {
    r = def.notes
      .split(/\s+/)
      .map((name) => ({ name, pitch: noteToMidi(name) }))
      .filter((x) => Number.isFinite(x.pitch))
      .sort((a, b) => a.pitch - b.pitch);
    if (def.stride && def.stride > 1) r = r.filter((_, i) => i % def.stride! === 0);
    recordedCache.set(def.id, r);
  }
  return r;
}

/** The recorded note closest to `pitch`. */
export function nearest(def: SampledDef, pitch: number): Recorded {
  const r = recorded(def);
  let best = r[0];
  for (const x of r) if (Math.abs(x.pitch - pitch) < Math.abs(best.pitch - pitch)) best = x;
  return best;
}

function url(def: SampledDef, name: string): string {
  return `https://cdn.jsdelivr.net/npm/tonejs-instrument-${def.pkg}-mp3@${def.version}/${encodeURIComponent(name)}.mp3`;
}

// ---------------------------------------------------------------------------------------------
// Loading

const buffers = new Map<string, AudioBuffer>();
/** Seconds of near-silence before each recording's attack (up to ~60 ms in this set). */
const leads = new Map<string, number>();

function leadIn(buf: AudioBuffer): number {
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = peak * 0.02; // -34 dB
  let i = 0;
  while (i < d.length && Math.abs(d[i]) < thr) i++;
  return Math.max(0, i / buf.sampleRate - 0.002);
}
const loads = new Map<string, Promise<AudioBuffer | null>>();
let decoder: BaseAudioContext | null = null;
let failed = false;

type Status = { loading: number; failed: boolean };
const listeners = new Set<(s: Status) => void>();
let pending = 0;

/** Get told when sample downloads start/finish or fail (for a loading hint in the UI). */
export function onSampleStatus(fn: (s: Status) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(): void {
  for (const fn of listeners) fn({ loading: pending, failed });
}

// A few downloads at a time: kinder to the CDN and to slow connections than dozens at once.
let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function fetchSample(u: string): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(String(res.status));
      return await res.arrayBuffer();
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

function load(def: SampledDef, name: string): Promise<AudioBuffer | null> {
  const key = def.id + '/' + name;
  let p = loads.get(key);
  if (!p) {
    pending++;
    emit();
    p = (async () => {
      try {
        const data = await slot(() => fetchSample(url(def, name)));
        decoder ??= new OfflineAudioContext(2, 1, 44100);
        const buf = await decoder.decodeAudioData(data);
        leads.set(key, Math.min(0.2, leadIn(buf)));
        buffers.set(key, buf);
        return buf;
      } catch {
        failed = true;
        loads.delete(key); // allow a retry later (e.g. when back online)
        return null;
      } finally {
        pending--;
        emit();
      }
    })();
    loads.set(key, p);
  }
  return p;
}

/** Fetch the samples needed to play these pitches. Resolves when they are ready (or failed). */
export function ensureSampled(id: string, pitches: Iterable<number>): Promise<void> {
  const def = SAMPLED_BY_ID.get(id);
  if (!def) return Promise.resolve();
  const names = new Set<string>();
  for (const p of pitches) names.add(nearest(def, Math.round(p)).name);
  return Promise.all([...names].map((n) => load(def, n))).then(() => undefined);
}

function sampleFor(def: SampledDef, pitch: number): { buf: AudioBuffer; root: number; lead: number } | null {
  const rec = nearest(def, Math.round(pitch));
  const key = def.id + '/' + rec.name;
  const buf = buffers.get(key);
  if (!buf) {
    void load(def, rec.name);
    return null;
  }
  return { buf, root: rec.pitch, lead: leads.get(key) ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Playback

export interface SampleVoice {
  release(t: number): void;
  kill(t: number): void;
}

/**
 * Play a recorded note, or return null if its sample isn't loaded yet (the caller then uses the
 * synth stand-in). `glideFrom` slides the playback rate like a portamento.
 */
export function playSample(
  ctx: BaseAudioContext,
  out: AudioNode,
  def: SampledDef,
  a: { time: number; pitch: number; dur: number | null; vel: number; glideFrom?: number },
): SampleVoice | null {
  const s = sampleFor(def, a.pitch);
  if (!s) return null;
  const rate = (p: number) => Math.pow(2, (p - s.root) / 12);
  const t0 = a.time;
  const rel = ctx.createGain();
  rel.connect(out);
  let dest: AudioNode = rel;
  if (def.velocityTone) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.value = 1400 + 17000 * a.vel * a.vel;
    lp.connect(rel);
    dest = lp;
  }
  const peak = def.gain * Math.pow(Math.max(0.05, a.vel), 1.3);
  const attack = def.attack ?? 0.004;
  const srcs: AudioBufferSourceNode[] = [];
  const startSource = (at: number, offset: number, fadeIn: number, until: number | null) => {
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    if (a.glideFrom !== undefined && a.glideFrom !== a.pitch && offset === s.lead) {
      src.playbackRate.setValueAtTime(rate(a.glideFrom), at);
      src.playbackRate.exponentialRampToValueAtTime(rate(a.pitch), at + 0.08);
    } else src.playbackRate.value = rate(a.pitch);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + fadeIn);
    if (until !== null) {
      g.gain.setValueAtTime(peak, until - 0.25);
      g.gain.linearRampToValueAtTime(0, until);
    }
    src.connect(g).connect(dest);
    src.start(at, offset);
    srcs.push(src);
  };
  startSource(t0, s.lead, attack, null);
  // Sustained instruments: when the note outlasts the recording, cross-fade into repeats of its
  // steady middle section so long pads and held notes don't just stop.
  const sampleSec = (s.buf.duration - s.lead) / rate(a.pitch);
  if (def.sustain && a.dur !== null && a.dur > sampleSec - 0.3) {
    const loopFrom = s.buf.duration * 0.35;
    const segSec = (s.buf.duration * 0.9 - loopFrom) / rate(a.pitch);
    if (segSec > 0.5) {
      let t = t0 + sampleSec - 0.3;
      while (t < t0 + a.dur + 0.5) {
        startSource(t, loopFrom, 0.3, t + segSec);
        t += segSec - 0.3;
      }
    }
  }
  let released = false;
  const stopAll = (at: number) => {
    for (const src of srcs) {
      try {
        src.stop(at);
      } catch {
        /* already stopped */
      }
    }
  };
  const voice: SampleVoice = {
    release: (t: number) => {
      if (released) return;
      released = true;
      const at = Math.max(t, t0 + 0.005);
      rel.gain.setTargetAtTime(0, at, def.release);
      stopAll(at + def.release * 7 + 0.05);
    },
    kill: (t: number) => {
      released = true;
      rel.gain.cancelScheduledValues(t);
      rel.gain.setValueAtTime(rel.gain.value, t);
      rel.gain.setTargetAtTime(0, t, 0.01);
      stopAll(t + 0.1);
    },
  };
  if (a.dur !== null) voice.release(t0 + Math.max(0.01, a.dur));
  return voice;
}

/** Fetch every sample the song's tracks need. */
export function ensureSongSamples(tracks: { kind: string; instrument: string; tune?: number; notes: { pitch: number }[] }[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const t of tracks) {
    if (t.kind !== 'synth' || !SAMPLED_BY_ID.has(t.instrument)) continue;
    const shift = (t.tune ?? 0) / 100;
    jobs.push(ensureSampled(t.instrument, new Set(t.notes.map((n) => Math.round(n.pitch + shift)))));
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Whether any sample download has failed (offline, blocked). */
export function samplesUnavailable(): boolean {
  return failed;
}
