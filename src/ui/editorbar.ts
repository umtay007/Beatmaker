import { KITS } from '../audio/drums';
import type { AudioEngine } from '../audio/engine';
import { GENRES, regeneratePart } from '../beats/generator';
import type { Store } from '../core/store';
import { deleteBars, duplicateBars, insertBars } from '../core/arrange';
import { BAR, DUCK_RELEASE, HPF_OFF, LPF_OFF, PPQ, STEP, type Track } from '../core/types';
import type { Actions } from './actions';
import { h, icon, showMenu, showPopover, type MenuItem } from './dom';
import type { Editor } from './editor';
import { replaceSamplerSound, showSamplerEditor } from './samplerui';
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

/** Kit menu entry that opens the pack loader instead of choosing a kit. */
const LOAD_PACK = '__pack__';

/** Whether any of the FX popover's settings differ from their defaults. */
function fxActive(t: Track): boolean {
  return (
    (t.echo ?? 0) > 0 ||
    (t.kind === 'synth' && (t.tune ?? 0) !== 0) ||
    (t.duck ?? 0) > 0 ||
    [t.eqLow, t.eqMid, t.eqHigh, t.res].some((v) => (v ?? 0) !== 0) ||
    (t.hpf ?? HPF_OFF) > HPF_OFF ||
    (t.lpf ?? LPF_OFF) < LPF_OFF
  );
}

export class EditorBar {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private inst: HTMLSelectElement;
  private grid: HTMLSelectElement;
  private len: HTMLSelectElement;
  private lenWrap: HTMLElement;
  private pan: HTMLInputElement;
  private rev: HTMLInputElement;
  private fx: HTMLButtonElement;
  private sample: HTMLButtonElement;
  private follow: HTMLButtonElement;
  private keys: HTMLButtonElement;
  private instKind = '';

  constructor(
    private store: Store,
    private engine: AudioEngine,
    private editor: Editor,
    private actions: Actions,
  ) {
    this.title = h('div', { class: 'editor-title' });
    this.inst = h('select', { class: 'select', 'aria-label': 'Instrument' }) as HTMLSelectElement;
    this.inst.addEventListener('change', () => {
      const t = store.track;
      if (!t) return;
      if (this.inst.value === LOAD_PACK) {
        this.inst.value = t.instrument;
        actions.loadDrumPack();
        return;
      }
      if (this.inst.value === 'sampler' && !t.sampler) {
        // A sampler needs a sound first.
        this.inst.value = t.instrument;
        const id = t.id;
        void replaceSamplerSound(store, engine, id).then((ok) => ok && showSamplerEditor(store, engine, id));
        return;
      }
      store.update(() => (t.instrument = this.inst.value));
      void engine.ensureKits();
      engine.preview(t, t.kind === 'drums' ? 36 : 60, 0.8, 0.4);
    });
    this.grid = h('select', { class: 'select', 'aria-label': 'Grid' }, GRIDS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    this.grid.addEventListener('change', () => store.setUI({ grid: Number(this.grid.value) }));
    this.len = h('select', { class: 'select', 'aria-label': 'New note length' }, LENGTHS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    this.len.addEventListener('change', () => store.setUI({ noteLength: Number(this.len.value) }));
    this.lenWrap = h('span', { style: { display: 'contents' } }, h('span', { class: 'lbl hide-md' }, 'Length'), this.len);

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
        r.value = '0'; // sync() skips the focused slider
        this.paintMini();
      });
      return r;
    };
    this.pan = mini('Pan (double-click to center)', -1, 1, 'pan');
    this.rev = mini('Reverb send', 0, 1, 'reverb');
    this.sample = h(
      'button',
      { class: 'btn btn-ghost', title: 'The sampler’s sound, chops, loop and trim', onclick: () => {
        const t = store.track;
        if (t) showSamplerEditor(store, engine, t.id);
      } },
      icon('wave', 15),
      'Sample',
    ) as HTMLButtonElement;
    this.fx = h(
      'button',
      { class: 'btn btn-ghost', title: 'Echo, sidechain ducking, EQ and filter for this track', onclick: (e: MouseEvent) => this.fxPopover(e.currentTarget as HTMLElement) },
      icon('sliders', 15),
      'FX',
    ) as HTMLButtonElement;

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
      this.sample,
      h('div', { class: 'divider' }),
      h('span', { class: 'lbl hide-md' }, 'Grid'),
      this.grid,
      this.lenWrap,
      h('div', { class: 'divider' }),
      h('span', { class: 'lbl hide-md' }, 'Pan'),
      this.pan,
      h('span', { class: 'lbl hide-md' }, 'Verb'),
      this.rev,
      this.fx,
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
    // Kits can be added at runtime (the user's packs), so key the list on them too.
    const optsKey = t.kind === 'drums' ? 'drums:' + KITS.map((k) => k.id).join(',') : t.kind;
    if (this.instKind !== optsKey) {
      this.instKind = optsKey;
      this.inst.replaceChildren();
      let group: HTMLOptGroupElement | null = null;
      for (const [v, l] of instrumentOptions(t.kind)) {
        if (v.startsWith('group:')) {
          group = h('optgroup', { label: l });
          this.inst.append(group);
        } else (group ?? this.inst).append(h('option', { value: v }, l));
      }
      if (t.kind === 'drums') this.inst.append(h('option', { value: LOAD_PACK }, '＋ Load a drum pack…'));
    }
    this.inst.value = t.instrument;
    this.sample.style.display = t.instrument === 'sampler' ? '' : 'none';
    this.grid.value = String(ui.grid);
    if (![...this.grid.options].some((o) => o.value === String(ui.grid))) this.grid.value = String(STEP);
    if (![...this.len.options].some((o) => o.value === String(ui.noteLength))) {
      [...this.len.options].filter((o) => o.dataset.custom).forEach((o) => o.remove());
      const steps = ui.noteLength / STEP;
      const label = Number.isInteger(steps) ? `${steps}/16` : `${ui.noteLength} ticks`;
      this.len.append(h('option', { value: ui.noteLength, 'data-custom': '1' }, label));
    }
    this.len.value = String(ui.noteLength);
    this.lenWrap.style.display = t.kind === 'drums' ? 'none' : 'contents';
    if (document.activeElement !== this.pan) this.pan.value = String(t.pan);
    if (document.activeElement !== this.rev) this.rev.value = String(t.reverb);
    this.fx.classList.toggle('on', fxActive(t));
    this.paintMini();
    this.follow.classList.toggle('on', ui.follow);
    this.keys.classList.toggle('on', ui.keys);
  }

  /** Undo/redo swaps in new track objects, so menus resolve their track by id when they act. */
  private trackById(id: string): Track | undefined {
    return this.store.song.tracks.find((x) => x.id === id);
  }

  /** Sends, sidechain ducking, tone and filter for the selected track. */
  private fxPopover(anchor: HTMLElement): void {
    const store = this.store;
    const first = store.track;
    if (!first) return;
    const id = first.id;
    const t = () => this.trackById(id) ?? first;
    interface RowSpec {
      min: number;
      max: number;
      step: number;
      get: () => number;
      set: (v: number) => void;
      fmt: (v: number) => string;
      reset: number;
      /** Log-scaled slider (frequencies): the input runs 0..1000. */
      log?: boolean;
    }
    const row = (label: string, o: RowSpec) => {
      const toX = (v: number) => (o.log ? Math.round((Math.log(v / o.min) / Math.log(o.max / o.min)) * 1000) : v);
      const fromX = (x: number) => (o.log ? Math.round(o.min * Math.pow(o.max / o.min, x / 1000)) : x);
      const [lo, hi, step] = o.log ? [0, 1000, 1] : [o.min, o.max, o.step];
      const out = h('output', null, o.fmt(o.get()));
      const r = h('input', { type: 'range', class: 'range', min: lo, max: hi, step, value: toX(o.get()), 'aria-label': label }) as HTMLInputElement;
      const paint = () => r.style.setProperty('--pct', `${((Number(r.value) - lo) / (hi - lo)) * 100}%`);
      const show = (v: number) => {
        out.textContent = o.fmt(v);
        paint();
        this.fx.classList.toggle('on', fxActive(t()));
      };
      paint();
      r.addEventListener('pointerdown', () => store.beginGesture());
      r.addEventListener('input', () => {
        const v = fromX(Number(r.value));
        o.set(v);
        store.touch();
        show(v);
      });
      r.addEventListener('change', () => store.endGesture());
      r.addEventListener('dblclick', () => {
        store.update(() => o.set(o.reset));
        r.value = String(toX(o.reset));
        show(o.reset);
      });
      return h('label', { class: 'pop-row' }, label, r, out);
    };
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const db = (v: number) => `${v > 0 ? '+' : ''}${v} dB`;
    const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${v}`) + ' Hz';
    const gain = (get: () => number | undefined, set: (v: number) => void): RowSpec => ({ min: -12, max: 12, step: 0.5, get: () => get() ?? 0, set, fmt: db, reset: 0 });
    showPopover(
      anchor,
      h(
        'div',
        null,
        h('div', { class: 'pop-title' }, `${first.name} · FX`),
        row('Echo send', { min: 0, max: 1, step: 0.01, get: () => t().echo ?? 0, set: (v) => (t().echo = v), fmt: pct, reset: 0 }),
        first.kind === 'synth'
          ? row('Fine tune', { min: -100, max: 100, step: 1, get: () => t().tune ?? 0, set: (v) => (t().tune = v), fmt: (v) => `${v > 0 ? '+' : ''}${v} ct`, reset: 0 })
          : null,
        h('div', { class: 'pop-sub' }, 'Sidechain · dips on every kick'),
        row('Duck', { min: 0, max: 24, step: 0.5, get: () => t().duck ?? 0, set: (v) => (t().duck = v), fmt: (v) => (v > 0 ? `−${v} dB` : 'off'), reset: 0 }),
        row('Release', { min: 0.05, max: 1, step: 0.01, get: () => t().duckRelease ?? DUCK_RELEASE, set: (v) => (t().duckRelease = v), fmt: (v) => `${Math.round(v * 1000)} ms`, reset: DUCK_RELEASE }),
        h('div', { class: 'pop-sub' }, 'EQ'),
        row('Low', gain(() => t().eqLow, (v) => (t().eqLow = v))),
        row('Mid', gain(() => t().eqMid, (v) => (t().eqMid = v))),
        row('Mid freq', { min: 150, max: 8000, step: 1, log: true, get: () => t().eqMidFreq ?? 1000, set: (v) => (t().eqMidFreq = v), fmt: hz, reset: 1000 }),
        row('High', gain(() => t().eqHigh, (v) => (t().eqHigh = v))),
        h('div', { class: 'pop-sub' }, 'Filter'),
        row('Low cut', { min: HPF_OFF, max: 2000, step: 1, log: true, get: () => t().hpf ?? HPF_OFF, set: (v) => (t().hpf = v), fmt: (v) => (v <= HPF_OFF ? 'off' : hz(v)), reset: HPF_OFF }),
        row('High cut', { min: 200, max: LPF_OFF, step: 1, log: true, get: () => t().lpf ?? LPF_OFF, set: (v) => (t().lpf = v), fmt: (v) => (v >= LPF_OFF ? 'off' : hz(v)), reset: LPF_OFF }),
        row('Resonance', { min: 0, max: 1, step: 0.01, get: () => t().res ?? 0, set: (v) => (t().res = v), fmt: pct, reset: 0 }),
        h('p', { class: 'pop-note' }, 'The echo time (1/8 dotted, 1/4 triplet…) is set in Song settings. Double-click a slider to reset it.'),
      ),
    );
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
      ...this.arrangeItems(),
      { label: 'Clear this track', icon: 'broom', danger: true, action: () => {
        const cur = t && this.trackById(t.id);
        if (cur) this.store.update(() => (cur.notes = []));
      } },
    ]);
  }

  /** Whole-song bar edits on the loop range or at the playhead (the ruler's right-click has more). */
  private arrangeItems(): MenuItem[] {
    const store = this.store;
    const song = store.song;
    const loop = song.loop.enabled && song.loop.end > song.loop.start ? song.loop : null;
    const bar = Math.min(song.bars - 1, Math.floor(this.engine.positionTicks() / BAR)) * BAR;
    const items: MenuItem[] = [{ label: 'Insert 4 bars at the playhead', icon: 'plus', hint: 'all tracks', action: () => store.update((s) => insertBars(s, bar, 4)) }];
    if (loop) {
      const a = Math.floor(loop.start / BAR) * BAR;
      const b = Math.ceil(loop.end / BAR) * BAR;
      items.push(
        { label: 'Duplicate the loop’s bars', icon: 'duplicate', hint: 'all tracks', action: () => store.update((s) => duplicateBars(s, a, b)) },
        { label: 'Delete the loop’s bars', icon: 'trash', hint: 'all tracks', danger: true, action: () => store.update((s) => deleteBars(s, a, b)) },
      );
    }
    return items;
  }

  private partMenu(anchor: HTMLElement): void {
    const t = this.store.track;
    if (!t) return;
    showMenu(
      anchor,
      GENRES.map((g) => ({
        label: `${g.label} style`,
        action: () => {
          const cur = this.trackById(t.id);
          if (!cur) return;
          this.actions.lastGenre = g.id;
          const notes = regeneratePart(this.store.song, cur, g.id);
          this.store.update(() => (cur.notes = notes));
          this.editor.selection.clear();
        },
      })),
    );
  }
}
