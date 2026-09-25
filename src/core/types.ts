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
  mute: boolean;
  solo: boolean;
  /** Whether the track is drawn by the visualizer. */
  visible: boolean;
  notes: Note[];
}

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
