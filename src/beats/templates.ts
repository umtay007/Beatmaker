import { BAR, newTrackId, type Song, type Track } from '../core/types';
import { generateSong } from './generator';

function track(name: string, kind: Track['kind'], instrument: string, color: string, extra: Partial<Track> = {}): Track {
  return {
    id: newTrackId(),
    name,
    kind,
    instrument,
    color,
    volume: 0.8,
    pan: 0,
    reverb: kind === 'drums' ? 0.05 : 0.2,
    mute: false,
    solo: false,
    visible: true,
    notes: [],
    ...extra,
  };
}

/** An empty 4-bar project with a drum kit, an 808 and two instruments ready to program. */
export function blankSong(palette: string[]): Song {
  return {
    name: 'Untitled Beat',
    artist: '',
    bpm: 140,
    tempoChanges: [],
    swing: 0,
    bars: 4,
    key: 9,
    scale: 'minor',
    tracks: [
      track('Drums', 'drums', 'trap', palette[0], { volume: 0.9 }),
      track('808', 'synth', 'bass808', palette[1], { reverb: 0 }),
      track('Chords', 'synth', 'epiano', palette[2], { reverb: 0.3 }),
      track('Melody', 'synth', 'bell', palette[3], { reverb: 0.3 }),
    ],
    loop: { enabled: false, start: 0, end: 4 * BAR },
    audioOffset: 0,
    synthsWithAudio: false,
  };
}

/** The beat shown on first launch. */
export function demoSong(palette: string[]): Song {
  const s = generateSong({ genre: 'trap', seed: 20260924, key: 9, scale: 'minor', bpm: 142, bars: 8, palette });
  s.name = 'Night Drive';
  return s;
}
