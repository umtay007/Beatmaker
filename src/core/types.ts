/** Ticks per quarter note. One 16th step = PPQ / 4 = 24 ticks. */
export const PPQ = 96;
export const STEP = PPQ / 4;
export const BEATS_PER_BAR = 4;
export const BAR = PPQ * BEATS_PER_BAR;
/** Longest song (full-length MIDI imports: 1024 bars is 13 minutes at 160 BPM). */
export const MAX_BARS = 1024;

export interface Note {
  id: number;
  /** MIDI pitch. For drum tracks this is a General MIDI drum number (36 = kick, 38 = snare, ...). */
  pitch: number;
  /** Start in ticks. */
  start: number;
  /** Duration in ticks. */
  dur: number;
  /** Velocity 0..1. */
  vel: number;
}

export type TrackKind = 'drums' | 'synth';

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Instrument id (a drum kit id for drum tracks). */
  instrument: string;
  color: string;
  volume: number;
  pan: number;
  /** Reverb send 0..1. */
  reverb: number;
  /** Echo (tempo-synced delay) send 0..1. */
  echo?: number;
  /** Fine tuning of this track in cents (synth tracks). */
  tune?: number;
  /** Sidechain ducking on the song's kick drum: how far the track dips, in dB (0 = off). */
  duck?: number;
  /** How long the ducking takes to swell back, in seconds. */
  duckRelease?: number;
  /** Tone controls in dB: low shelf at 150 Hz, a bell at eqMidFreq and a high shelf at 6 kHz. */
  eqLow?: number;
  eqMid?: number;
  eqMidFreq?: number;
  eqHigh?: number;
  /** Low-cut and high-cut filter cutoffs in Hz (20 and 20000 = off). */
  hpf?: number;
  lpf?: number;
  /** Resonance of the high-cut filter 0..1. */
  res?: number;
  /** The sound and settings of a sampler track (instrument 'sampler'). */
  sampler?: SamplerSettings;
  mute: boolean;
  solo: boolean;
  /** Whether the track is drawn by the visualizer. */
  visible: boolean;
  notes: Note[];
}

export type SamplerMode = 'pitch' | 'slice' | 'loop';

export interface SamplerSettings {
  /** Library file id of the sound (stored in this browser). */
  file: string;
  /** Its original file name. */
  name: string;
  mode: SamplerMode;
  /** Pitch mode: the key that plays the sound at its own pitch. */
  root: number;
  /** Trim: the part of the sound used, 0..1 of its length. */
  start: number;
  end: number;
  /** Slice mode: equal slices when `points` is empty. */
  slices: number;
  /** Slice mode: detected chop points in seconds (from the transients). */
  points?: number[];
  /** Loop mode: how many beats the trimmed sound spans (sets the playback speed). */
  beats: number;
  /** Level in dB. */
  gain: number;
  /** Attack and release in seconds. */
  attack: number;
  release: number;
  reverse: boolean;
}

export const DEFAULT_SAMPLER: Omit<SamplerSettings, 'file' | 'name'> = {
  mode: 'pitch',
  root: 60,
  start: 0,
  end: 1,
  slices: 8,
  beats: 4,
  gain: 0,
  attack: 0.002,
  release: 0.05,
  reverse: false,
};

export interface TempoChange {
  tick: number;
  bpm: number;
}

export interface Song {
  name: string;
  artist: string;
  bpm: number;
  /** Additional tempo changes after tick 0 (normally only present in imported MIDI). */
  tempoChanges: TempoChange[];
  /** Swing 0..1 (0 = straight, 1 = hard shuffle). Applied to off-beat 16ths. */
  swing: number;
  bars: number;
  /** Key root pitch class 0..11. */
  key: number;
  scale: string;
  tracks: Track[];
  loop: { enabled: boolean; start: number; end: number };
  /** Optional backing audio (not persisted; lives in the audio engine). */
  audioOffset: number;
  /** When a backing audio file is loaded: play the synths too? */
  synthsWithAudio: boolean;
  /** Fine tuning of every synth, in cents (match a reference recording that is not at A = 440 Hz). */
  tuning?: number;
  /** Echo delay time in beats (0.75 = dotted 8th, 2/3 = quarter triplet). */
  echoBeats?: number;
  /** Master processing of the song's own tracks (not the reference audio). */
  master?: MasterSettings;
}

export interface MasterSettings {
  /** Graphic EQ gains in dB for 31, 63, 125, 250, 500 Hz, 1, 2, 4, 8 and 16 kHz. */
  eq: number[];
  /** Stereo width: 0 = mono, 1 = unchanged, 2 = twice the side signal. */
  width: number;
  /** Output gain in dB (into the master compressor and limiter). */
  gain: number;
  /** Reverb length in seconds. */
  reverbSize: number;
}

/** Filter cutoffs that mean "off", and the default duck release. */
export const HPF_OFF = 20;
export const LPF_OFF = 20000;
export const DUCK_RELEASE = 0.25;

export const DEFAULT_MASTER: MasterSettings = { eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], width: 1, gain: 0, reverbSize: 2.4 };

let nextNoteId = 1;
export function newNoteId(): number {
  return nextNoteId++;
}
export function bumpNoteIds(song: Song): void {
  for (const t of song.tracks) for (const n of t.notes) if (n.id >= nextNoteId) nextNoteId = n.id + 1;
}

let nextTrackId = 1;
export function newTrackId(): string {
  return 't' + (nextTrackId++).toString(36) + Math.random().toString(36).slice(2, 6);
}

export function songLengthTicks(song: Song): number {
  return song.bars * BAR;
}

export function cloneSong(song: Song): Song {
  return JSON.parse(JSON.stringify(song)) as Song;
}
