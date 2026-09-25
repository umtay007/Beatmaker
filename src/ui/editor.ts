import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import { DRUM_VOICES, inScale, keyPrefersFlats, noteName } from '../core/theory';
import { BAR, newNoteId, PPQ, songLengthTicks, STEP, type Note, type Track } from '../core/types';

const RULER = 24;
const VEL = 54;
const GUTTER = 84;

interface Drag {
  kind: 'create' | 'move' | 'resize' | 'marquee' | 'paint' | 'erase' | 'velocity' | 'seek' | 'loop' | 'hscroll' | 'pan';
  x0: number;
  y0: number;
  tick0: number;
  row0: number;
  notes?: { n: Note; start: number; pitch: number; dur: number }[];
  created?: Note;
  moved?: boolean;
  paintVel?: number;
  scroll0?: number;
  scrollY0?: number;
}

/** Canvas based piano roll (melodic tracks) and step grid (drum tracks). */
export class Editor {
  readonly wrap: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** Horizontal scroll in ticks. */
  scrollX = 0;
  /** Vertical scroll in pixels. */
  scrollY = 0;
  selection = new Set<number>();
  private drag: Drag | null = null;
  private hover: { x: number; y: number } | null = null;
  private dirty = true;
  private clipboard: { notes: Omit<Note, 'id'>[]; span: number } | null = null;
  private lastTrackId = '';
  private lastPlayX = -1;

  constructor(
    private store: Store,
    private engine: AudioEngine,
  ) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'editor-canvas-wrap';
    this.wrap.tabIndex = 0;
    this.wrap.setAttribute('aria-label', 'Note editor');
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.wrap.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bind();
    store.on('song', () => this.invalidate());
    store.on('ui', () => {
      if (store.ui.selectedTrackId !== this.lastTrackId) {
        this.lastTrackId = store.ui.selectedTrackId;
        this.selection.clear();
        this.centerOnNotes();
      }
      this.invalidate();
    });
  }

  get track(): Track | undefined {
    return this.store.track;
  }

  private get isDrums(): boolean {
    return this.track?.kind === 'drums';
  }

  private get rowH(): number {
    return this.isDrums ? 22 : 14;
  }

  private get rows(): number {
    return this.isDrums ? DRUM_VOICES.length : 128;
  }

  private rowToPitch(row: number): number {
    return this.isDrums ? DRUM_VOICES[row]?.pitch ?? 36 : 127 - row;
  }

  private pitchToRow(pitch: number): number {
    if (this.isDrums) return DRUM_VOICES.findIndex((v) => v.pitch === pitch);
    return 127 - pitch;
  }

  private get gridH(): number {
    return this.h - RULER - VEL;
  }

  private get pxPerTick(): number {
    return this.store.ui.stepWidth / STEP;
  }

  tickToX(tick: number): number {
    return GUTTER + (tick - this.scrollX) * this.pxPerTick;
  }

  xToTick(x: number): number {
    return (x - GUTTER) / this.pxPerTick + this.scrollX;
  }

  private rowToY(row: number): number {
    return RULER + row * this.rowH - this.scrollY;
  }

  private yToRow(y: number): number {
    return Math.floor((y - RULER + this.scrollY) / this.rowH);
  }

  private snap(tick: number): number {
    const g = this.store.ui.grid;
    return Math.floor(tick / g) * g;
  }

  private snapRound(tick: number): number {
    const g = this.store.ui.grid;
    return Math.round(tick / g) * g;
  }

  invalidate(): void {
    this.dirty = true;
  }

  private resize(): void {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.clampScroll();
    this.invalidate();
  }

  private clampScroll(): void {
    const maxY = Math.max(0, this.rows * this.rowH - this.gridH);
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
    const total = songLengthTicks(this.store.song);
    const visible = (this.w - GUTTER) / this.pxPerTick;
    this.scrollX = Math.max(0, Math.min(Math.max(0, total - visible * 0.5), this.scrollX));
  }

  centerOnNotes(): void {
    const t = this.track;
    if (!t || this.isDrums) {
      this.scrollY = 0;
      return;
    }
    let avg = 60;
    if (t.notes.length) avg = t.notes.reduce((s, n) => s + n.pitch, 0) / t.notes.length;
    else if (t.instrument.includes('bass') || t.instrument === 'sub' || t.instrument === 'logdrum' || t.instrument === 'reese') avg = 36;
    this.scrollY = this.pitchToRow(Math.round(avg)) * this.rowH - this.gridH / 2;
    this.clampScroll();
  }

  zoom(factor: number, anchorX = GUTTER): void {
    const tick = this.xToTick(anchorX);
    const sw = Math.max(6, Math.min(90, this.store.ui.stepWidth * factor));
    this.store.ui.stepWidth = sw;
    this.scrollX = tick - (anchorX - GUTTER) / this.pxPerTick;
    this.clampScroll();
    this.store.setUI({});
  }

  // -------------------------------------------------------------------------------------------
  // Hit testing

  private noteAt(x: number, y: number): { note: Note; edge: boolean } | null {
    const t = this.track;
    if (!t || y < RULER || y > RULER + this.gridH) return null;
    const row = this.yToRow(y);
    const pitch = this.rowToPitch(row);
    const tick = this.xToTick(x);
    let best: { note: Note; edge: boolean } | null = null;
    for (const n of t.notes) {
      if (n.pitch !== pitch) continue;
      const dur = this.isDrums ? Math.max(n.dur, STEP / 2) : n.dur;
      if (tick >= n.start && tick < n.start + dur) {
        const xEnd = this.tickToX(n.start + dur);
        best = { note: n, edge: !this.isDrums && xEnd - x < 7 && xEnd - this.tickToX(n.start) > 10 };
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Input

  private bind(): void {
    const c = this.wrap;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.invalidate();
    });
    c.addEventListener('dblclick', (e) => {
      const p = this.local(e);
      const hit = this.noteAt(p.x, p.y);
      if (hit && !this.isDrums) this.deleteNotes([hit.note.id]);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        if (e.ctrlKey || e.metaKey) {
          this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, Math.max(GUTTER, p.x));
          return;
        }
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        this.scrollX += dx / this.pxPerTick;
        this.scrollY += dy;
        this.clampScroll();
        this.invalidate();
      },
      { passive: false },
    );
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    const t = this.track;
    if (!t) return;
    this.wrap.focus({ preventScroll: true });
    void this.engine.unlock();
    const { x, y } = this.local(e);
    const tick = this.xToTick(x);
    const row = this.yToRow(y);
    this.wrap.setPointerCapture(e.pointerId);
    const base = { x0: x, y0: y, tick0: tick, row0: row };

    // Horizontal scrollbar strip at the very bottom.
    if (y > this.h - 8) {
      this.drag = { kind: 'hscroll', ...base, scroll0: this.scrollX };
      return;
    }
    // Middle button: pan.
    if (e.button === 1) {
      this.drag = { kind: 'pan', ...base, scroll0: this.scrollX, scrollY0: this.scrollY };
      return;
    }
    // Ruler: seek, or shift-drag to set the loop.
    if (y < RULER) {
      if (x < GUTTER) return;
      if (e.shiftKey) {
        const s = this.snapRound(tick);
        this.store.beginGesture();
        this.store.song.loop = { enabled: true, start: s, end: s + this.store.ui.grid };
        this.store.touch();
        this.drag = { kind: 'loop', ...base, tick0: s };
      } else {
        this.drag = { kind: 'seek', ...base };
        this.seekTo(tick);
      }
      return;
    }
    // Gutter: preview the key / drum.
    if (x < GUTTER) {
      if (y < RULER + this.gridH) this.engine.preview(t, this.rowToPitch(row), 0.85);
      return;
    }
    // Velocity lane.
    if (y > RULER + this.gridH) {
      this.store.beginGesture();
      this.drag = { kind: 'velocity', ...base };
      this.setVelocityAt(x, y);
      return;
    }
    if (row < 0 || row >= this.rows) return;

    const hit = this.noteAt(x, y);
    // Right button: erase.
    if (e.button === 2) {
      this.store.beginGesture();
      this.drag = { kind: 'erase', ...base };
      if (hit) this.removeNoteSilently(hit.note.id);
      return;
    }
    if (e.shiftKey && !hit) {
      this.drag = { kind: 'marquee', ...base };
      if (!(e.ctrlKey || e.metaKey)) this.selection.clear();
      return;
    }

    if (this.isDrums) {
      this.store.beginGesture();
      if (hit && !e.altKey) {
        this.removeNoteSilently(hit.note.id);
        this.drag = { kind: 'erase', ...base };
      } else {
        const vel = e.altKey ? 0.45 : 0.9;
        this.paintCell(tick, row, vel);
        this.drag = { kind: 'paint', ...base, paintVel: vel };
      }
      return;
    }

    if (hit) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (this.selection.has(hit.note.id)) this.selection.delete(hit.note.id);
        else this.selection.add(hit.note.id);
      } else if (!this.selection.has(hit.note.id)) {
        this.selection = new Set([hit.note.id]);
      }
      this.store.beginGesture();
      let targets = t.notes.filter((n) => this.selection.has(n.id));
      if (e.altKey) {
        // Alt-drag duplicates the selection.
        const copies = targets.map((n) => ({ ...n, id: newNoteId() }));
        t.notes.push(...copies);
        this.selection = new Set(copies.map((n) => n.id));
        targets = copies;
      }
      this.drag = {
        kind: hit.edge ? 'resize' : 'move',
        ...base,
        notes: targets.map((n) => ({ n, start: n.start, pitch: n.pitch, dur: n.dur })),
      };
      this.engine.preview(t, hit.note.pitch, hit.note.vel, 0.2);
      this.invalidate();
      return;
    }

    // Create a note and drag to set its length.
    this.store.beginGesture();
    const start = this.snap(tick);
    const pitch = this.rowToPitch(row);
    const n: Note = { id: newNoteId(), pitch, start, dur: this.store.ui.noteLength, vel: 0.8 };
    t.notes.push(n);
    this.selection = new Set([n.id]);
    this.store.touch();
    this.engine.preview(t, pitch, 0.8, 0.25);
    this.drag = { kind: 'create', ...base, created: n, notes: [{ n, start, pitch, dur: n.dur }] };
  }

  private onMove(e: PointerEvent): void {
    const { x, y } = this.local(e);
    this.hover = { x, y };
    const d = this.drag;
    const t = this.track;
    if (!d || !t) {
      const hit = this.noteAt(x, y);
      this.wrap.style.cursor = y < RULER ? 'text' : hit?.edge ? 'ew-resize' : hit ? (this.isDrums ? 'pointer' : 'grab') : x < GUTTER ? 'pointer' : 'crosshair';
      this.invalidate();
      return;
    }
    const tick = this.xToTick(x);
    const row = this.yToRow(y);
    const g = this.store.ui.grid;
    switch (d.kind) {
      case 'hscroll': {
        const total = songLengthTicks(this.store.song);
        this.scrollX = d.scroll0! + ((x - d.x0) / (this.w - GUTTER)) * total;
        this.clampScroll();
        break;
      }
      case 'pan':
        this.scrollX = d.scroll0! - (x - d.x0) / this.pxPerTick;
        this.scrollY = d.scrollY0! - (y - d.y0);
        this.clampScroll();
        break;
      case 'seek':
        this.seekTo(tick);
        break;
      case 'loop': {
        const s = this.snapRound(tick);
        const a = Math.min(d.tick0, s);
        const b = Math.max(d.tick0, s);
        this.store.song.loop = { enabled: true, start: Math.max(0, a), end: Math.max(a + g, b) };
        this.store.touch();
        break;
      }
      case 'velocity':
        this.setVelocityAt(x, y);
        break;
      case 'paint':
        if (row >= 0 && row < this.rows && x > GUTTER) this.paintCell(tick, row, d.paintVel ?? 0.9);
        break;
      case 'erase': {
        const hit = this.noteAt(x, y);
        if (hit) this.removeNoteSilently(hit.note.id);
        break;
      }
      case 'create':
      case 'resize': {
        const dt = this.snapRound(tick - d.tick0 + (d.kind === 'create' ? g : 0));
        for (const o of d.notes!) {
          const nd = d.kind === 'create' ? Math.max(g, dt) : Math.max(g / 2, o.dur + dt);
          o.n.dur = Math.round(nd);
        }
        d.moved = true;
        this.store.touch();
        break;
      }
      case 'move': {
        const dt = this.snapRound(tick - d.tick0);
        const dr = row - d.row0;
        const minStart = Math.min(...d.notes!.map((o) => o.start));
        const shift = Math.max(-minStart, dt);
        let changedPitch = false;
        for (const o of d.notes!) {
          o.n.start = o.start + shift;
          const np = Math.max(0, Math.min(127, o.pitch - dr));
          if (o.n.pitch !== np) changedPitch = true;
          o.n.pitch = np;
        }
        if (changedPitch && d.notes!.length === 1) this.engine.preview(t, d.notes![0].n.pitch, 0.7, 0.15);
        d.moved = true;
        this.store.touch();
        break;
      }
      case 'marquee':
        this.invalidate();
        break;
    }
    this.invalidate();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    try {
      this.wrap.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    if (d.kind === 'marquee') {
      const { x, y } = this.local(e);
      const t = this.track;
      if (t) {
        const x0 = Math.min(d.x0, x);
        const x1 = Math.max(d.x0, x);
        const y0 = Math.min(d.y0, y);
        const y1 = Math.max(d.y0, y);
        for (const n of t.notes) {
          const nx0 = this.tickToX(n.start);
          const nx1 = this.tickToX(n.start + Math.max(n.dur, STEP / 2));
          const ny = this.rowToY(this.pitchToRow(n.pitch));
          if (nx1 >= x0 && nx0 <= x1 && ny + this.rowH >= y0 && ny <= y1) this.selection.add(n.id);
        }
      }
    }
    if (d.kind === 'create' && d.created) this.store.ui.noteLength = d.created.dur;
    if (['create', 'move', 'resize', 'paint', 'erase', 'velocity', 'loop'].includes(d.kind)) {
      this.sortNotes();
      this.store.endGesture();
      this.store.touch();
    }
    this.invalidate();
  }

  private seekTo(tick: number): void {
    const tl = this.engine.timeline;
    this.engine.seek(tl.rawTickToSec(Math.max(0, this.snapRound(tick))));
    this.invalidate();
  }

  private paintCell(tick: number, row: number, vel: number): void {
    const t = this.track;
    if (!t) return;
    const g = this.store.ui.grid;
    const start = this.snap(tick);
    const pitch = this.rowToPitch(row);
    if (start < 0) return;
    if (t.notes.some((n) => n.pitch === pitch && n.start >= start && n.start < start + g)) return;
    t.notes.push({ id: newNoteId(), pitch, start, dur: Math.min(g, STEP), vel });
    this.engine.preview(t, pitch, vel);
    this.store.touch();
  }

  private removeNoteSilently(id: number): void {
    const t = this.track;
    if (!t) return;
    const i = t.notes.findIndex((n) => n.id === id);
    if (i >= 0) {
      t.notes.splice(i, 1);
      this.selection.delete(id);
      this.store.touch();
    }
  }

  private setVelocityAt(x: number, y: number): void {
    const t = this.track;
    if (!t) return;
    const top = RULER + this.gridH + 6;
    const vh = VEL - 12;
    const vel = Math.max(0.05, Math.min(1, 1 - (y - top) / vh));
    const useSel = this.selection.size > 0;
    let changed = false;
    for (const n of t.notes) {
      if (useSel && !this.selection.has(n.id)) continue;
      const nx = this.tickToX(n.start);
      if (Math.abs(nx - x) <= Math.max(3, this.store.ui.stepWidth * 0.3)) {
        n.vel = vel;
        changed = true;
      }
    }
    if (changed) this.store.touch();
  }

  private sortNotes(): void {
    this.track?.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }

  // -------------------------------------------------------------------------------------------
  // Editing commands (also used by keyboard shortcuts)

  deleteNotes(ids: number[]): void {
    const t = this.track;
    if (!t || !ids.length) return;
    const set = new Set(ids);
    this.store.update(() => {
      t.notes = t.notes.filter((n) => !set.has(n.id));
    });
    for (const id of ids) this.selection.delete(id);
  }

  deleteSelection(): void {
    this.deleteNotes([...this.selection]);
  }

  selectAll(): void {
    const t = this.track;
    if (!t) return;
    this.selection = new Set(t.notes.map((n) => n.id));
    this.invalidate();
  }

  copy(): boolean {
    const t = this.track;
    if (!t) return false;
    const sel = t.notes.filter((n) => this.selection.has(n.id));
    if (!sel.length) return false;
    const min = Math.min(...sel.map((n) => n.start));
    const max = Math.max(...sel.map((n) => n.start + n.dur));
    const unit = max - min > PPQ ? BAR : PPQ;
    this.clipboard = {
      notes: sel.map(({ pitch, start, dur, vel }) => ({ pitch, start: start - min, dur, vel })),
      span: Math.ceil((max - Math.floor(min / unit) * unit) / unit) * unit,
    };
    return true;
  }

  paste(): void {
    const t = this.track;
    const cb = this.clipboard;
    if (!t || !cb) return;
    const at = this.snap(this.engine.positionTicks());
    const notes = cb.notes.map((n) => ({ ...n, id: newNoteId(), start: n.start + at }));
    this.store.update(() => {
      t.notes.push(...notes);
      this.sortNotes();
    });
    this.selection = new Set(notes.map((n) => n.id));
  }

  duplicate(): void {
    const t = this.track;
    if (!t) return;
    const sel = t.notes.filter((n) => this.selection.has(n.id));
    if (!sel.length) return;
    const min = Math.min(...sel.map((n) => n.start));
    const max = Math.max(...sel.map((n) => n.start + n.dur));
    const unit = max - min > PPQ ? BAR : this.store.ui.grid;
    const span = Math.max(unit, Math.ceil((max - Math.floor(min / unit) * unit) / unit) * unit);
    const copies = sel.map((n) => ({ ...n, id: newNoteId(), start: n.start + span }));
    this.store.update((song) => {
      t.notes.push(...copies);
      this.sortNotes();
      const endBar = Math.ceil(Math.max(...copies.map((n) => n.start + n.dur)) / BAR);
      if (endBar > song.bars) song.bars = endBar;
    });
    this.selection = new Set(copies.map((n) => n.id));
  }

  transpose(semi: number): void {
    const t = this.track;
    if (!t || this.isDrums) return;
    const sel = t.notes.filter((n) => this.selection.has(n.id));
    if (!sel.length) return;
    this.store.update(() => {
      for (const n of sel) n.pitch = Math.max(0, Math.min(127, n.pitch + semi));
    });
    this.engine.preview(t, sel[0].pitch, 0.7, 0.2);
  }

  nudge(ticks: number): void {
    const t = this.track;
    if (!t) return;
    const sel = t.notes.filter((n) => this.selection.has(n.id));
    if (!sel.length) return;
    const min = Math.min(...sel.map((n) => n.start));
    const d = Math.max(-min, ticks);
    this.store.update(() => {
      for (const n of sel) n.start += d;
      this.sortNotes();
    });
  }

  quantize(): void {
    const t = this.track;
    if (!t) return;
    const g = this.store.ui.grid;
    const targets = this.selection.size ? t.notes.filter((n) => this.selection.has(n.id)) : t.notes;
    this.store.update(() => {
      for (const n of targets) {
        n.start = Math.round(n.start / g) * g;
        if (t.kind === 'synth') n.dur = Math.max(g, Math.round(n.dur / g) * g);
      }
      this.sortNotes();
    });
  }

  humanize(): void {
    const t = this.track;
    if (!t) return;
    const targets = this.selection.size ? t.notes.filter((n) => this.selection.has(n.id)) : t.notes;
    this.store.update(() => {
      for (const n of targets) {
        n.vel = Math.max(0.1, Math.min(1, n.vel + (Math.random() - 0.5) * 0.18));
        n.start = Math.max(0, n.start + Math.round((Math.random() - 0.5) * 4));
      }
      this.sortNotes();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  /** Called every animation frame. */
  frame(): void {
    const playing = this.engine.playing;
    const tick = this.engine.positionTicks();
    const x = this.tickToX(tick);
    if (playing && this.store.ui.follow && !this.drag) {
      const visible = (this.w - GUTTER) / this.pxPerTick;
      if (tick < this.scrollX || tick > this.scrollX + visible * 0.85) {
        this.scrollX = Math.max(0, tick - visible * 0.1);
        this.clampScroll();
        this.dirty = true;
      }
    }
    if (Math.abs(x - this.lastPlayX) > 0.5) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.lastPlayX = x;
    this.draw(tick);
  }

  private draw(playTick: number): void {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    const t = this.track;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0d1018';
    ctx.fillRect(0, 0, W, H);
    if (!t) return;
    const song = this.store.song;
    const rowH = this.rowH;
    const gridBottom = RULER + this.gridH;
    const total = songLengthTicks(song);
    const g = this.store.ui.grid;
    const ppt = this.pxPerTick;
    const color = t.color;
    const drums = this.isDrums;
    const flats = keyPrefersFlats(song.key, song.scale);

    // Row backgrounds
    const r0 = Math.max(0, Math.floor(this.scrollY / rowH));
    const r1 = Math.min(this.rows - 1, Math.ceil((this.scrollY + this.gridH) / rowH));
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER, W - GUTTER, this.gridH);
    ctx.clip();
    for (let r = r0; r <= r1; r++) {
      const y = this.rowToY(r);
      const pitch = this.rowToPitch(r);
      let fill: string;
      if (drums) fill = r % 2 ? '#10141f' : '#131826';
      else {
        const black = [1, 3, 6, 8, 10].includes(pitch % 12);
        const scaleTone = inScale(pitch, song.key, song.scale);
        fill = black ? '#0c0f17' : '#121724';
        if (scaleTone) fill = black ? '#111626' : '#161c2c';
        if (pitch % 12 === song.key % 12) fill = '#1a2034';
      }
      ctx.fillStyle = fill;
      ctx.fillRect(GUTTER, y, W - GUTTER, rowH);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fillRect(GUTTER, y + rowH - 1, W - GUTTER, 1);
    }
    // Beyond song end
    const endX = this.tickToX(total);
    if (endX < W) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(endX, RULER, W - endX, this.gridH);
    }
    // Loop region
    if (song.loop.enabled) {
      const lx0 = this.tickToX(song.loop.start);
      const lx1 = this.tickToX(song.loop.end);
      ctx.fillStyle = 'rgba(61,224,255,0.05)';
      ctx.fillRect(lx0, RULER, lx1 - lx0, this.gridH);
    }
    // Vertical grid lines
    const tick0 = Math.max(0, Math.floor(this.scrollX / g) * g);
    const tick1 = this.xToTick(W);
    for (let tk = tick0; tk <= tick1; tk += g) {
      const x = Math.round(this.tickToX(tk)) + 0.5;
      const isBar = tk % BAR === 0;
      const isBeat = tk % PPQ === 0;
      if (!isBeat && g * ppt < 5) continue;
      ctx.fillStyle = isBar ? 'rgba(255,255,255,0.16)' : isBeat ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, RULER, 1, this.gridH);
    }
    // Reference audio waveform (for remaking a beat by ear)
    const peaks = this.engine.backingPeaks;
    if (peaks) {
      const tl = this.engine.timeline;
      const off = song.audioOffset;
      const mid = RULER + this.gridH / 2;
      const amp = this.gridH * 0.42;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(GUTTER, mid);
      const pts: [number, number][] = [];
      for (let x = GUTTER; x <= W; x += 2) {
        const sec = tl.rawTickToSec(Math.max(0, this.xToTick(x))) - off;
        const i = Math.floor(sec * 200);
        const v = i >= 0 && i < peaks.length ? peaks[i] : 0;
        pts.push([x, v * amp]);
        ctx.lineTo(x, mid - v * amp);
      }
      for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], mid + pts[k][1]);
      ctx.closePath();
      ctx.fill();
    }

    // Drum step shading (every other beat) for readability
    if (drums) {
      for (let b = Math.floor(this.scrollX / PPQ); b * PPQ <= tick1; b++) {
        if (b % 2 === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.018)';
          ctx.fillRect(this.tickToX(b * PPQ), RULER, PPQ * ppt, this.gridH);
        }
      }
    }

    // Ghost notes from other tracks (melodic view only)
    if (!drums) {
      ctx.globalAlpha = 0.16;
      for (const other of song.tracks) {
        if (other.id === t.id || other.kind === 'drums') continue;
        ctx.fillStyle = other.color;
        for (const n of other.notes) {
          const x0 = this.tickToX(n.start);
          const x1 = this.tickToX(n.start + n.dur);
          if (x1 < GUTTER || x0 > W) continue;
          const y = this.rowToY(this.pitchToRow(n.pitch));
          if (y < RULER - rowH || y > gridBottom) continue;
          ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0 - 1), rowH - 6);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Notes
    for (const n of t.notes) {
      const row = this.pitchToRow(n.pitch);
      if (row < 0) continue;
      const y = this.rowToY(row);
      if (y < RULER - rowH || y > gridBottom) continue;
      const x0 = this.tickToX(n.start);
      const len = drums ? Math.max(STEP * ppt * 0.8, Math.min(n.dur, g) * ppt - 2) : n.dur * ppt - 1;
      if (x0 + len < GUTTER || x0 > W) continue;
      const sel = this.selection.has(n.id);
      const pad = drums ? 3 : 1;
      const w = Math.max(3, drums ? Math.min(len, g * ppt - 3) : len);
      ctx.globalAlpha = 0.35 + 0.65 * n.vel;
      ctx.fillStyle = color;
      roundRect(ctx, x0 + (drums ? 1.5 : 0), y + pad, w, rowH - pad * 2, drums ? 4 : 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x0 + (drums ? 1.5 : 0), y + pad, w, rowH - pad * 2, drums ? 4 : 3);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(x0 + (drums ? 1.5 : 0), y + pad, Math.min(w, 2), rowH - pad * 2);
      }
      if (!drums && w > 34 && rowH >= 12) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.font = '600 9px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(n.pitch, flats), x0 + 4, y + rowH / 2 + 0.5);
      }
    }

    // Hover cell
    if (this.hover && !this.drag && this.hover.x > GUTTER && this.hover.y > RULER && this.hover.y < gridBottom) {
      const r = this.yToRow(this.hover.y);
      const tk = this.snap(this.xToTick(this.hover.x));
      const y = this.rowToY(r);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(this.tickToX(tk), y, (drums ? g : this.store.ui.noteLength) * ppt, rowH);
    }

    // Marquee
    if (this.drag?.kind === 'marquee' && this.hover) {
      const d = this.drag;
      ctx.strokeStyle = 'rgba(61,224,255,0.9)';
      ctx.fillStyle = 'rgba(61,224,255,0.1)';
      ctx.lineWidth = 1;
      const x = Math.min(d.x0, this.hover.x);
      const y = Math.min(d.y0, this.hover.y);
      ctx.fillRect(x, y, Math.abs(this.hover.x - d.x0), Math.abs(this.hover.y - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(this.hover.x - d.x0), Math.abs(this.hover.y - d.y0));
    }
    ctx.restore();

    // Gutter (keys / drum names)
    ctx.fillStyle = '#0f121b';
    ctx.fillRect(0, RULER, GUTTER, this.gridH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, GUTTER, this.gridH);
    ctx.clip();
    for (let r = r0; r <= r1; r++) {
      const y = this.rowToY(r);
      const pitch = this.rowToPitch(r);
      if (drums) {
        const v = DRUM_VOICES[r];
        const used = t.notes.some((n) => n.pitch === v.pitch);
        ctx.fillStyle = used ? '#e9ecf6' : '#7c839c';
        ctx.font = `${used ? 650 : 500} 11px Inter, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(v.name, 8, y + rowH / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, y + rowH - 1, GUTTER, 1);
      } else {
        const black = [1, 3, 6, 8, 10].includes(pitch % 12);
        ctx.fillStyle = black ? '#1a1e2b' : '#d8dcea';
        ctx.fillRect(black ? 0 : 0, y, black ? GUTTER * 0.62 : GUTTER, rowH);
        if (!black) {
          ctx.fillStyle = '#9aa1b8';
          ctx.fillRect(0, y + rowH - 1, GUTTER, 1);
        }
        if (pitch % 12 === 0) {
          ctx.fillStyle = '#1b2032';
          ctx.font = '700 9.5px Inter, system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(noteName(pitch), GUTTER - 28, y + rowH / 2 + 0.5);
        }
      }
      if (this.hover && this.hover.x < GUTTER && this.yToRow(this.hover.y) === r && this.hover.y > RULER && this.hover.y < gridBottom) {
        ctx.fillStyle = 'rgba(61,224,255,0.25)';
        ctx.fillRect(0, y, GUTTER, rowH);
      }
    }
    ctx.restore();
    ctx.fillStyle = '#232a3d';
    ctx.fillRect(GUTTER - 1, RULER, 1, this.gridH);

    // Ruler
    ctx.fillStyle = '#0f121b';
    ctx.fillRect(0, 0, W, RULER);
    if (song.loop.enabled) {
      const lx0 = Math.max(GUTTER, this.tickToX(song.loop.start));
      const lx1 = this.tickToX(song.loop.end);
      if (lx1 > GUTTER) {
        ctx.fillStyle = 'rgba(61,224,255,0.35)';
        ctx.fillRect(lx0, 2, lx1 - lx0, RULER - 6);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, W - GUTTER, RULER);
    ctx.clip();
    const barPx = BAR * ppt;
    const every = barPx < 36 ? 4 : barPx < 70 ? 2 : 1;
    for (let b = Math.floor(this.scrollX / BAR); b * BAR <= tick1; b++) {
      const x = this.tickToX(b * BAR);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(Math.round(x), RULER - 8, 1, 8);
      if (b % every === 0) {
        ctx.fillStyle = b < song.bars ? '#c4c9da' : '#5d6480';
        ctx.font = '600 10.5px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b + 1), x + 4, RULER / 2);
      }
      if (barPx > 90) {
        for (let q = 1; q < 4; q++) {
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.fillRect(Math.round(x + q * PPQ * ppt), RULER - 4, 1, 4);
        }
      }
    }
    ctx.restore();
    ctx.fillStyle = '#232a3d';
    ctx.fillRect(0, RULER - 1, W, 1);
    ctx.fillStyle = '#626985';
    ctx.font = '600 9.5px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(drums ? 'STEPS' : 'KEYS', 8, RULER / 2);

    // Velocity lane
    const vTop = gridBottom;
    ctx.fillStyle = '#0b0e15';
    ctx.fillRect(0, vTop, W, VEL);
    ctx.fillStyle = '#232a3d';
    ctx.fillRect(0, vTop, W, 1);
    ctx.fillStyle = '#626985';
    ctx.fillText('VELOCITY', 8, vTop + 14);
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, vTop, W - GUTTER, VEL);
    ctx.clip();
    const vh = VEL - 12;
    for (const n of t.notes) {
      const x = this.tickToX(n.start);
      if (x < GUTTER - 4 || x > W) continue;
      const hgt = vh * n.vel;
      ctx.fillStyle = this.selection.has(n.id) ? '#ffffff' : color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, vTop + 6 + vh - hgt, 3, hgt);
      ctx.beginPath();
      ctx.arc(x + 1.5, vTop + 6 + vh - hgt, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Horizontal scrollbar
    const visible = (W - GUTTER) / ppt;
    const sbW = Math.max(30, ((W - GUTTER) * visible) / Math.max(total, visible));
    const sbX = GUTTER + ((W - GUTTER - sbW) * this.scrollX) / Math.max(1, total - visible * 0.5);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, Math.min(W - sbW, sbX), H - 6, sbW, 4, 2);
    ctx.fill();

    // Playhead
    const px = this.tickToX(playTick);
    if (px >= GUTTER && px <= W) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(px), 0, 1.5, H - 8);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 6.5, 0);
      ctx.lineTo(px + 0.75, 7);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
