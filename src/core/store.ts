import { AUTO_PARAMS } from './automation';
import { SCALES } from './theory';
import { BAR, bumpNoteIds, cloneSong, DEFAULT_MASTER, DEFAULT_SAMPLER, DUCK_RELEASE, HPF_OFF, LPF_OFF, MAX_BARS, newNoteId, newTrackId, STEP, type AutoParam, type SamplerSettings, type Song, type Track, type TrackFx } from './types';
import { DEFAULT_VISUAL, mergeVisual, type VisualSettings } from '../visual/settings';

export type StoreEvent = 'song' | 'visual' | 'ui' | 'history';
type Listener = () => void;

export interface UIState {
  selectedTrackId: string;
  /** Grid size in ticks for the editor. */
  grid: number;
  /** Editor horizontal zoom: pixels per 16th step. */
  stepWidth: number;
  follow: boolean;
  record: boolean;
  /** Computer-keyboard note input. */
  keys: boolean;
  metronome: boolean;
  maximized: boolean;
  inspectorTab: 'beat' | 'visual' | 'export';
  /** Last used note length for new melodic notes (ticks). */
  noteLength: number;
  /** What the editor's bottom lane shows: note velocities or an automation lane. */
  lane: 'velocity' | AutoParam;
}

const SONG_KEY = 'beatmaker.song.v1';
const VISUAL_KEY = 'beatmaker.visual.v1';
const UI_KEY = 'beatmaker.ui.v1';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable or full – ignore */
  }
}

export class Store {
  song!: Song;
  visual: VisualSettings = { ...DEFAULT_VISUAL };
  ui: UIState = {
    selectedTrackId: '',
    grid: STEP,
    stepWidth: 26,
    follow: true,
    record: false,
    keys: false,
    metronome: false,
    maximized: false,
    inspectorTab: 'beat',
    noteLength: STEP * 2,
    lane: 'velocity',
  };
  /** Increments on every song change; used by caches. */
  songVersion = 0;
  visualVersion = 0;

  private listeners = new Map<StoreEvent, Set<Listener>>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private gesture: string | null = null;
  private saveTimer = 0;

  on(ev: StoreEvent, fn: Listener): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(ev: StoreEvent): void {
    this.listeners.get(ev)?.forEach((fn) => fn());
  }

  get track(): Track | undefined {
    return this.song.tracks.find((t) => t.id === this.ui.selectedTrackId) ?? this.song.tracks[0];
  }

  /** Replace the whole song (new project, import, generate). Undoable. */
  loadSong(song: Song, undoable = true): void {
    if (undoable && this.song) this.pushUndo(JSON.stringify(this.song));
    this.song = song;
    bumpNoteIds(song);
    if (!song.tracks.some((t) => t.id === this.ui.selectedTrackId)) {
      this.ui.selectedTrackId = song.tracks[0]?.id ?? '';
    }
    this.changed();
    this.emit('ui');
  }

  /** Mutate the song as one undoable step. */
  update(mutate: (song: Song) => void): void {
    const before = JSON.stringify(this.song);
    mutate(this.song);
    // An edit that changed nothing must not add an undo step (it would also clear redo).
    if (this.gesture === null && JSON.stringify(this.song) !== before) this.pushUndo(before);
    this.changed();
  }

  /** Start a continuous edit (e.g. a mouse drag). Call touch() while dragging and endGesture() once. */
  beginGesture(): void {
    if (this.gesture === null) this.gesture = JSON.stringify(this.song);
  }

  touch(): void {
    this.changed();
  }

  endGesture(): void {
    if (this.gesture === null) return;
    const before = this.gesture;
    this.gesture = null;
    if (before !== JSON.stringify(this.song)) this.pushUndo(before);
  }

  private pushUndo(snapshot: string): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.song));
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.song));
    this.restore(s);
  }

  private restore(json: string): void {
    this.song = JSON.parse(json) as Song;
    bumpNoteIds(this.song);
    if (!this.song.tracks.some((t) => t.id === this.ui.selectedTrackId)) {
      this.ui.selectedTrackId = this.song.tracks[0]?.id ?? '';
      this.emit('ui');
    }
    this.changed();
    this.emit('history');
  }

  private changed(): void {
    this.songVersion++;
    this.emit('song');
    this.scheduleSave();
  }

  setVisual(patch: Partial<VisualSettings>): void {
    Object.assign(this.visual, patch);
    this.visualVersion++;
    this.emit('visual');
    this.scheduleSave();
  }

  replaceVisual(v: VisualSettings): void {
    this.visual = v;
    this.visualVersion++;
    this.emit('visual');
    this.scheduleSave();
  }

  setUI(patch: Partial<UIState>): void {
    Object.assign(this.ui, patch);
    this.emit('ui');
    this.scheduleSave();
  }

  snapshotSong(): Song {
    return cloneSong(this.song);
  }

  // -------------------------------------------------------------------------------------------
  // Persistence

  restoreSaved(): boolean {
    const v = safeGet(VISUAL_KEY);
    if (v) {
      try {
        this.visual = mergeVisual(JSON.parse(v));
      } catch {
        /* ignore */
      }
    }
    const u = safeGet(UI_KEY);
    if (u) {
      try {
        const parsed = JSON.parse(u) as Partial<UIState>;
        this.ui = { ...this.ui, ...parsed, maximized: false, record: false };
        if (this.ui.lane !== 'velocity' && !AUTO_PARAMS.some((p) => p.id === this.ui.lane)) this.ui.lane = 'velocity';
      } catch {
        /* ignore */
      }
    }
    const s = safeGet(SONG_KEY);
    if (s) {
      try {
        const song = JSON.parse(s) as Song;
        if (song && Array.isArray(song.tracks)) {
          this.song = normalizeSong(song);
          bumpNoteIds(this.song);
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): void {
    if (this.song) safeSet(SONG_KEY, JSON.stringify(this.song));
    safeSet(VISUAL_KEY, JSON.stringify(this.visual));
    safeSet(UI_KEY, JSON.stringify(this.ui));
  }
}

/** A finite number within [lo, hi], or the fallback for anything else (missing, NaN, a string…). */
function num(v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** Section markers on bar lines inside the song, one per bar, with short names. */
function normalizeSections(v: unknown, bars: number): Song['sections'] {
  if (!Array.isArray(v)) return undefined;
  const byTick = new Map<number, string>();
  for (const s of v) {
    if (!s || !Number.isFinite(s.tick) || typeof s.name !== 'string') continue;
    const tick = Math.round(s.tick / BAR) * BAR;
    if (tick >= 0 && tick < bars * BAR) byTick.set(tick, s.name.slice(0, 24) || 'Section');
  }
  const list = [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, name]) => ({ tick, name }));
  return list.length ? list : undefined;
}

/** Keep known lanes with finite, in-range points, sorted and one per tick. */
function normalizeAutomation(v: unknown): Track['automation'] {
  if (!v || typeof v !== 'object') return undefined;
  const out: NonNullable<Track['automation']> = {};
  for (const def of AUTO_PARAMS) {
    const pts = (v as Record<string, unknown>)[def.id];
    if (!Array.isArray(pts)) continue;
    const byTick = new Map<number, number>();
    for (const p of pts) {
      if (!p || !Number.isFinite(p.tick) || !Number.isFinite(p.value)) continue;
      byTick.set(Math.max(0, Math.round(p.tick)), Math.max(def.min, Math.min(def.max, p.value)));
    }
    const list = [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({ tick, value }));
    if (list.length) out[def.id] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeFx(v: unknown): TrackFx | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: TrackFx = {};
  for (const k of ['saturation', 'lofi', 'comp', 'chorus', 'wobble'] as const) {
    const x = Number(o[k]);
    if (Number.isFinite(x) && x > 0) out[k] = Math.min(1, x);
  }
  const w = Number(o.width);
  if (Number.isFinite(w) && Math.abs(w - 1) > 0.001) out.width = Math.max(0, Math.min(2, w));
  return Object.keys(out).length ? out : undefined;
}

function normalizeSampler(v: Partial<SamplerSettings> | undefined): SamplerSettings | undefined {
  if (!v || typeof v.file !== 'string' || !v.file) return undefined;
  const d = DEFAULT_SAMPLER;
  const start = num(v.start, d.start, 0, 0.99);
  return {
    file: v.file,
    name: typeof v.name === 'string' ? v.name : 'Sample',
    mode: v.mode === 'slice' || v.mode === 'loop' ? v.mode : 'pitch',
    root: Math.round(num(v.root, d.root, 0, 127)),
    start,
    end: num(v.end, d.end, start + 0.01, 1),
    slices: Math.round(num(v.slices, d.slices, 1, 32)),
    points: Array.isArray(v.points) ? v.points.filter((p) => Number.isFinite(p) && p >= 0).slice(0, 32).sort((a, b) => a - b) : undefined,
    beats: num(v.beats, d.beats, 0.25, 256),
    gain: num(v.gain, d.gain, -24, 12),
    attack: num(v.attack, d.attack, 0, 2),
    release: num(v.release, d.release, 0, 4),
    reverse: !!v.reverse,
  };
}

/**
 * Fill in missing fields and clamp bad values in older, foreign or hand-edited song JSON, so a
 * broken project can't produce NaN times or gains that stop playback.
 */
export function normalizeSong(song: Partial<Song>): Song {
  const bars = Math.round(num(song.bars, 4, 1, MAX_BARS));
  const ids = new Set<string>();
  const s: Song = {
    name: typeof song.name === 'string' ? song.name : 'Untitled Beat',
    artist: typeof song.artist === 'string' ? song.artist : '',
    bpm: num(song.bpm, 120, 20, 400),
    tempoChanges: (Array.isArray(song.tempoChanges) ? song.tempoChanges : [])
      .filter((c) => c && Number.isFinite(c.tick) && c.tick >= 0 && Number.isFinite(c.bpm) && c.bpm > 0)
      .map((c) => ({ tick: c.tick, bpm: Math.max(20, Math.min(400, c.bpm)) })),
    swing: num(song.swing, 0, 0, 1),
    bars,
    key: ((Math.round(num(song.key, 0)) % 12) + 12) % 12,
    scale: typeof song.scale === 'string' && SCALES[song.scale] ? song.scale : 'minor',
    tracks: (Array.isArray(song.tracks) ? song.tracks : []).map((t) => {
      let id = typeof t.id === 'string' && t.id ? t.id : newTrackId();
      while (ids.has(id)) id = newTrackId();
      ids.add(id);
      const kind = t.kind === 'drums' ? 'drums' : 'synth';
      return {
        id,
        name: typeof t.name === 'string' ? t.name : 'Track',
        kind,
        instrument: typeof t.instrument === 'string' ? t.instrument : kind === 'drums' ? 'trap' : 'pluck',
        color: typeof t.color === 'string' ? t.color : '#00e5ff',
        volume: num(t.volume, 0.8, 0, 1.5),
        pan: num(t.pan, 0, -1, 1),
        reverb: num(t.reverb, 0.15, 0, 1),
        echo: num(t.echo, 0, 0, 1),
        tune: Math.round(num(t.tune, 0, -100, 100)),
        release: num(t.release, 0, 0, 2),
        duck: num(t.duck, 0, 0, 30),
        duckRelease: num(t.duckRelease, DUCK_RELEASE, 0.03, 1.5),
        eqLow: num(t.eqLow, 0, -18, 18),
        eqMid: num(t.eqMid, 0, -18, 18),
        eqMidFreq: num(t.eqMidFreq, 1000, 100, 10000),
        eqHigh: num(t.eqHigh, 0, -18, 18),
        hpf: num(t.hpf, HPF_OFF, HPF_OFF, 5000),
        lpf: num(t.lpf, LPF_OFF, 100, LPF_OFF),
        res: num(t.res, 0, 0, 1),
        sampler: normalizeSampler(t.sampler),
        fx: normalizeFx(t.fx),
        automation: normalizeAutomation(t.automation),
        mute: !!t.mute,
        solo: !!t.solo,
        visible: t.visible ?? true,
        notes: (Array.isArray(t.notes) ? t.notes : [])
          .filter((n) => n && Number.isFinite(n.start) && Number.isFinite(n.pitch))
          .map((n) => ({
            id: Number.isFinite(n.id) ? n.id : newNoteId(),
            pitch: Math.round(Math.max(0, Math.min(127, n.pitch))),
            start: Math.max(0, Math.round(n.start)),
            dur: Math.max(1, Math.round(num(n.dur, STEP))),
            vel: num(n.vel, 0.8, 0.05, 1),
          })),
      };
    }),
    loop: {
      enabled: !!song.loop?.enabled,
      start: Math.max(0, num(song.loop?.start, 0)),
      end: Math.max(0, num(song.loop?.end, bars * BAR)),
    },
    audioOffset: num(song.audioOffset, 0, -600, 600),
    synthsWithAudio: song.synthsWithAudio ?? true,
    tuning: Math.round(num(song.tuning, 0, -100, 100)),
    echoBeats: num(song.echoBeats, 0.75, 0.125, 4),
    sections: normalizeSections(song.sections, bars),
    master: {
      eq: DEFAULT_MASTER.eq.map((d, i) => Math.round(num(song.master?.eq?.[i], d, -15, 15) * 2) / 2),
      width: num(song.master?.width, 1, 0, 2.5),
      gain: num(song.master?.gain, 0, -24, 12),
      reverbSize: num(song.master?.reverbSize, 2.4, 0.3, 6),
    },
  };
  return s;
}

export const store = new Store();
