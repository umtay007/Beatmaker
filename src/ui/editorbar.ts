import type { AudioEngine } from '../audio/engine';
import { GENRES, regeneratePart } from '../beats/generator';
import type { Store } from '../core/store';
import { PPQ, STEP } from '../core/types';
import type { Actions } from './actions';
import { h, icon, showMenu } from './dom';
import type { Editor } from './editor';
import { instrumentOptions } from './tracks';

const GRIDS: [number, string][] = [
  [PPQ, '1/4'],
  [PPQ / 2, '1/8'],
  [STEP, '1/16'],
  [STEP / 2, '1/32'],
  [PPQ / 3, '1/8 T'],
  [PPQ / 6, '1/16 T'],
];

const LENGTHS: [number, string][] = [
  [STEP / 2, '1/32'],
  [STEP, '1/16'],
  [STEP * 2, '1/8'],
  [PPQ, '1/4'],
  [PPQ * 2, '1/2'],
  [PPQ * 4, '1 bar'],
];

export class EditorBar {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private inst: HTMLSelectElement;
  private grid: HTMLSelectElement;
  private len: HTMLSelectElement;
  private lenWrap: HTMLElement;
  private pan: HTMLInputElement;
  private rev: HTMLInputElement;
  private follow: HTMLButtonElement;
  private keys: HTMLButtonElement;
  private instKind = '';

  constructor(
    private store: Store,
    engine: AudioEngine,
    private editor: Editor,
    private actions: Actions,
  ) {
    this.title = h('div', { class: 'editor-title' });
    this.inst = h('select', { class: 'select', 'aria-label': 'Instrument' }) as HTMLSelectElement;
    this.inst.addEventListener('change', () => {
      const t = store.track;
      if (!t) return;
      store.update(() => (t.instrument = this.inst.value));
      void engine.ensureKits();
      engine.preview(t, t.kind === 'drums' ? 36 : 60, 0.8, 0.4);
    });
    this.grid = h('select', { class: 'select', 'aria-label': 'Grid' }, GRIDS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    this.grid.addEventListener('change', () => store.setUI({ grid: Number(this.grid.value) }));
    this.len = h('select', { class: 'select', 'aria-label': 'New note length' }, LENGTHS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    this.len.addEventListener('change', () => store.setUI({ noteLength: Number(this.len.value) }));
    this.lenWrap = h('span', { style: { display: 'contents' } }, h('span', { class: 'lbl' }, 'Length'), this.len);

    const mini = (label: string, min: number, max: number, key: 'pan' | 'reverb') => {
      const r = h('input', { type: 'range', class: 'range mini-range', min, max, step: 0.01, 'aria-label': label, title: label }) as HTMLInputElement;
      r.addEventListener('pointerdown', () => store.beginGesture());
      r.addEventListener('input', () => {
        const t = store.track;
        if (!t) return;
        t[key] = Number(r.value);
        store.touch();
        this.paintMini();
      });
      r.addEventListener('change', () => store.endGesture());
      r.addEventListener('dblclick', () => {
        const t = store.track;
        if (!t || key !== 'pan') return;
        store.update(() => (t.pan = 0));
      });
      return r;
    };
    this.pan = mini('Pan (double-click to center)', -1, 1, 'pan');
    this.rev = mini('Reverb send', 0, 1, 'reverb');

    this.follow = h('button', { class: 'icon-btn', title: 'Follow playhead', 'aria-label': 'Follow playhead', onclick: () => store.setUI({ follow: !store.ui.follow }) }, icon('follow', 17)) as HTMLButtonElement;
    this.keys = h('button', { class: 'icon-btn', title: 'Play notes with your computer keyboard (K)', 'aria-label': 'Computer keyboard input', onclick: () => store.setUI({ keys: !store.ui.keys }) }, icon('keyboard', 17)) as HTMLButtonElement;

    const tools = h(
      'button',
      { class: 'btn btn-ghost', onclick: (e: MouseEvent) => this.toolsMenu(e.currentTarget as HTMLElement) },
      icon('magnet', 15),
      'Tools',
      icon('chevron', 13),
    );
    const newPart = h(
      'button',
      { class: 'btn btn-ghost', title: 'Write a new part for this track', onclick: (e: MouseEvent) => this.partMenu(e.currentTarget as HTMLElement) },
      icon('dice', 15),
      'New part',
    );

    this.el = h(
      'div',
      { class: 'editor-bar' },
      this.title,
      this.inst,
      h('div', { class: 'divider' }),
      h('span', { class: 'lbl' }, 'Grid'),
      this.grid,
      this.lenWrap,
      h('div', { class: 'divider' }),
      h('span', { class: 'lbl hide-sm' }, 'Pan'),
      this.pan,
      h('span', { class: 'lbl hide-sm' }, 'Verb'),
      this.rev,
      h('div', { class: 'divider' }),
      newPart,
      tools,
      h('div', { class: 'spacer' }),
      this.keys,
      this.follow,
      h('button', { class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => editor.zoom(1 / 1.3) }, icon('zoomOut', 17)),
      h('button', { class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => editor.zoom(1.3) }, icon('zoomIn', 17)),
    );
    store.on('ui', () => this.sync());
    store.on('song', () => this.sync());
    this.sync();
  }

  private paintMini(): void {
    for (const [r, min, max] of [
      [this.pan, -1, 1],
      [this.rev, 0, 1],
    ] as const) {
      r.style.setProperty('--pct', `${((Number(r.value) - min) / (max - min)) * 100}%`);
    }
  }

  private sync(): void {
    const t = this.store.track;
    const ui = this.store.ui;
    if (!t) {
      this.title.textContent = 'No track';
      return;
    }
    this.title.style.setProperty('--tc', t.color);
    this.title.replaceChildren(h('i'), t.name);
    if (this.instKind !== t.kind) {
      this.instKind = t.kind;
      this.inst.replaceChildren();
      let group: HTMLOptGroupElement | null = null;
      for (const [v, l] of instrumentOptions(t.kind)) {
        if (v.startsWith('group:')) {
          group = h('optgroup', { label: l });
          this.inst.append(group);
        } else (group ?? this.inst).append(h('option', { value: v }, l));
      }
    }
    this.inst.value = t.instrument;
    this.grid.value = String(ui.grid);
    if (![...this.grid.options].some((o) => o.value === String(ui.grid))) this.grid.value = String(STEP);
    this.len.value = String(ui.noteLength);
    this.lenWrap.style.display = t.kind === 'drums' ? 'none' : 'contents';
    if (document.activeElement !== this.pan) this.pan.value = String(t.pan);
    if (document.activeElement !== this.rev) this.rev.value = String(t.reverb);
    this.paintMini();
    this.follow.classList.toggle('on', ui.follow);
    this.keys.classList.toggle('on', ui.keys);
  }

  private toolsMenu(anchor: HTMLElement): void {
    const e = this.editor;
    const t = this.store.track;
    showMenu(anchor, [
      { label: 'Select all', hint: 'Ctrl+A', action: () => e.selectAll() },
      { label: 'Duplicate selection', hint: 'Ctrl+D', icon: 'duplicate', action: () => e.duplicate() },
      { label: 'Quantize to grid', hint: 'Q', icon: 'magnet', action: () => e.quantize() },
      { label: 'Humanize', icon: 'dice', action: () => e.humanize() },
      '-',
      { label: 'Transpose +1 octave', action: () => { e.selectAll(); e.transpose(12); } },
      { label: 'Transpose −1 octave', action: () => { e.selectAll(); e.transpose(-12); } },
      '-',
      { label: 'Double song length', icon: 'duplicate', action: () => this.actions.doubleLength() },
      { label: 'Clear this track', icon: 'broom', danger: true, action: () => t && this.store.update(() => (t.notes = [])) },
    ]);
  }

  private partMenu(anchor: HTMLElement): void {
    const t = this.store.track;
    if (!t) return;
    showMenu(
      anchor,
      GENRES.map((g) => ({
        label: `${g.label} style`,
        action: () => {
          this.actions.lastGenre = g.id;
          const notes = regeneratePart(this.store.song, t, g.id);
          this.store.update(() => (t.notes = notes));
          this.editor.selection.clear();
        },
      })),
    );
  }
}
