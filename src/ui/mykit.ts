/**
 * Drums from your own sample library (desktop app, `--kits <folder>`): for each drum voice the song
 * uses a lot, every kick, snare or hat in the folder is tried alone on that voice's hits and compared
 * with the original's drum part; the best of each make one kit. The kit stays only if the drums then
 * match the original better than the best built-in kit did.
 */
import { partScore } from '../audio/compare';
import { KIT_BY_ID, registerKit, unregisterKit, type KitDef } from '../audio/drums';
import { busyStretches, busiestStretch, findInstrument } from '../audio/finder';
import { guessVoice } from '../audio/packmap';
import { userKitDef } from '../audio/packs';
import { putFile, saveKit } from '../core/library';
import type { Store } from '../core/store';
import { cloneSong, type Track } from '../core/types';
import { desktop } from './desktop';

export interface KitContext {
  store: Store;
  drums: Track;
  stem: AudioBuffer;
  offset: number;
  signal: AbortSignal;
  progress: (label: string, fraction: number) => void;
}

/** Most files tried per voice (spread evenly over the folder when there are more). */
const MAX_TRIED = 70;
/** A voice needs this many hits in the song to be worth a search. */
const MIN_HITS = 12;
const NAMES: Record<number, string> = { 36: 'kick', 38: 'snare', 39: 'clap', 37: 'rim', 42: 'hat', 46: 'open hat', 49: 'crash', 51: 'ride' };

const base = (p: string) => p.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
const spread = <T>(xs: T[], n: number): T[] => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]));

export async function buildKitFromLibrary(c: KitContext): Promise<string[]> {
  const app = desktop();
  if (!app?.kitFiles) return [];
  const files = (await app.kitFiles()).sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  if (files.length < 20) return [];
  const read = async (p: string) => {
    const u = await app.readFile(p);
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  };
  const song = c.store.song;
  const cur = KIT_BY_ID.get(c.drums.instrument);
  const fb = cur && (cur.group === 'Synthesized' || !cur.group) ? cur : (KIT_BY_ID.get(cur?.fallback ?? 'trap') ?? KIT_BY_ID.get('trap')!);
  const counts = new Map<number, number>();
  for (const n of c.drums.notes) counts.set(n.pitch, (counts.get(n.pitch) ?? 0) + 1);
  const voices = [...counts].filter(([, n]) => n >= MIN_HITS).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
  const chosen = new Map<number, { path: string; levelDb: number }>();

  for (const [vi, v] of voices.entries()) {
    const tried = spread(files.filter((f) => guessVoice(f.rel) === v), MAX_TRIED);
    if (tried.length < 2) continue;
    c.progress(`Trying your ${NAMES[v] ?? 'drum'} sounds (${tried.length})…`, vi / voices.length);
    // Just this voice's hits, so the comparison is about this sound alone.
    const tmp = cloneSong(song);
    tmp.tracks = tmp.tracks.filter((t) => t.id === c.drums.id);
    const track = tmp.tracks[0];
    track.notes = track.notes.filter((n) => n.pitch === v);
    track.mute = track.solo = false;
    const ids = tried.map((f, i) => {
      const id = `trykit:${v}:${i}`;
      const def: KitDef = { id, label: base(f.rel), group: 'Your packs', voices: fb.voices, fallback: fb.id, samples: { fetch: read, files: { [v]: f.path } } };
      registerKit(def);
      return id;
    });
    try {
      const span = busiestStretch(tmp, track);
      const res = await findInstrument({ song: tmp, trackId: track.id, from: span.from, to: span.to, reference: c.stem, offset: c.offset, candidates: ids, signal: c.signal });
      const best = res[0];
      if (best) chosen.set(v, { path: tried[Number(best.id.split(':')[2])].path, levelDb: best.levelDb });
    } finally {
      for (const id of ids) unregisterKit(id);
    }
  }
  if (!chosen.size) return [];

  // One kit from the winners, each voice as loud as the original has it relative to the others.
  c.progress('Putting the drums together…', 0.98);
  const top = Math.max(...[...chosen.values()].map((x) => x.levelDb));
  const levels: Record<number, number> = {};
  const picks: Record<number, string> = {};
  for (const [v, x] of chosen) {
    levels[v] = Math.max(0.12, Math.min(1, Math.pow(10, (x.levelDb - top) / 20)));
    picks[v] = x.path;
  }
  const trial: KitDef = { id: 'trykit:all', label: 'Your kit', group: 'Your packs', voices: fb.voices, fallback: fb.id, samples: { fetch: read, files: picks, levels } };
  registerKit(trial);
  let report: string[] = [];
  try {
    const spans = busyStretches(song, c.drums, 8, 3);
    const solo = (instrument: string) => {
      const s = cloneSong(c.store.song);
      s.tracks = s.tracks.filter((t) => t.id === c.drums.id);
      s.tracks[0].mute = s.tracks[0].solo = false;
      s.tracks[0].instrument = instrument;
      return s;
    };
    const before = await partScore(solo(c.drums.instrument), c.stem, c.offset, 'drums', spans);
    const after = await partScore(solo(trial.id), c.stem, c.offset, 'drums', spans);
    const names = [...chosen.keys()].map((v) => `${NAMES[v] ?? v}: ${base(picks[v].replace(/\\/g, '/'))}`).join(', ');
    if (after > before + 1) {
      // Keep it: the recordings go into the library, so the project carries them.
      const stored: Record<number, string> = {};
      for (const [v, p] of Object.entries(picks)) stored[Number(v)] = await putFile(base(p.replace(/\\/g, '/')) + '.wav', await read(p));
      const kit = await saveKit(`${song.name} drums`, stored, levels);
      registerKit(userKitDef(kit));
      const was = KIT_BY_ID.get(c.drums.instrument)?.label ?? c.drums.instrument;
      c.store.update(() => (c.drums.instrument = kit.id));
      report = [`Drums: your own sounds (${names}), matching the original ${Math.round(after)} of 100 (the best built-in kit, ${was}: ${Math.round(before)})`];
    } else {
      report = [`Drums: your own sounds (${names}) matched ${Math.round(after)} of 100, no better than the built-in kit (${Math.round(before)}), so the built-in kit stays`];
    }
  } finally {
    unregisterKit(trial.id);
  }
  return report;
}
