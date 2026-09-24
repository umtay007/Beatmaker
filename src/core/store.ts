import { bumpNoteIds, cloneSong, STEP, type Song, type Track } from './types';
import { DEFAULT_VISUAL, type VisualSettings } from '../visual/settings';

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
    if (this.gesture === null) this.pushUndo(before);
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
        this.visual = { ...DEFAULT_VISUAL, ...(JSON.parse(v) as Partial<VisualSettings>) };
      } catch {
        /* ignore */
      }
    }
    const u = safeGet(UI_KEY);
    if (u) {
      try {
        const parsed = JSON.parse(u) as Partial<UIState>;
        this.ui = { ...this.ui, ...parsed, maximized: false, record: false };
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

/** Fill in any fields missing from older or foreign song JSON. */
export function normalizeSong(song: Partial<Song>): Song {
  const s: Song = {
    name: song.name ?? 'Untitled Beat',
    artist: song.artist ?? '',
    bpm: song.bpm ?? 120,
    tempoChanges: song.tempoChanges ?? [],
    swing: song.swing ?? 0,
    bars: Math.max(1, Math.min(256, song.bars ?? 4)),
    key: song.key ?? 0,
    scale: song.scale ?? 'minor',
    tracks: (song.tracks ?? []).map((t) => ({
      id: t.id,
      name: t.name ?? 'Track',
      kind: t.kind ?? 'synth',
      instrument: t.instrument ?? (t.kind === 'drums' ? 'trap' : 'pluck'),
      color: t.color ?? '#00e5ff',
      volume: t.volume ?? 0.8,
      pan: t.pan ?? 0,
      reverb: t.reverb ?? 0.15,
      mute: !!t.mute,
      solo: !!t.solo,
      visible: t.visible ?? true,
      notes: (t.notes ?? []).filter((n) => Number.isFinite(n.start) && Number.isFinite(n.pitch)),
    })),
    loop: song.loop ?? { enabled: false, start: 0, end: (song.bars ?? 4) * 384 },
    audioOffset: song.audioOffset ?? 0,
    synthsWithAudio: song.synthsWithAudio ?? true,
  };
  return s;
}

export const store = new Store();
