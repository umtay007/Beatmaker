/**
 * Struck and plucked parts that the main transcription folds into the pad line (desktop app, with
 * YourMT3+ set up: \`Beatmaker.exe --ymt3 <folder>\`). YourMT3+ transcribes the "other" stem and
 * says which instrument each note is; a group of its notes is kept only if the original's spectrum
 * really does rise at those notes (a struck piano does, a string ensemble heard as notes does not),
 * and is then played by a matching built-in instrument as a track of its own.
 */
import { Attacks, type Role } from '../audio/compare';
import { encodeWav } from '../audio/render';
import { holdNotes } from '../audio/parts';
import { Timeline } from '../core/timing';
import { newNoteId, STEP, type Note, type Song } from '../core/types';
import { desktop } from './desktop';

interface Family {
  name: string;
  /** General MIDI programs. */
  programs: [number, number];
  instrument: string;
}
/** The families worth a track of their own (strings, pads and bass are what the main transcription does). */
const FAMILIES: Family[] = [
  { name: 'Piano', programs: [0, 7], instrument: 'spiano' },
  { name: 'Mallets', programs: [8, 15], instrument: 'gvibes' },
  { name: 'Organ', programs: [16, 23], instrument: 'sorgan' },
  { name: 'Guitar', programs: [24, 31], instrument: 'sguitar' },
  { name: 'Brass', programs: [56, 63], instrument: 'gbrass' },
  { name: 'Reeds', programs: [64, 71], instrument: 'sclarinet' },
  { name: 'Pipes', programs: [72, 79], instrument: 'sflute' },
];
/** The original must rise at least this many dB at a group's notes (Walk's piano: 9.9; its strings and guitar: below 1). */
const MIN_RISE = 3;
const MIN_NOTES = 8;

export interface ExtraPart {
  name: string;
  instrument: string;
  notes: Note[];
  rise: number;
}

export async function struckParts(song: Song, other: AudioBuffer, offset: number): Promise<{ parts: ExtraPart[]; report: string[] }> {
  const app = desktop();
  if (!app?.ymt3Ready || !(await app.ymt3Ready())) return { parts: [], report: [] };
  const wav = new Uint8Array(await encodeWav(other).arrayBuffer());
  const res = await app.ymt3Run(wav, other.duration);
  if (res.error || !res.notes) return { parts: [], report: [`YourMT3+: not used (${res.error ?? 'no notes'})`] };
  const tl = new Timeline(song);
  const parts: ExtraPart[] = [];
  const report: string[] = [];
  const to = Math.min(tl.tickToSec(song.bars * 384), other.duration + offset);
  for (const f of FAMILIES) {
    const raw = res.notes.filter((n) => n.prog >= f.programs[0] && n.prog <= f.programs[1] && n.p >= 36 && n.p <= 96 && n.e > n.s);
    if (raw.length < MIN_NOTES) continue;
    // Seconds in the stem → ticks in the song (the stem starts at -audioOffset), on the 16th grid.
    const snap = (sec: number) => Math.max(0, Math.round(tl.secToTick(sec + offset) / STEP) * STEP);
    const notes: Note[] = raw
      .map((n) => ({ id: 0, pitch: n.p, start: snap(n.s), dur: Math.max(STEP, snap(n.e) - snap(n.s)), vel: Math.max(0.4, Math.min(1, 0.45 + n.v * 0.55)) }))
      .filter((n) => n.start < song.bars * 384);
    const held = holdNotes(notes, 2 * STEP, 0).map((n) => ({ ...n, id: newNoteId() }));
    if (held.length < MIN_NOTES) continue;
    const att = await Attacks.of(other, offset, held.map((n) => ({ p: n.pitch, s: tl.tickToSec(n.start) })), [{ from: 0, to }]);
    const rise = att?.rise ?? 0;
    if (rise >= MIN_RISE) {
      parts.push({ name: `${f.name} (YourMT3+)`, instrument: f.instrument, notes: held, rise });
      report.push(`YourMT3+ found a ${f.name.toLowerCase()} part with real attacks (${held.length} notes, +${rise.toFixed(1)} dB at the note starts) that the main transcription folds into the pad line: it plays it on its own track`);
    }
  }
  return { parts, report };
}

export type { Role };
