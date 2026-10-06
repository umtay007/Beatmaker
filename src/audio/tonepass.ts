/**
 * Fit each part's tone to its own stem: the part (drums, bass, chords and melody) is played flat,
 * compared with the same stretches of its separated stem in third-octave bands, and the track EQ
 * (low shelf, a bell, high shelf) and volume that close the gap are set. It runs once the parts'
 * sounds are final (instrument, kit, VST), over several of the busiest stretches rather than one.
 */
import { cloneSong, type Song, type Track } from '../core/types';
import { busyStretches } from './finder';
import { renderSong } from './render';
import { fitTone, ltas, TONE_BANDS, type ToneFit } from './tonefit';

export interface TonePart {
  name: string;
  tracks: Track[];
  stem: AudioBuffer;
  /** The bands that matter for the part (Hz). */
  lo: number;
  hi: number;
  /** The track whose notes say where the part plays most. */
  guide: Track;
}

/** Most the EQ may move any band (dB). */
const MAX_EQ = 9;

/** Average of several third-octave spectra (dB) in the power domain. */
function average(spectra: number[][]): number[] {
  return spectra[0].map((_, b) => 10 * Math.log10(spectra.reduce((s, x) => s + Math.pow(10, x[b] / 10), 0) / spectra.length + 1e-12));
}

export async function fitPartsTone(
  song: Song,
  parts: TonePart[],
  offset: number,
  apply: (track: Track, fit: ToneFit) => void,
  progress?: (done: number, of: number, name: string) => void,
): Promise<{ name: string; before: number; after: number }[]> {
  const out: { name: string; before: number; after: number }[] = [];
  for (const [i, part] of parts.entries()) {
    progress?.(i, parts.length, part.name);
    const spans = busyStretches(song, part.guide, 8, 3);
    const solo = cloneSong(song);
    solo.tracks = solo.tracks.filter((t) => part.tracks.some((x) => x.id === t.id));
    for (const t of solo.tracks) Object.assign(t, { mute: false, solo: false, eqLow: 0, eqMid: 0, eqHigh: 0 });
    const target: number[][] = [];
    const mine: number[][] = [];
    for (const sp of spans) {
      const pre = Math.min(4, sp.from);
      const r = await renderSong(solo, { from: sp.from - pre, to: sp.to, tail: 0, dynamics: false });
      target.push(ltas(part.stem, sp.from - offset, sp.to - offset));
      mine.push(ltas(r, pre, pre + (sp.to - sp.from)));
    }
    const fit = fitTone(average(target), average(mine), part.lo, part.hi, MAX_EQ);
    for (const t of part.tracks) apply(t, fit);
    out.push({ name: part.name, before: fit.before, after: fit.after });
  }
  progress?.(parts.length, parts.length, '');
  return out;
}

/**
 * How far a part's average spectrum (third-octave bands, averaged over the stretches) is from its
 * stem's, in dB RMS once the overall level is taken out: what a track EQ and volume could not fix
 * is what this is for. `solo` is a song of just the part.
 */
export async function spectralGap(solo: Song, stem: AudioBuffer, offset: number, spans: { from: number; to: number }[], lo: number, hi: number): Promise<number> {
  const target: number[][] = [];
  const mine: number[][] = [];
  for (const sp of spans) {
    const pre = Math.min(4, sp.from);
    const r = await renderSong(solo, { from: sp.from - pre, to: sp.to, tail: 0, dynamics: false });
    target.push(ltas(stem, sp.from - offset, sp.to - offset));
    mine.push(ltas(r, pre, pre + (sp.to - sp.from)));
  }
  const a = average(target);
  const b = average(mine);
  const peak = Math.max(...a);
  const use = TONE_BANDS.map((f, i) => f >= lo && f <= hi && a[i] > peak - 45 && b[i] > -150);
  const gap = a.map((v, i) => v - b[i]).filter((_, i) => use[i]);
  if (!gap.length) return 0;
  const level = [...gap].sort((x, y) => x - y)[gap.length >> 1];
  return Math.sqrt(gap.reduce((s, g) => s + (g - level) ** 2, 0) / gap.length);
}
