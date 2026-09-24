import { degreeToPitch, SCALES } from '../core/theory';
import { BAR, newNoteId, newTrackId, PPQ, STEP, type Note, type Song, type Track } from '../core/types';

// ---------------------------------------------------------------------------------------------
// Random helpers

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (rng: Rng, p: number) => rng() < p;
const range = (rng: Rng, a: number, b: number) => a + rng() * (b - a);

// ---------------------------------------------------------------------------------------------
// Drum helpers

type Hit = { pitch: number; tick: number; vel: number };

/** Parse a 16-step pattern: x = accent, o = normal, g = ghost, . = rest. */
function pat(str: string, pitch: number, barTick: number, vel = 1): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '.' || c === ' ') continue;
    const v = c === 'x' ? 1 : c === 'o' ? 0.72 : c === 'g' ? 0.4 : 0.85;
    hits.push({ pitch, tick: barTick + i * STEP, vel: v * vel });
  }
  return hits;
}

/** Hat roll starting at a step: `n` hits spread over `steps` 16ths. */
function roll(pitch: number, tick: number, n: number, steps: number, vel = 0.7, rising = true): Hit[] {
  const out: Hit[] = [];
  const span = steps * STEP;
  for (let i = 0; i < n; i++) {
    const v = rising ? vel * (0.55 + (0.45 * i) / Math.max(1, n - 1)) : vel;
    out.push({ pitch, tick: tick + Math.round((i * span) / n), vel: v });
  }
  return out;
}

const K = 36, SN = 38, CP = 39, RIM = 37, HH = 42, OH = 46, CR = 49, RD = 51, SHK = 70, PERC = 63, LT = 45, MT = 47, HT = 50, CB = 56;

interface BarCtx {
  rng: Rng;
  bar: number;
  bars: number;
  /** Section intensity for this bar. */
  energy: 'intro' | 'full' | 'break';
  phraseEnd: boolean;
  phraseStart: boolean;
}

// ---------------------------------------------------------------------------------------------
// Genre definitions

type ChordStyle = 'sustain' | 'halves' | 'stabs' | 'lofi' | 'arp' | 'clave' | 'offbeat';
type BassStyle = '808' | 'follow' | 'offbeat' | 'rolling' | 'pulse' | 'root' | 'clave';
type MelodyStyle = 'bells' | 'sparse' | 'lead' | 'arp' | 'hook' | 'dark';

export interface GenreDef {
  id: string;
  label: string;
  bpm: [number, number];
  swing: [number, number];
  kit: string;
  scales: string[];
  progressions: number[][];
  seventh: number;
  ninth: number;
  chord: { style: ChordStyle; inst: string[]; octave: number };
  bass: { style: BassStyle; inst: string[] };
  melody: { style: MelodyStyle; inst: string[]; octave: number; pentatonic: boolean };
  extra?: { style: ChordStyle; inst: string[]; octave: number; name: string };
  kickPattern: string[];
  drums(c: BarCtx, t: number, kick: string): Hit[];
}

function fillEnd(c: BarCtx, t: number, style: 'snare' | 'toms' | 'hats'): Hit[] {
  const r = c.rng;
  if (style === 'toms') {
    return [
      ...pat('............xoxo', HT, t, 0.9),
      ...pat('..............x.', MT, t, 0.9).map((h) => ({ ...h, tick: h.tick + STEP })),
      { pitch: LT, tick: t + 15 * STEP, vel: 0.95 },
    ];
  }
  if (style === 'hats') return roll(HH, t + 12 * STEP, pick(r, [6, 8]), 4, 0.8);
  return roll(SN, t + 12 * STEP, pick(r, [4, 6, 8]), 4, 0.75);
}

export const GENRES: GenreDef[] = [
  {
    id: 'trap',
    label: 'Trap',
    bpm: [136, 150],
    swing: [0, 0.05],
    kit: 'trap',
    scales: ['minor', 'harmonic', 'phrygian'],
    progressions: [
      [0, 5, 2, 6],
      [0, 5, 3, 4],
      [0, 0, 5, 5],
      [0, 3, 5, 4],
      [0, 6, 5, 4],
      [5, 3, 0, 4],
    ],
    seventh: 0.25,
    ninth: 0,
    chord: { style: 'sustain', inst: ['pad', 'strings', 'choir'], octave: 4 },
    bass: { style: '808', inst: ['bass808'] },
    melody: { style: 'bells', inst: ['bell', 'pluck', 'flute', 'glock', 'piano'], octave: 5, pentatonic: true },
    kickPattern: ['x.........x.....', 'x......x..x.....', 'x.....x...x..x..', 'x..x......x....x', 'x.......x.x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      if (c.energy !== 'intro') {
        hits.push(...pat('........x.......', CP, t));
        hits.push(...pat('........x.......', SN, t, 0.6));
      }
      // Hats: 8ths or 16ths with rolls.
      const sixteenths = c.energy === 'full' && chance(r, 0.6);
      for (let s = 0; s < 16; s += sixteenths ? 1 : 2) {
        const vel = s % 4 === 0 ? 0.9 : s % 2 === 0 ? 0.7 : 0.5;
        hits.push({ pitch: HH, tick: t + s * STEP, vel: vel + range(r, -0.06, 0.06) });
      }
      if (c.energy === 'full') {
        const rolls = pick(r, [1, 2, 2, 3]);
        for (let i = 0; i < rolls; i++) {
          const s = pick(r, [3, 6, 7, 11, 14, 15]);
          const kind = pick(r, [2, 3, 3, 4, 6]);
          const span = kind === 6 ? 2 : 1;
          const tick = t + s * STEP;
          for (let j = hits.length - 1; j >= 0; j--) {
            if (hits[j].pitch === HH && hits[j].tick >= tick && hits[j].tick < tick + span * STEP) hits.splice(j, 1);
          }
          hits.push(...roll(HH, tick, kind, span, 0.72));
        }
        if (chance(r, 0.35)) hits.push({ pitch: OH, tick: t + 14 * STEP, vel: 0.55 });
      }
      if (c.phraseEnd && c.energy === 'full' && chance(r, 0.6)) hits.push(...fillEnd(c, t, pick(r, ['snare', 'hats'] as const)));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.7 });
      return hits;
    },
  },
  {
    id: 'boombap',
    label: 'Boom Bap',
    bpm: [84, 94],
    swing: [0.3, 0.45],
    kit: 'boombap',
    scales: ['minor', 'dorian'],
    progressions: [
      [0, 3, 0, 4],
      [0, 5, 3, 4],
      [0, 6, 5, 6],
      [1, 4, 0, 0],
      [0, 3, 6, 2],
    ],
    seventh: 0.75,
    ninth: 0.25,
    chord: { style: 'halves', inst: ['epiano', 'piano', 'strings'], octave: 4 },
    bass: { style: 'follow', inst: ['deepbass', 'sub'] },
    melody: { style: 'sparse', inst: ['flute', 'piano', 'strings', 'brass'], octave: 5, pentatonic: true },
    kickPattern: ['x.........x.x...', 'x......x..x.....', 'x.x.......x.....', 'x.........xx....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      hits.push(...pat('....x.......x...', SN, t, c.energy === 'intro' ? 0.6 : 1));
      if (chance(r, 0.4)) hits.push(...pat('.......g.......g', SN, t));
      hits.push(...pat('x...x...x...x...', HH, t, 0.85));
      hits.push(...pat('..o...o...o...o.', HH, t, 0.7));
      if (chance(r, 0.4)) hits.push({ pitch: OH, tick: t + 14 * STEP, vel: 0.5 });
      if (c.phraseEnd && c.energy === 'full' && chance(r, 0.5)) hits.push(...pat('.............g.g', SN, t));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.55 });
      return hits;
    },
  },
  {
    id: 'lofi',
    label: 'Lo-Fi',
    bpm: [72, 86],
    swing: [0.4, 0.55],
    kit: 'lofi',
    scales: ['major', 'dorian', 'minor'],
    progressions: [
      [1, 4, 0, 5],
      [3, 2, 1, 0],
      [0, 5, 1, 4],
      [3, 4, 2, 5],
      [0, 3, 1, 4],
    ],
    seventh: 1,
    ninth: 0.55,
    chord: { style: 'lofi', inst: ['epiano', 'piano'], octave: 4 },
    bass: { style: 'root', inst: ['sub', 'deepbass'] },
    melody: { style: 'sparse', inst: ['glock', 'flute', 'marimba', 'pluck'], octave: 5, pentatonic: true },
    extra: { style: 'sustain', inst: ['pad', 'choir'], octave: 4, name: 'Pad' },
    kickPattern: ['x......x..x.....', 'x.....x....x....', 'x.........x.....', 'x..x......x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t, 0.9));
      hits.push(...pat('....x.......x...', SN, t, 0.78));
      hits.push(...pat('x.o.x.o.x.o.x.o.', HH, t, 0.6));
      if (chance(r, 0.5)) hits.push(...pat('...g......g....g', RIM, t, 0.9));
      if (c.energy === 'full') hits.push(...pat('o.g.o.g.o.g.o.g.', SHK, t, 0.35));
      return hits;
    },
  },
  {
    id: 'house',
    label: 'House',
    bpm: [120, 126],
    swing: [0.05, 0.15],
    kit: 'house',
    scales: ['minor', 'dorian', 'major'],
    progressions: [
      [0, 5, 2, 6],
      [0, 3, 0, 3],
      [0, 6, 5, 6],
      [0, 4, 5, 3],
    ],
    seventh: 0.7,
    ninth: 0.2,
    chord: { style: 'stabs', inst: ['organ', 'piano', 'supersaw'], octave: 4 },
    bass: { style: 'offbeat', inst: ['deepbass', 'sub'] },
    melody: { style: 'hook', inst: ['pluck', 'bell', 'marimba'], octave: 5, pentatonic: true },
    extra: { style: 'sustain', inst: ['strings', 'pad'], octave: 4, name: 'Strings' },
    kickPattern: ['x...x...x...x...'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      if (c.energy !== 'intro') hits.push(...pat('....x.......x...', CP, t));
      hits.push(...pat('..x...x...x...x.', OH, t, 0.65));
      hits.push(...pat('x.o.x.o.x.o.x.o.', HH, t, 0.45));
      if (c.energy === 'full') hits.push(...pat('gogogogogogogogo', SHK, t, 0.35));
      if (c.energy === 'full' && chance(r, 0.4)) hits.push(...pat('x.x.x.x.x.x.x.x.', RD, t, 0.35));
      if (c.phraseEnd && chance(r, 0.6)) hits.push(...roll(CP, t + 12 * STEP, 4, 4, 0.7));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.6 });
      return hits;
    },
  },
  {
    id: 'drill',
    label: 'UK Drill',
    bpm: [140, 146],
    swing: [0, 0],
    kit: 'trap',
    scales: ['harmonic', 'minor'],
    progressions: [
      [0, 5, 4, 4],
      [0, 0, 5, 4],
      [0, 3, 5, 4],
      [5, 4, 0, 0],
    ],
    seventh: 0.1,
    ninth: 0,
    chord: { style: 'sustain', inst: ['strings', 'choir', 'pad'], octave: 4 },
    bass: { style: '808', inst: ['bass808'] },
    melody: { style: 'dark', inst: ['piano', 'bell', 'flute', 'strings'], octave: 5, pentatonic: false },
    kickPattern: ['x......x..x.....', 'x.........x..x..', 'x.....x...x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') {
        hits.push(...pat(kick, K, t));
        hits.push(...pat('........x.......', SN, t));
        if (c.bar % 2 === 1) hits.push(...pat('..............x.', SN, t, 0.9));
        else hits.push(...pat('...g............', SN, t));
      }
      // Triplet-feel hats (8th-note triplets with gaps).
      const trip = PPQ / 3;
      for (let beat = 0; beat < 4; beat++) {
        const shape = pick(r, ['x.x', 'xxx', 'x.x', '.xx', 'x..']);
        for (let i = 0; i < 3; i++) {
          if (shape[i] === '.') continue;
          hits.push({ pitch: HH, tick: t + beat * PPQ + i * trip, vel: i === 0 ? 0.85 : 0.6 + range(r, -0.05, 0.05) });
        }
      }
      if (c.energy === 'full' && chance(r, 0.5)) hits.push(...roll(HH, t + pick(r, [6, 10, 14]) * STEP, 6, 2, 0.65));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.6 });
      if (chance(r, 0.3)) hits.push(...pat('......g.......g.', PERC, t, 0.8));
      return hits;
    },
  },
  {
    id: 'reggaeton',
    label: 'Reggaeton',
    bpm: [90, 98],
    swing: [0, 0.05],
    kit: 'trap',
    scales: ['minor', 'harmonic'],
    progressions: [
      [0, 5, 2, 6],
      [0, 3, 6, 2],
      [0, 5, 3, 4],
    ],
    seventh: 0.2,
    ninth: 0,
    chord: { style: 'clave', inst: ['pluck', 'marimba', 'piano'], octave: 4 },
    bass: { style: 'follow', inst: ['bass808', 'deepbass'] },
    melody: { style: 'hook', inst: ['lead', 'flute', 'bell'], octave: 5, pentatonic: false },
    kickPattern: ['x...x...x...x...'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      hits.push(...pat('...x..x....x..x.', SN, t, c.energy === 'intro' ? 0.6 : 0.95));
      hits.push(...pat('...x..x....x..x.', RIM, t, 0.5));
      hits.push(...pat('x.o.x.o.x.o.x.o.', HH, t, 0.55));
      if (c.energy === 'full') hits.push(...pat('..o...o...o...o.', SHK, t, 0.5));
      if (c.phraseEnd && chance(r, 0.5)) hits.push(...fillEnd(c, t, 'toms'));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.55 });
      return hits;
    },
  },
  {
    id: 'afro',
    label: 'Afrobeats',
    bpm: [100, 112],
    swing: [0.1, 0.25],
    kit: 'house',
    scales: ['major', 'minor', 'dorian'],
    progressions: [
      [0, 4, 5, 3],
      [0, 5, 3, 4],
      [3, 4, 0, 5],
      [0, 3, 0, 4],
    ],
    seventh: 0.4,
    ninth: 0.2,
    chord: { style: 'clave', inst: ['epiano', 'marimba', 'organ'], octave: 4 },
    bass: { style: 'clave', inst: ['logdrum', 'deepbass'] },
    melody: { style: 'hook', inst: ['flute', 'marimba', 'pluck', 'glock'], octave: 5, pentatonic: true },
    kickPattern: ['x......x..x.....', 'x..x......x..x..', 'x.....x...x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      hits.push(...pat('....x.......x...', CP, t, 0.8));
      hits.push(...pat('x..x..x...x..x..', RIM, t, 0.55));
      hits.push(...pat('xgogxgogxgogxgog', SHK, t, 0.5));
      if (c.energy === 'full') hits.push(...pat('......x.x.....x.', PERC, t, 0.7));
      if (c.energy === 'full' && chance(r, 0.4)) hits.push(...pat('..........o.....', CB, t, 0.4));
      hits.push(...pat('..o...o...o...o.', HH, t, 0.4));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.45 });
      return hits;
    },
  },
  {
    id: 'dnb',
    label: 'Drum & Bass',
    bpm: [170, 176],
    swing: [0, 0.05],
    kit: 'breaks',
    scales: ['minor', 'dorian'],
    progressions: [
      [0, 5, 3, 4],
      [0, 6, 5, 6],
      [0, 3, 0, 5],
    ],
    seventh: 0.5,
    ninth: 0.3,
    chord: { style: 'sustain', inst: ['pad', 'strings'], octave: 4 },
    bass: { style: 'rolling', inst: ['reese'] },
    melody: { style: 'arp', inst: ['pluck', 'bell', 'glock'], octave: 5, pentatonic: true },
    kickPattern: ['x.........x.....', 'x.........x..x..', 'x.x.......x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') {
        hits.push(...pat(kick, K, t));
        hits.push(...pat('....x.......x...', SN, t));
        if (chance(r, 0.6)) hits.push(...pat('.......g.g....g.', SN, t));
      }
      hits.push(...pat('x.o.x.o.x.o.x.o.', HH, t, 0.6));
      if (c.energy === 'full') hits.push(...pat('x.x.x.x.x.x.x.x.', RD, t, 0.3));
      if (c.phraseEnd && chance(r, 0.6)) hits.push(...fillEnd(c, t, 'snare'));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.6 });
      return hits;
    },
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    bpm: [96, 112],
    swing: [0, 0],
    kit: 'retro',
    scales: ['minor', 'major'],
    progressions: [
      [0, 5, 2, 6],
      [0, 4, 5, 3],
      [5, 3, 0, 4],
      [0, 6, 5, 6],
    ],
    seventh: 0.15,
    ninth: 0.1,
    chord: { style: 'sustain', inst: ['pad', 'supersaw'], octave: 4 },
    bass: { style: 'pulse', inst: ['deepbass', 'sub'] },
    melody: { style: 'lead', inst: ['lead', 'chip', 'supersaw'], octave: 5, pentatonic: false },
    extra: { style: 'arp', inst: ['chip', 'pluck'], octave: 5, name: 'Arp' },
    kickPattern: ['x...x...x...x...', 'x.......x.x.....'],
    drums(c, t, kick) {
      const r = c.rng;
      const hits: Hit[] = [];
      if (c.energy !== 'intro') hits.push(...pat(kick, K, t));
      hits.push(...pat('....x.......x...', SN, t, c.energy === 'intro' ? 0.5 : 1));
      hits.push(...pat('xoxoxoxoxoxoxoxo', HH, t, 0.5));
      if (c.phraseEnd && chance(r, 0.7)) hits.push(...fillEnd(c, t, 'toms'));
      if (c.phraseStart && c.bar > 0) hits.push({ pitch: CR, tick: t, vel: 0.7 });
      return hits;
    },
  },
];

export const GENRE_BY_ID = new Map(GENRES.map((g) => [g.id, g]));

// ---------------------------------------------------------------------------------------------
// Harmony

interface Chord {
  /** Scale degrees (0-based, may exceed 6). */
  degrees: number[];
  root: number;
  pitches: number[];
  bassPitch: number;
}

function chordDegrees(root: number, seventh: boolean, ninth: boolean): number[] {
  const d = [root, root + 2, root + 4];
  if (seventh) d.push(root + 6);
  if (ninth) d.push(root + 8);
  return d;
}

/** Voice a chord near `center`, keeping movement from the previous voicing small. */
function voice(degrees: number[], key: number, scale: string, octave: number, prev: number[] | null): number[] {
  const base = degrees.map((d) => degreeToPitch(d, key, scale, octave));
  const candidates: number[][] = [];
  for (let inv = 0; inv < degrees.length; inv++) {
    for (const shift of [-12, 0, 12]) {
      const v = base.map((p, i) => (i < inv ? p + 12 : p) + shift).sort((a, b) => a - b);
      if (v[0] < 50 || v[v.length - 1] > 82) continue;
      candidates.push(v);
    }
  }
  if (!candidates.length) return base;
  const center = 62;
  const cost = (v: number[]) => {
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    let c = Math.abs(avg - center) * 0.6;
    if (prev) {
      const pAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
      c += Math.abs(avg - pAvg) * 1.2;
      c += Math.abs(v[v.length - 1] - prev[prev.length - 1]) * 0.4;
    }
    return c;
  };
  candidates.sort((a, b) => cost(a) - cost(b));
  return candidates[0];
}

function makeChords(rng: Rng, g: GenreDef, prog: number[], key: number, scale: string): Chord[] {
  let prev: number[] | null = null;
  return prog.map((root) => {
    const seventh = chance(rng, g.seventh);
    const ninth = seventh && chance(rng, g.ninth);
    const degrees = chordDegrees(root, seventh, ninth);
    const pitches = voice(degrees, key, scale, g.chord.octave, prev);
    prev = pitches;
    let bassPitch = degreeToPitch(root, key, scale, 1);
    while (bassPitch > 40) bassPitch -= 12;
    while (bassPitch < 28) bassPitch += 12;
    return { degrees, root, pitches, bassPitch };
  });
}

// ---------------------------------------------------------------------------------------------
// Parts

function note(pitch: number, start: number, dur: number, vel: number): Note {
  return { id: newNoteId(), pitch, start: Math.round(start), dur: Math.max(1, Math.round(dur)), vel: Math.max(0.05, Math.min(1, vel)) };
}

function chordPart(rng: Rng, style: ChordStyle, chords: Chord[], bars: number, active: (bar: number) => boolean, octaveShift = 0): Note[] {
  const out: Note[] = [];
  const clave = pick(rng, ['x..x..x...x..x..', 'x..x..x.x..x..x.', '..x..x..x..x..x.']);
  const stab = pick(rng, ['..x...x...x...x.', '...x..x....x..x.', 'x..x..x...x.x...']);
  for (let bar = 0; bar < bars; bar++) {
    if (!active(bar)) continue;
    const ch = chords[bar % chords.length];
    const pitches = ch.pitches.map((p) => p + octaveShift * 12);
    const t = bar * BAR;
    switch (style) {
      case 'sustain':
        for (const p of pitches) out.push(note(p, t, BAR - 4, 0.62));
        break;
      case 'halves':
        for (const half of [0, 1]) for (const p of pitches) out.push(note(p, t + half * (BAR / 2), BAR / 2 - 8, half ? 0.55 : 0.68));
        break;
      case 'lofi': {
        // Slightly strummed, anticipating the bar line on some bars.
        const early = bar > 0 && chance(rng, 0.35) ? STEP : 0;
        pitches.forEach((p, i) => out.push(note(p, t - early + i * 5, BAR - 10 + early - i * 5, 0.5 + i * 0.03)));
        break;
      }
      case 'stabs':
      case 'offbeat':
        for (let s = 0; s < 16; s++) {
          if (stab[s] !== 'x') continue;
          for (const p of pitches) out.push(note(p, t + s * STEP, STEP * 1.5, 0.7));
        }
        break;
      case 'clave':
        for (let s = 0; s < 16; s++) {
          if (clave[s] !== 'x') continue;
          for (const p of pitches) out.push(note(p, t + s * STEP, STEP * 2, s === 0 ? 0.72 : 0.6));
        }
        break;
      case 'arp': {
        const seq = [...pitches, ...pitches.slice(1, -1).reverse()];
        const up = [...pitches, pitches[0] + 12];
        const order = chance(rng, 0.5) ? seq : up;
        for (let s = 0; s < 16; s++) out.push(note(order[s % order.length] + 12, t + s * STEP, STEP * 0.9, s % 4 === 0 ? 0.7 : 0.52));
        break;
      }
    }
  }
  return out;
}

function kickSteps(kick: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < kick.length; i++) if (kick[i] !== '.') out.push(i);
  return out;
}

function bassPart(
  rng: Rng,
  style: BassStyle,
  chords: Chord[],
  bars: number,
  kicks: (bar: number) => string,
  active: (bar: number) => boolean,
  scale: string,
): Note[] {
  const out: Note[] = [];
  for (let bar = 0; bar < bars; bar++) {
    if (!active(bar)) continue;
    const ch = chords[bar % chords.length];
    const next = chords[(bar + 1) % chords.length];
    const root = ch.bassPitch;
    const t = bar * BAR;
    switch (style) {
      case '808': {
        const steps = kickSteps(kicks(bar));
        steps.forEach((s, i) => {
          const end = i + 1 < steps.length ? steps[i + 1] : 16;
          let pitch = root;
          if (i > 0 && chance(rng, 0.25)) pitch = root + pick(rng, [12, 7, -5]);
          if (pitch > 43) pitch -= 12;
          const slide = i + 1 < steps.length && chance(rng, 0.3);
          const dur = (end - s) * STEP + (slide ? STEP * 0.75 : -4);
          out.push(note(pitch, t + s * STEP, dur, 0.95));
        });
        break;
      }
      case 'follow': {
        const steps = kickSteps(kicks(bar));
        steps.forEach((s, i) => {
          const end = i + 1 < steps.length ? steps[i + 1] : 16;
          const pitch = i > 0 && chance(rng, 0.3) ? root + pick(rng, [7, 12, 10]) : root;
          out.push(note(pitch + 12, t + s * STEP, Math.min(end - s, 6) * STEP - 6, 0.85));
        });
        // Walk-up into the next chord.
        if (chance(rng, 0.4)) {
          const target = next.bassPitch + 12;
          out.push(note(target - (scale === 'major' ? 1 : 2), t + 14 * STEP, STEP * 1.5, 0.7));
        }
        break;
      }
      case 'offbeat':
        for (let beat = 0; beat < 4; beat++) {
          const p = root + 12 + (beat === 3 && chance(rng, 0.3) ? 12 : 0);
          out.push(note(p, t + beat * PPQ + PPQ / 2, STEP * 1.6, 0.85));
        }
        break;
      case 'rolling': {
        out.push(note(root + 12, t, BAR / 2 + STEP * 2, 0.9));
        out.push(note(root + (chance(rng, 0.5) ? 12 : 19), t + BAR / 2 + STEP * 2, BAR / 2 - STEP * 2 - 4, 0.85));
        break;
      }
      case 'pulse':
        for (let s = 0; s < 16; s += 2) {
          const oct = s % 4 === 2 && chance(rng, 0.25) ? 24 : 12;
          out.push(note(root + oct, t + s * STEP, STEP * 1.6, s % 4 === 0 ? 0.9 : 0.7));
        }
        break;
      case 'root':
        out.push(note(root + 12, t, BAR * 0.5 - 8, 0.85));
        out.push(note(root + (chance(rng, 0.5) ? 19 : 12), t + BAR * 0.5 + STEP * (chance(rng, 0.5) ? 2 : 0), BAR * 0.4, 0.75));
        break;
      case 'clave': {
        const rhythm = pick(rng, ['x..x..x...x.....', 'x..x..x.x.......', 'x.....x...x..x..']);
        let i = 0;
        for (let s = 0; s < 16; s++) {
          if (rhythm[s] !== 'x') continue;
          const p = i === 2 && chance(rng, 0.5) ? root + 7 : i === 3 ? root + 12 : root;
          out.push(note(p + 12, t + s * STEP, STEP * 2.2, i === 0 ? 0.95 : 0.8));
          i++;
        }
        break;
      }
    }
  }
  return out;
}

/** Nearest chord-tone degree to `deg`. */
function snapToChord(deg: number, chordDegs: number[], n: number): number {
  let best = deg;
  let bestDist = Infinity;
  for (const cd of chordDegs) {
    const pc = ((cd % n) + n) % n;
    for (let o = -2; o <= 2; o++) {
      const cand = pc + o * n;
      const d = Math.abs(cand - deg);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
  }
  return best;
}

const MELODY_RHYTHMS: Record<MelodyStyle, string[]> = {
  bells: ['x..x..x.x..x..x.', 'x.x..x..x.x..x..', 'x..x..x...x.x...', 'x.xx..x.x.xx..x.'],
  sparse: ['x.....x.....x...', 'x.......x...x...', '..x.....x.......', 'x...x.........x.'],
  lead: ['x...x...x.x.x...', 'x.x.x...x...x.x.', 'x.....x.x...x...'],
  arp: ['x.x.x.x.x.x.x.x.', 'x.xx.xx.x.xx.xx.'],
  hook: ['x..x..x...x.x...', '..x.x.x...x..x..', 'x.x...x.x.x.....', 'x..x...x..x.x...'],
  dark: ['x..x..x.....x...', 'x.....x.x..x....', 'x..x....x..x..x.'],
};

function melodyPart(
  rng: Rng,
  style: MelodyStyle,
  chords: Chord[],
  bars: number,
  active: (bar: number) => boolean,
  key: number,
  scale: string,
  octave: number,
  pentatonic: boolean,
): Note[] {
  const steps = (SCALES[scale] ?? SCALES.minor).steps;
  const n = steps.length;
  // Allowed degrees for weak notes (a pentatonic subset avoids clashes).
  const allowed = pentatonic && n === 7 ? (scale === 'major' || scale === 'lydian' || scale === 'mixolydian' ? [0, 1, 2, 4, 5] : [0, 2, 3, 4, 6]) : [...Array(n).keys()];
  const snapAllowed = (d: number) => {
    const pc = ((d % n) + n) % n;
    if (allowed.includes(pc)) return d;
    return allowed.includes((pc + 1) % n) ? d + 1 : d - 1;
  };

  const motifBars = style === 'arp' ? 1 : 2;
  const rhythmA = Array.from({ length: motifBars }, () => pick(rng, MELODY_RHYTHMS[style]));
  // Contour as degree offsets per onset (random walk).
  const makeContour = (count: number): number[] => {
    const c: number[] = [];
    let d = pick(rng, [0, 2, 4]);
    for (let i = 0; i < count; i++) {
      c.push(d);
      const stepSize = style === 'arp' ? pick(rng, [2, 2, -2, 1]) : pick(rng, [-2, -1, -1, 1, 1, 2, 0, 3, -3]);
      d += stepSize;
      if (d > 7) d -= pick(rng, [3, 4]);
      if (d < -3) d += pick(rng, [3, 4]);
    }
    return c;
  };
  const onsets = rhythmA.map((r) => [...r].reduce<number[]>((acc, ch, i) => (ch === 'x' ? [...acc, i] : acc), []));
  const contourA = onsets.map((o) => makeContour(o.length));
  const contourB = onsets.map((o) => makeContour(o.length));

  const out: Note[] = [];
  for (let bar = 0; bar < bars; bar++) {
    if (!active(bar)) continue;
    const mi = bar % motifBars;
    const cycle = Math.floor(bar / motifBars);
    // Phrase form A A A B (every fourth motif varies).
    const useB = cycle % 4 === 3 || (cycle % 2 === 1 && mi === motifBars - 1 && chance(rng, 0.3));
    const on = onsets[mi];
    const contour = useB ? contourB[mi] : contourA[mi];
    const ch = chords[bar % chords.length];
    for (let i = 0; i < on.length; i++) {
      const s = on[i];
      const strong = s % 4 === 0;
      let deg = ch.root + contour[i];
      deg = strong ? snapToChord(deg, ch.degrees.slice(0, 3), n) : snapAllowed(deg);
      const pitch = degreeToPitch(deg, key, scale, octave);
      const nextS = i + 1 < on.length ? on[i + 1] : 16;
      const maxLen = style === 'lead' || style === 'sparse' ? 6 : style === 'arp' ? 1 : 3;
      const len = Math.max(1, Math.min(nextS - s, maxLen));
      const vel = (strong ? 0.85 : 0.68) + range(rng, -0.05, 0.05);
      out.push(note(pitch, bar * BAR + s * STEP, len * STEP - 4, vel));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface GenerateOptions {
  genre: string;
  seed?: number;
  key?: number;
  scale?: string;
  bpm?: number;
  bars?: number;
  palette: string[];
  parts?: { drums: boolean; bass: boolean; chords: boolean; melody: boolean; extra: boolean };
}

function makeTrack(name: string, kind: 'drums' | 'synth', instrument: string, color: string, notes: Note[], extra: Partial<Track> = {}): Track {
  return {
    id: newTrackId(),
    name,
    kind,
    instrument,
    color,
    volume: 0.8,
    pan: 0,
    reverb: 0.15,
    mute: false,
    solo: false,
    visible: true,
    notes,
    ...extra,
  };
}

export function generateSong(opts: GenerateOptions): Song {
  const g = GENRE_BY_ID.get(opts.genre) ?? GENRES[0];
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);
  const scale = opts.scale && SCALES[opts.scale] && opts.scale !== 'chromatic' && SCALES[opts.scale].steps.length === 7 ? opts.scale : pick(rng, g.scales);
  const key = opts.key ?? Math.floor(rng() * 12);
  const bpm = opts.bpm ?? Math.round(range(rng, g.bpm[0], g.bpm[1]));
  const bars = opts.bars ?? 8;
  const swing = Math.round(range(rng, g.swing[0], g.swing[1]) * 100) / 100;
  const parts = opts.parts ?? { drums: true, bass: true, chords: true, melody: true, extra: true };
  const prog = pick(rng, g.progressions);
  const chords = makeChords(rng, g, prog, key, scale);

  // Arrangement: long beats get an intro.
  const introBars = bars >= 16 ? 4 : 0;
  const energy = (bar: number): BarCtx['energy'] => (bar < introBars ? 'intro' : 'full');

  const kickA = pick(rng, g.kickPattern);
  const kickB = chance(rng, 0.6) ? pick(rng, g.kickPattern) : kickA;
  const kickFor = (bar: number) => (bar % 2 === 0 ? kickA : kickB);

  const palette = opts.palette;
  const tracks: Track[] = [];
  let ci = 0;

  if (parts.drums) {
    const hits: Hit[] = [];
    for (let bar = 0; bar < bars; bar++) {
      const ctx: BarCtx = {
        rng,
        bar,
        bars,
        energy: energy(bar),
        phraseEnd: bar % 4 === 3,
        phraseStart: bar % 4 === 0,
      };
      hits.push(...g.drums(ctx, bar * BAR, kickFor(bar)));
    }
    // De-duplicate hits on the same voice & tick.
    const seen = new Set<string>();
    const notes = hits
      .filter((h) => {
        const k = h.pitch + ':' + h.tick;
        if (seen.has(k)) return false;
        seen.add(k);
        return h.tick >= 0 && h.tick < bars * BAR;
      })
      .map((h) => note(h.pitch, h.tick, STEP, h.vel));
    tracks.push(makeTrack('Drums', 'drums', g.kit, palette[ci++ % palette.length], notes, { volume: 1, reverb: 0.06 }));
  }
  if (parts.bass) {
    const inst = pick(rng, g.bass.inst);
    const notes = bassPart(rng, g.bass.style, chords, bars, kickFor, (b) => energy(b) !== 'intro', scale);
    tracks.push(makeTrack(inst === 'bass808' ? '808' : 'Bass', 'synth', inst, palette[ci++ % palette.length], notes, { volume: inst === 'bass808' ? 0.8 : 0.75, reverb: 0 }));
  }
  if (parts.chords) {
    const inst = pick(rng, g.chord.inst);
    const notes = chordPart(rng, g.chord.style, chords, bars, () => true);
    tracks.push(makeTrack('Chords', 'synth', inst, palette[ci++ % palette.length], notes, { volume: 0.7, reverb: 0.3 }));
  }
  if (parts.melody) {
    const inst = pick(rng, g.melody.inst);
    const notes = melodyPart(rng, g.melody.style, chords, bars, (b) => b >= Math.min(introBars, 2), key, scale, g.melody.octave, g.melody.pentatonic);
    tracks.push(makeTrack('Melody', 'synth', inst, palette[ci++ % palette.length], notes, { volume: 0.72, reverb: 0.28, pan: 0.1 }));
  }
  if (parts.extra && g.extra) {
    const inst = pick(rng, g.extra.inst);
    const notes = chordPart(rng, g.extra.style, chords, bars, (b) => b >= introBars);
    tracks.push(makeTrack(g.extra.name, 'synth', inst, palette[ci++ % palette.length], notes, { volume: 0.5, reverb: 0.4, pan: -0.15 }));
  }

  return {
    name: `${g.label} Beat`,
    artist: '',
    bpm,
    tempoChanges: [],
    swing,
    bars,
    key,
    scale,
    tracks,
    loop: { enabled: false, start: 0, end: Math.min(4, bars) * BAR },
    audioOffset: 0,
    synthsWithAudio: true,
  };
}

/** Regenerate a single part of an existing song in the style of a genre. */
export function regeneratePart(song: Song, track: Track, genreId: string, seed = Math.floor(Math.random() * 1e9)): Note[] {
  const g = GENRE_BY_ID.get(genreId) ?? GENRES[0];
  const rng = mulberry32(seed);
  const scale = SCALES[song.scale]?.steps.length === 7 ? song.scale : 'minor';
  const chords = makeChords(rng, g, pick(rng, g.progressions), song.key, scale);
  const kick = pick(rng, g.kickPattern);
  const bars = song.bars;
  const all = () => true;
  if (track.kind === 'drums') {
    const hits: Hit[] = [];
    for (let bar = 0; bar < bars; bar++) {
      hits.push(...g.drums({ rng, bar, bars, energy: 'full', phraseEnd: bar % 4 === 3, phraseStart: bar % 4 === 0 }, bar * BAR, kick));
    }
    return hits.filter((h) => h.tick >= 0 && h.tick < bars * BAR).map((h) => note(h.pitch, h.tick, STEP, h.vel));
  }
  const avg = track.notes.length ? track.notes.reduce((s, n) => s + n.pitch, 0) / track.notes.length : 60;
  if (avg < 48 || /bass|808/i.test(track.name) || track.instrument.includes('bass') || track.instrument === 'sub' || track.instrument === 'logdrum') {
    return bassPart(rng, g.bass.style, chords, bars, () => kick, all, scale);
  }
  if (/chord|pad|key/i.test(track.name)) return chordPart(rng, g.chord.style, chords, bars, all);
  return melodyPart(rng, g.melody.style, chords, bars, all, song.key, scale, g.melody.octave, g.melody.pentatonic);
}
