/** Ticks per quarter note. One 16th step = PPQ / 4 = 24 ticks. */
export const PPQ = 96;
export const STEP = PPQ / 4;
export const BEATS_PER_BAR = 4;
export const BAR = PPQ * BEATS_PER_BAR;

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
}

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
