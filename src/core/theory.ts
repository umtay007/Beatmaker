export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(pitch: number): string {
  return NOTE_NAMES[((pitch % 12) + 12) % 12] + (Math.floor(pitch / 12) - 1);
}

export function pcName(pc: number, preferFlats = false): string {
  const i = ((pc % 12) + 12) % 12;
  return (preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES)[i];
}

export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export const SCALES: Record<string, { label: string; steps: number[] }> = {
  minor: { label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  harmonic: { label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  minpent: { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  majpent: { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export function inScale(pitch: number, key: number, scale: string): boolean {
  const s = SCALES[scale] ?? SCALES.minor;
  return s.steps.includes((((pitch - key) % 12) + 12) % 12);
}

/** Pitch of scale degree `deg` (0-based, may be negative or > 7) above the key root in `octave`. */
export function degreeToPitch(deg: number, key: number, scale: string, octave: number): number {
  const steps = (SCALES[scale] ?? SCALES.minor).steps;
  const n = steps.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return 12 * (octave + 1) + key + steps[idx] + 12 * oct;
}

/** Snap a pitch to the nearest pitch in the scale. */
export function snapToScale(pitch: number, key: number, scale: string): number {
  for (let d = 0; d < 7; d++) {
    if (inScale(pitch - d, key, scale)) return pitch - d;
    if (inScale(pitch + d, key, scale)) return pitch + d;
  }
  return pitch;
}

// ---------------------------------------------------------------------------------------------
// Chord detection

interface ChordShape {
  suffix: string;
  intervals: number[];
  weight: number;
}

const CHORD_SHAPES: ChordShape[] = [
  { suffix: '', intervals: [0, 4, 7], weight: 1.0 },
  { suffix: 'm', intervals: [0, 3, 7], weight: 1.0 },
  { suffix: 'dim', intervals: [0, 3, 6], weight: 0.8 },
  { suffix: 'aug', intervals: [0, 4, 8], weight: 0.7 },
  { suffix: 'sus2', intervals: [0, 2, 7], weight: 0.8 },
  { suffix: 'sus4', intervals: [0, 5, 7], weight: 0.8 },
  { suffix: '7', intervals: [0, 4, 7, 10], weight: 1.05 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], weight: 1.05 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], weight: 1.05 },
  { suffix: 'mMaj7', intervals: [0, 3, 7, 11], weight: 0.8 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], weight: 0.95 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], weight: 0.85 },
  { suffix: '6', intervals: [0, 4, 7, 9], weight: 0.9 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], weight: 0.9 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], weight: 0.95 },
  { suffix: 'm(add9)', intervals: [0, 2, 3, 7], weight: 0.95 },
  { suffix: '9', intervals: [0, 2, 4, 7, 10], weight: 1.1 },
  { suffix: 'maj9', intervals: [0, 2, 4, 7, 11], weight: 1.1 },
  { suffix: 'm9', intervals: [0, 2, 3, 7, 10], weight: 1.1 },
  { suffix: '5', intervals: [0, 7], weight: 0.6 },
];

export interface ChordResult {
  name: string;
  root: number;
  notes: string[];
}

/**
 * Name the chord formed by a set of sounding pitches. Returns null for fewer than two pitch classes.
 */
export function detectChord(pitches: number[], preferFlats = false): ChordResult | null {
  if (pitches.length === 0) return null;
  const sorted = [...pitches].sort((a, b) => a - b);
  const bass = ((sorted[0] % 12) + 12) % 12;
  const pcs = new Set(sorted.map((p) => ((p % 12) + 12) % 12));
  const noteNames = [...new Set(sorted.map((p) => pcName(p, preferFlats)))];
  if (pcs.size < 2) return { name: pcName(bass, preferFlats), root: bass, notes: noteNames };

  let best: { score: number; root: number; shape: ChordShape } | null = null;
  for (let root = 0; root < 12; root++) {
    if (!pcs.has(root)) continue;
    for (const shape of CHORD_SHAPES) {
      const tones = new Set(shape.intervals.map((i) => (root + i) % 12));
      let hit = 0;
      let extra = 0;
      for (const pc of pcs) {
        if (tones.has(pc)) hit++;
        else extra++;
      }
      const missing = tones.size - hit;
      // Missing a fifth is common and forgivable.
      const fifthMissing = shape.intervals.includes(7) && !pcs.has((root + 7) % 12) ? 1 : 0;
      let score = hit * 2 - extra * 1.6 - (missing - fifthMissing) * 2 - fifthMissing * 0.6;
      score *= shape.weight;
      if (root === bass) score += 0.75;
      if (!best || score > best.score) best = { score, root, shape };
    }
  }
  if (!best || best.score < 1.5) return { name: noteNames.join(' '), root: bass, notes: noteNames };
  let name = pcName(best.root, preferFlats) + best.shape.suffix;
  if (best.root !== bass) name += '/' + pcName(bass, preferFlats);
  return { name, root: best.root, notes: noteNames };
}

// ---------------------------------------------------------------------------------------------
// Drum voices (General MIDI numbers): editor rows top to bottom, visualizer lanes bottom to top.

export interface DrumVoice {
  pitch: number;
  name: string;
  short: string;
  key: string; // computer-keyboard key used for live play
}

export const DRUM_VOICES: DrumVoice[] = [
  { pitch: 36, name: 'Kick', short: 'BD', key: 's' },
  { pitch: 38, name: 'Snare', short: 'SD', key: 'd' },
  { pitch: 39, name: 'Clap', short: 'CP', key: 'f' },
  { pitch: 42, name: 'Closed Hat', short: 'HH', key: 'u' },
  { pitch: 46, name: 'Open Hat', short: 'OH', key: 'i' },
  { pitch: 37, name: 'Rim', short: 'RM', key: 'g' },
  { pitch: 70, name: 'Shaker', short: 'SH', key: 'y' },
  { pitch: 63, name: 'Perc', short: 'PC', key: 'r' },
  { pitch: 56, name: 'Cowbell', short: 'CB', key: 't' },
  { pitch: 45, name: 'Low Tom', short: 'LT', key: 'h' },
  { pitch: 47, name: 'Mid Tom', short: 'MT', key: 'j' },
  { pitch: 50, name: 'High Tom', short: 'HT', key: 'k' },
  { pitch: 49, name: 'Crash', short: 'CR', key: 'o' },
  { pitch: 51, name: 'Ride', short: 'RD', key: 'p' },
];

export const DRUM_BY_PITCH = new Map(DRUM_VOICES.map((v) => [v.pitch, v]));

/** Map any General MIDI drum number onto one of the supported voices. */
export function normalizeDrumPitch(p: number): number {
  if (DRUM_BY_PITCH.has(p)) return p;
  const map: Record<number, number> = {
    27: 37, 28: 38, 31: 37, 33: 37, 34: 56, 35: 36, 40: 38, 41: 45, 43: 45, 44: 42, 48: 50, 52: 49,
    53: 51, 54: 70, 55: 49, 57: 49, 58: 63, 59: 51, 60: 63, 61: 63, 62: 63, 64: 63, 65: 50, 66: 47,
    67: 56, 68: 56, 69: 70, 71: 63, 72: 63, 73: 70, 74: 70, 75: 37, 76: 63, 77: 63, 78: 63, 79: 63,
    80: 56, 81: 56, 82: 70, 86: 36, 87: 36,
  };
  if (map[p]) return map[p];
  if (p < 36) return 36;
  return p > 81 ? 70 : 63;
}

// ---------------------------------------------------------------------------------------------
// Key estimation (Krumhansl–Kessler profiles, Pearson correlation)

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Best-matching major or minor key for a 12-bin pitch-class histogram. */
export function estimateKey(hist: number[]): { key: number; scale: 'major' | 'minor'; score: number; margin: number } {
  const scores: { key: number; scale: 'major' | 'minor'; score: number }[] = [];
  for (let k = 0; k < 12; k++) {
    const rotated = hist.map((_, i) => hist[(i + k) % 12]);
    scores.push({ key: k, scale: 'major', score: pearson(rotated, MAJOR_PROFILE) });
    scores.push({ key: k, scale: 'minor', score: pearson(rotated, MINOR_PROFILE) });
  }
  scores.sort((a, b) => b.score - a.score);
  return { ...scores[0], margin: scores[0].score - scores[1].score };
}

/** Whether chord and note names in this key read better with flats (F, Bb, Eb… and minor modes of them). */
export function keyPrefersFlats(key: number, scale: string): boolean {
  const offsets: Record<string, number> = { minor: 3, dorian: 10, phrygian: 8, harmonic: 3, minpent: 3, blues: 3, mixolydian: 5, lydian: 7, major: 0, majpent: 0 };
  const relMajor = (((key + (offsets[scale] ?? 0)) % 12) + 12) % 12;
  return [0, 5, 10, 3, 8, 1, 6].includes(relMajor);
}
