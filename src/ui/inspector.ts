import type { AudioEngine } from '../audio/engine';
import { GENRES } from '../beats/generator';
import type { Store } from '../core/store';
import { NOTE_NAMES, SCALES } from '../core/theory';
import { BAR } from '../core/types';
import { formatSupport } from '../visual/exporter';
import { FONTS, PALETTES, PRESETS, presetSettings, type VisualSettings } from '../visual/settings';
import type { Actions } from './actions';
import { colorField, numberField, rangeField, segField, selectField, textField, toggleField, type Bound } from './controls';
import { h, icon } from './dom';

type V = VisualSettings;
type Key = keyof V;

type Ctl =
  | { type: 'range'; k: Key; label: string; min: number; max: number; step: number; fmt?: (v: number) => string; when?: (v: V) => boolean; help?: string }
  | { type: 'select'; k: Key; label: string; options: [string, string][] | (() => [string, string][]); when?: (v: V) => boolean; help?: string }
  | { type: 'seg'; k: Key; label: string; options: [string, string][]; when?: (v: V) => boolean; help?: string }
  | { type: 'toggle'; k: Key; label: string; when?: (v: V) => boolean; help?: string }
  | { type: 'color'; k: Key; label: string; when?: (v: V) => boolean; help?: string }
  | { type: 'text'; k: Key; label: string; when?: (v: V) => boolean; help?: string; placeholder?: string }
  | { type: 'custom'; render: () => Bound; when?: (v: V) => boolean };

interface SectionDef {
  title: string;
  toggle?: Key;
  open?: boolean;
  controls: Ctl[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(1)}s`;
const deg = (v: number) => `${Math.round(v)}°`;
const x = (v: number) => `${v.toFixed(2)}×`;

const ANCHORS: [string, string][] = [
  ['tl', 'Top left'],
  ['tc', 'Top center'],
  ['tr', 'Top right'],
  ['center', 'Center'],
  ['bl', 'Bottom left'],
  ['bc', 'Bottom center'],
  ['br', 'Bottom right'],
];

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: Record<string, HTMLButtonElement> = {};
  private bounds: { b: Bound; when?: (v: V) => boolean }[] = [];
  private refreshers: (() => void)[] = [];
  private closed = new Set<string>(['Background', 'Particles', 'Camera', 'Post FX', 'Chord display', 'Audio spectrum & progress', 'Transition', 'Backing audio (sync any song)', 'Files']);

  constructor(
    private store: Store,
    private engine: AudioEngine,
    private actions: Actions,
  ) {
    this.body = h('div', { class: 'inspector-body' });
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    for (const [id, label, ic] of [
      ['beat', 'Beat', 'music'],
      ['visual', 'Visual', 'sparkle'],
      ['export', 'Export', 'film'],
    ] as const) {
      const b = h('button', { class: 'tab', role: 'tab', onclick: () => this.store.setUI({ inspectorTab: id }) }, icon(ic, 16), label) as HTMLButtonElement;
      this.tabs[id] = b;
      tabBar.append(b);
    }
    this.el = h('aside', { class: 'inspector', 'aria-label': 'Inspector' }, tabBar, this.body);
    let tab = '';
    store.on('ui', () => {
      if (store.ui.inspectorTab !== tab) {
        tab = store.ui.inspectorTab;
        this.render();
      }
    });
    store.on('visual', () => this.refresh());
    store.on('song', () => this.refresh());
    tab = store.ui.inspectorTab;
    this.render();
  }

  private refresh(): void {
    const v = this.store.visual;
    for (const { b, when } of this.bounds) {
      b.refresh();
      if (when) b.el.hidden = !when(v);
    }
    for (const r of this.refreshers) r();
  }

  private render(): void {
    const tab = this.store.ui.inspectorTab;
    for (const [id, b] of Object.entries(this.tabs)) {
      b.classList.toggle('on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    this.bounds = [];
    this.refreshers = [];
    this.body.replaceChildren();
    if (tab === 'beat') this.renderBeat();
    else if (tab === 'visual') this.renderVisual();
    else this.renderExport();
    this.refresh();
    this.body.scrollTop = 0;
  }

  private section(title: string, content: HTMLElement[], toggle?: Bound): HTMLElement {
    const secEl = h('section', { class: 'section' + (this.closed.has(title) ? ' closed' : '') });
    const head = h('button', { class: 'section-head', 'aria-expanded': String(!this.closed.has(title)) }, h('span', null, title));
    if (toggle) {
      const sw = toggle.el.querySelector('.switch')!;
      sw.addEventListener('click', (e) => e.stopPropagation());
      head.append(sw);
    }
    head.append(h('span', { class: 'chev' }, icon('chevron', 16)));
    head.addEventListener('click', () => {
      const closed = secEl.classList.toggle('closed');
      head.setAttribute('aria-expanded', String(!closed));
      if (closed) this.closed.add(title);
      else this.closed.delete(title);
    });
    secEl.append(head, h('div', { class: 'section-body' }, content));
    return secEl;
  }

  private bind(b: Bound, when?: (v: V) => boolean): HTMLElement {
    this.bounds.push({ b, when });
    return b.el;
  }

  // -------------------------------------------------------------------------------------------
  // Beat tab

  private renderBeat(): void {
    const s = this.store;
    const a = this.actions;

    // Generator
    let genre = a.lastGenre;
    let bars = 8;
    let key: number | null = null;
    let scale: string | null = null;
    let keepTempo = false;
    const genreBtns = GENRES.map((g) =>
      h(
        'button',
        {
          class: 'genre',
          onclick: () => {
            genre = g.id;
            paintGenres();
          },
        },
        g.label,
      ),
    );
    const paintGenres = () => genreBtns.forEach((b, i) => b.classList.toggle('on', GENRES[i].id === genre));
    paintGenres();
    const barsSeg = segField('Length', {
      options: [
        ['4', '4 bars'],
        ['8', '8 bars'],
        ['16', '16 bars'],
      ],
      get: () => String(bars),
      set: (v) => {
        bars = Number(v);
        barsSeg.refresh();
      },
    });
    const keySel = selectField('Key', {
      options: [['', 'Random'], ...NOTE_NAMES.map((n, i) => [String(i), n] as [string, string])],
      get: () => (key === null ? '' : String(key)),
      set: (v) => (key = v === '' ? null : Number(v)),
    });
    const scaleSel = selectField('Scale', {
      options: [['', 'Genre default'], ...Object.entries(SCALES).filter(([, sc]) => sc.steps.length === 7).map(([id, sc]) => [id, sc.label] as [string, string])],
      get: () => scale ?? '',
      set: (v) => (scale = v || null),
    });
    const tempoTog = toggleField('Keep current tempo', { get: () => keepTempo, set: (v) => (keepTempo = v) });
    const genBtn = h(
      'button',
      {
        class: 'btn btn-hot btn-lg btn-block',
        onclick: () => a.generate({ genre, bars, key, scale, bpm: keepTempo ? s.song.bpm : null }),
      },
      icon('sparkle', 17),
      'Generate beat',
    );
    const blankBtn = h('button', { class: 'btn btn-block', onclick: () => a.newBlank() }, icon('plus', 16), 'Blank beat');
    const midiBtn = h('button', { class: 'btn btn-block', onclick: () => a.pickAndOpen('.mid,.midi,audio/midi') }, icon('upload', 16), 'Import MIDI');
    this.body.append(
      this.section('Make a beat from scratch', [
        h('p', { class: 'section-note' }, 'Pick a style and generate drums, bass, chords and melody — then edit every note below. Or start blank and program your own.'),
        h('div', { class: 'genre-grid' }, genreBtns),
        barsSeg.el,
        keySel.el,
        scaleSel.el,
        tempoTog.el,
        genBtn,
        h('div', { class: 'btn-row' }, blankBtn, midiBtn),
      ]),
    );

    // Song settings
    const songCtl: HTMLElement[] = [
      this.bind(
        textField('Title', {
          get: () => s.song.name,
          set: (v) => {
            const old = s.song.name;
            s.song.name = v;
            s.touch();
            if (s.visual.titleText === old) s.setVisual({ titleText: v });
          },
        }),
      ),
      this.bind(
        textField('Artist', {
          placeholder: 'Your name',
          get: () => s.song.artist,
          set: (v) => {
            const oldSub = s.song.artist ? `prod. by ${s.song.artist}` : 'prod. by you';
            s.song.artist = v;
            s.touch();
            if (s.visual.subtitleText === oldSub || !s.visual.subtitleText) s.setVisual({ subtitleText: v ? `prod. by ${v}` : '' });
          },
        }),
      ),
      this.bind(numberField('Tempo (BPM)', { min: 40, max: 240, step: 1, get: () => Math.round(s.song.bpm * 100) / 100, set: (v) => this.setBpm(v) })),
      this.bind(
        rangeField('Swing', {
          min: 0,
          max: 1,
          step: 0.01,
          format: pct,
          get: () => s.song.swing,
          set: (v) => {
            s.song.swing = v;
            s.touch();
          },
          onStart: () => s.beginGesture(),
          onEnd: () => s.endGesture(),
          help: 'Delays every second 16th note for a shuffled groove',
        }),
      ),
      this.bind(selectField('Key', { options: NOTE_NAMES.map((n, i) => [String(i), n]), get: () => String(s.song.key), set: (v) => s.update((so) => (so.key = Number(v))) })),
      this.bind(selectField('Scale', { options: Object.entries(SCALES).map(([id, sc]) => [id, sc.label]), get: () => s.song.scale, set: (v) => s.update((so) => (so.scale = v)) })),
      this.bind(numberField('Length (bars)', { min: 1, max: 256, step: 1, get: () => s.song.bars, set: (v) => s.update((so) => (so.bars = Math.round(v))) })),
      h('button', { class: 'btn btn-block', onclick: () => a.doubleLength() }, icon('duplicate', 16), 'Double length (repeat everything)'),
      this.bind(
        toggleField('Loop playback', {
          get: () => s.song.loop.enabled,
          set: (v) =>
            s.update((so) => {
              so.loop.enabled = v;
              if (so.loop.end <= so.loop.start) so.loop = { enabled: v, start: 0, end: Math.min(4, so.bars) * BAR };
            }),
          help: 'Shift-drag on the editor ruler to set the loop range',
        }),
      ),
      this.bind(
        numberField('Loop start bar', {
          min: 1,
          max: 256,
          step: 1,
          get: () => Math.floor(s.song.loop.start / BAR) + 1,
          set: (v) => s.update((so) => (so.loop.start = Math.min((v - 1) * BAR, so.loop.end - BAR))),
        }),
      ),
      this.bind(
        numberField('Loop end bar', {
          min: 1,
          max: 257,
          step: 1,
          get: () => Math.ceil(s.song.loop.end / BAR) + 1,
          set: (v) => s.update((so) => (so.loop.end = Math.max((v - 1) * BAR, so.loop.start + BAR))),
        }),
      ),
    ];
    this.body.append(this.section('Song', songCtl));

    // Backing audio
    const nameEl = h('div', { class: 'kv' }, h('span', null, 'Audio'), h('b', null, '—'));
    const removeBtn = h('button', { class: 'btn', onclick: () => { this.engine.clearBacking(); this.refresh(); } }, icon('trash', 15), 'Remove');
    const loadBtn = h('button', { class: 'btn', onclick: () => a.pickAndOpen('audio/*,.mp3,.wav,.m4a,.ogg,.flac') }, icon('upload', 15), 'Load audio');
    this.refreshers.push(() => {
      (nameEl.lastChild as HTMLElement).textContent = this.engine.backingName || 'none';
      removeBtn.toggleAttribute('disabled', !this.engine.backingBuffer);
    });
    this.body.append(
      this.section('Backing audio (sync any song)', [
        h('p', { class: 'section-note' }, 'Remake a beat by ear: load the original track, detect its tempo, then program drums and notes along with it (its waveform shows behind the editor). Or import a song’s MIDI plus its audio to visualize the real recording.'),
        nameEl,
        h('div', { class: 'btn-row' }, loadBtn, removeBtn),
        h('button', { class: 'btn btn-block', onclick: () => a.detectBackingTempo() }, icon('metronome', 15), 'Detect tempo & align grid'),
        h(
          'div',
          { class: 'nudge-row' },
          h('span', { class: 'field-label' }, 'Shift grid'),
          ...([
            [-1, '−1 beat'],
            [-0.5, '−½'],
            [0.5, '+½'],
            [1, '+1 beat'],
          ] as const).map(([b, l]) => h('button', { class: 'btn', title: `Move the audio ${b > 0 ? 'later' : 'earlier'} by ${Math.abs(b)} beat`, onclick: () => a.shiftBacking(b) }, l)),
        ),
        this.bind(
          rangeField('Audio volume', {
            min: 0,
            max: 1.5,
            step: 0.01,
            format: pct,
            get: () => this.engine.backingVolume,
            set: (v) => (this.engine.backingVolume = v),
          }),
        ),
        h('p', { class: 'section-note' }, 'Exports contain exactly what you hear — turn the audio volume to 0 to leave the reference out of your remake.'),
        this.bind(
          rangeField('Audio offset', {
            min: -8,
            max: 8,
            step: 0.005,
            format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}s`,
            get: () => s.song.audioOffset,
            set: (v) => {
              s.song.audioOffset = v;
              s.touch();
            },
            onStart: () => s.beginGesture(),
            onEnd: () => s.endGesture(),
            help: 'Shift the audio later (+) or earlier (−) to line it up with the MIDI',
          }),
        ),
        this.bind(
          toggleField('Play my tracks too', {
            get: () => s.song.synthsWithAudio,
            set: (v) => {
              s.update((so) => (so.synthsWithAudio = v));
              this.engine.applySynthMute();
            },
          }),
        ),
      ]),
    );

    this.body.append(
      this.section('Files', [
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => a.pickAndOpen('.json,application/json') }, icon('file', 15), 'Open project'),
          h('button', { class: 'btn', onclick: () => a.saveProject() }, icon('download', 15), 'Save project'),
          h('button', { class: 'btn', onclick: () => a.pickAndOpen('.mid,.midi,audio/midi') }, icon('upload', 15), 'Import MIDI'),
          h('button', { class: 'btn', onclick: () => a.exportMidi() }, icon('download', 15), 'Export MIDI'),
        ),
        h('p', { class: 'section-note' }, 'Tip: you can also drag & drop .mid, audio, image or project files anywhere.'),
      ]),
    );
  }

  private setBpm(v: number): void {
    const s = this.store;
    s.update((so) => {
      const ratio = v / so.bpm;
      so.bpm = v;
      so.tempoChanges = so.tempoChanges.map((c) => ({ ...c, bpm: c.bpm * ratio }));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Visual tab

  private renderVisual(): void {
    const s = this.store;
    // Presets
    const presetBtns = PRESETS.map((p) => {
      const cfg = presetSettings(p.id, s.visual);
      const cols = PALETTES[cfg.palette].colors;
      const bg = cfg.bgMode === 'solid' ? cfg.bgColor : `linear-gradient(${cfg.bgAngle}deg, ${cfg.bgColor}, ${cfg.bgColor2})`;
      const bars = [0, 1, 2, 3].map((i) =>
        h('i', { style: { background: cols[i], left: `${10 + i * 14}%`, top: `${18 + ((i * 37) % 30)}%`, width: `${24 + (i % 2) * 14}%` } }),
      );
      return h('button', { class: 'preset', style: { background: bg }, title: p.label, onclick: () => this.actions.applyPreset(p.id), 'data-id': p.id }, bars, h('span', null, p.label));
    });
    this.refreshers.push(() => presetBtns.forEach((b) => b.classList.toggle('on', b.dataset.id === s.visual.preset)));
    this.body.append(this.section('Look presets', [h('div', { class: 'preset-grid' }, presetBtns)]));

    const trackOpts = (auto: string) => (): [string, string][] => [['auto', auto], ...s.song.tracks.map((t) => [t.id, t.name] as [string, string])];

    const paletteCtl: Ctl = {
      type: 'custom',
      render: () => {
        const chips = Object.entries(PALETTES).map(([id, p]) =>
          h(
            'button',
            { class: 'chip', title: p.label, 'data-id': id, onclick: () => this.actions.applyPalette(id), style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '0 9px' } },
            h('span', { class: 'palette-row' }, p.colors.slice(0, 4).map((c) => h('b', { style: { background: c } }))),
            p.label,
          ),
        );
        const el = h('div', { class: 'field', style: { gridTemplateColumns: '1fr' } }, h('span', { class: 'field-label' }, 'Track colors'), h('div', { class: 'chips' }, chips));
        return { el, refresh: () => chips.forEach((c) => c.classList.toggle('on', c.dataset.id === s.visual.palette)) };
      },
    };

    const bgImageCtl: Ctl = {
      type: 'custom',
      when: (v) => v.bgMode === 'image',
      render: () => {
        const up = h('button', { class: 'btn', onclick: () => this.actions.pickAndOpen('image/*') }, icon('upload', 15), 'Choose image');
        const rm = h('button', { class: 'btn', onclick: () => { this.actions.player.bgImage = null; s.setVisual({ bgMode: 'gradient' }); } }, icon('trash', 15), 'Remove');
        return { el: h('div', { class: 'btn-row' }, up, rm), refresh: () => {} };
      },
    };

    const sections: SectionDef[] = [
      {
        title: 'Layout',
        open: true,
        controls: [
          { type: 'seg', k: 'aspect', label: 'Aspect', options: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']] },
          { type: 'seg', k: 'direction', label: 'Flow', options: [['rtl', 'Right → Left'], ['ttb', 'Top → Bottom']] },
          { type: 'range', k: 'window', label: 'Time on screen', min: 2, max: 16, step: 0.5, fmt: sec, help: 'How many seconds of music are visible at once' },
          { type: 'range', k: 'playheadPos', label: 'Hit line', min: 0.1, max: 0.9, step: 0.01, fmt: pct, help: 'Where notes are struck' },
          { type: 'toggle', k: 'showPlayhead', label: 'Show hit line' },
          { type: 'color', k: 'playheadColor', label: 'Hit line color', when: (v) => v.showPlayhead },
          { type: 'seg', k: 'pitchSpacing', label: 'Pitch spacing', options: [['compact', 'Compact'], ['true', 'True intervals']], help: 'Compact closes big empty gaps between parts so notes stay bold' },
          { type: 'seg', k: 'drumLayout', label: 'Drums', options: [['band', 'Own lane'], ['pitch', 'By pitch'], ['hidden', 'Hidden']] },
          { type: 'range', k: 'drumBandSize', label: 'Drum lane size', min: 0.08, max: 0.6, step: 0.01, fmt: pct, when: (v) => v.drumLayout === 'band' },
          { type: 'toggle', k: 'showGrid', label: 'Beat grid' },
          { type: 'range', k: 'gridOpacity', label: 'Grid strength', min: 0.01, max: 0.3, step: 0.01, fmt: pct, when: (v) => v.showGrid },
        ],
      },
      {
        title: 'Notes',
        open: true,
        controls: [
          paletteCtl,
          { type: 'select', k: 'noteStyle', label: 'Style', options: [['solid', 'Solid'], ['outline', 'Outline'], ['gradient', 'Gradient tail'], ['neon', 'Neon'], ['line', 'Thin line']] },
          { type: 'range', k: 'noteThickness', label: 'Thickness', min: 0.1, max: 2, step: 0.01, fmt: pct },
          { type: 'range', k: 'roundness', label: 'Roundness', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'futureOpacity', label: 'Upcoming', min: 0.05, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'pastOpacity', label: 'Played', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'activeGlow', label: 'Hit glow', min: 0, max: 1.5, step: 0.01, fmt: pct },
          { type: 'select', k: 'marker', label: 'Head marker', options: [['none', 'None'], ['circle', 'Circle'], ['diamond', 'Diamond'], ['star', 'Star'], ['heart', 'Heart'], ['square', 'Square'], ['emoji', 'Emoji']] },
          { type: 'text', k: 'markerEmoji', label: 'Emoji', when: (v) => v.marker === 'emoji', placeholder: '🔥' },
          { type: 'range', k: 'markerSize', label: 'Marker size', min: 0.3, max: 2.5, step: 0.05, fmt: x, when: (v) => v.marker !== 'none' },
          { type: 'select', k: 'hitEffect', label: 'Hit effect', options: [['ripple', 'Ripple'], ['spark', 'Spark burst'], ['flare', 'Lens flare'], ['pluck', 'Pluck (string)'], ['pulse', 'Pulse'], ['none', 'None']] },
          { type: 'range', k: 'hitStrength', label: 'Effect strength', min: 0.2, max: 2.5, step: 0.05, fmt: x, when: (v) => v.hitEffect !== 'none' },
          { type: 'toggle', k: 'linkNotes', label: 'Connect melody notes' },
        ],
      },
      {
        title: 'Background',
        controls: [
          { type: 'seg', k: 'bgMode', label: 'Type', options: [['solid', 'Solid'], ['gradient', 'Gradient'], ['image', 'Image']] },
          { type: 'color', k: 'bgColor', label: 'Color' },
          { type: 'color', k: 'bgColor2', label: 'Color 2', when: (v) => v.bgMode === 'gradient' },
          { type: 'range', k: 'bgAngle', label: 'Angle', min: 0, max: 360, step: 1, fmt: deg, when: (v) => v.bgMode === 'gradient' },
          bgImageCtl,
          { type: 'range', k: 'bgImageOpacity', label: 'Image opacity', min: 0, max: 1, step: 0.01, fmt: pct, when: (v) => v.bgMode === 'image' },
        ],
      },
      {
        title: 'Particles',
        toggle: 'particles',
        controls: [
          { type: 'select', k: 'particleStyle', label: 'Style', options: [['sparkles', 'Sparkles'], ['dust', 'Dust / bokeh'], ['comets', 'Comets'], ['snow', 'Snow'], ['twinkle', 'Twinkle'], ['bubbles', 'Bubbles']] },
          { type: 'range', k: 'particleCount', label: 'Amount', min: 5, max: 250, step: 1 },
          { type: 'range', k: 'particleSize', label: 'Size', min: 0.2, max: 4, step: 0.05, fmt: x },
          { type: 'range', k: 'particleSpeed', label: 'Speed', min: 0, max: 4, step: 0.05, fmt: x },
          { type: 'range', k: 'particleDirection', label: 'Direction', min: 0, max: 360, step: 1, fmt: deg },
          { type: 'color', k: 'particleColor', label: 'Color' },
          { type: 'range', k: 'particleOpacity', label: 'Opacity', min: 0.05, max: 1, step: 0.01, fmt: pct },
          { type: 'toggle', k: 'particleReact', label: 'React to the bass' },
        ],
      },
      {
        title: 'Camera',
        toggle: 'camera',
        controls: [
          { type: 'select', k: 'cameraSource', label: 'Driven by', options: trackOpts('Auto (drums)') },
          { type: 'seg', k: 'cameraTrigger', label: 'Drum hit', options: [['kick', 'Kick'], ['snare', 'Snare'], ['all', 'All']] },
          { type: 'range', k: 'zoomPunch', label: 'Zoom punch', min: 0, max: 1.5, step: 0.01, fmt: pct },
          { type: 'range', k: 'shake', label: 'Shake', min: 0, max: 1.5, step: 0.01, fmt: pct },
        ],
      },
      {
        title: 'Post FX',
        controls: [
          { type: 'toggle', k: 'bloom', label: 'Bloom glow' },
          { type: 'range', k: 'bloomStrength', label: 'Bloom amount', min: 0, max: 2.5, step: 0.01, fmt: pct, when: (v) => v.bloom },
          { type: 'range', k: 'bloomRadius', label: 'Bloom spread', min: 0, max: 1.5, step: 0.01, fmt: pct, when: (v) => v.bloom },
          { type: 'range', k: 'bloomThreshold', label: 'Bloom threshold', min: 0, max: 0.95, step: 0.01, fmt: pct, when: (v) => v.bloom },
          { type: 'seg', k: 'distortion', label: 'Lens', options: [['none', 'None'], ['fisheye', 'Fisheye'], ['pincushion', 'Pincushion']] },
          { type: 'range', k: 'distortionAmount', label: 'Lens amount', min: 0, max: 1, step: 0.01, fmt: pct, when: (v) => v.distortion !== 'none' },
          { type: 'range', k: 'chroma', label: 'Chromatic', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'range', k: 'scanlines', label: 'Scanlines', min: 0, max: 1, step: 0.01, fmt: pct },
          { type: 'toggle', k: 'grade', label: 'Color grade' },
          { type: 'range', k: 'brightness', label: 'Brightness', min: 0.5, max: 1.6, step: 0.01, fmt: x, when: (v) => v.grade },
          { type: 'range', k: 'contrast', label: 'Contrast', min: 0.5, max: 1.6, step: 0.01, fmt: x, when: (v) => v.grade },
          { type: 'range', k: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, fmt: x, when: (v) => v.grade },
          { type: 'range', k: 'hue', label: 'Hue shift', min: -0.5, max: 0.5, step: 0.01, fmt: (v) => `${Math.round(v * 360)}°`, when: (v) => v.grade },
        ],
      },
      {
        title: 'Title',
        toggle: 'title',
        controls: [
          { type: 'text', k: 'titleText', label: 'Title' },
          { type: 'text', k: 'subtitleText', label: 'Subtitle' },
          { type: 'select', k: 'titleFont', label: 'Font', options: FONTS.map((f) => [f, f]) },
          { type: 'range', k: 'titleSize', label: 'Size', min: 0.4, max: 2.5, step: 0.05, fmt: x },
          { type: 'color', k: 'titleColor', label: 'Color' },
          { type: 'select', k: 'titlePos', label: 'Position', options: ANCHORS },
          { type: 'select', k: 'titleAnim', label: 'Entrance', options: [['slide', 'Slide up'], ['fade', 'Fade in'], ['type', 'Typewriter'], ['none', 'None']] },
          { type: 'range', k: 'titleHold', label: 'Hide after', min: 0, max: 30, step: 0.5, fmt: (v) => (v === 0 ? 'Never' : sec(v)) },
        ],
      },
      {
        title: 'Chord display',
        toggle: 'chord',
        controls: [
          { type: 'select', k: 'chordSource', label: 'Detect from', options: trackOpts('Auto (chord tracks)') },
          { type: 'select', k: 'chordFont', label: 'Font', options: FONTS.map((f) => [f, f]) },
          { type: 'range', k: 'chordSize', label: 'Size', min: 0.4, max: 2.5, step: 0.05, fmt: x },
          { type: 'color', k: 'chordColor', label: 'Color' },
          { type: 'select', k: 'chordPos', label: 'Position', options: ANCHORS },
        ],
      },
      {
        title: 'Audio spectrum & progress',
        controls: [
          { type: 'seg', k: 'spectrum', label: 'Spectrum', options: [['off', 'Off'], ['bars', 'Bars'], ['wave', 'Wave'], ['circle', 'Ring']] },
          { type: 'color', k: 'spectrumColor', label: 'Color', when: (v) => v.spectrum !== 'off' },
          { type: 'range', k: 'spectrumSize', label: 'Size', min: 0.3, max: 2.5, step: 0.05, fmt: x, when: (v) => v.spectrum !== 'off' },
          { type: 'toggle', k: 'progress', label: 'Progress bar' },
        ],
      },
      {
        title: 'Transition',
        toggle: 'transition',
        controls: [
          { type: 'select', k: 'transitionStyle', label: 'Style', options: [['iris', 'Iris / portal'], ['fade', 'Fade'], ['wipe', 'Wipe'], ['zoom', 'Zoom + fade']] },
          { type: 'range', k: 'transitionDur', label: 'Duration', min: 0.2, max: 4, step: 0.1, fmt: sec },
        ],
      },
    ];

    for (const sd of sections) {
      const els = sd.controls.map((c) => this.control(c));
      const tog = sd.toggle ? toggleField(sd.title, { get: () => !!s.visual[sd.toggle!], set: (v) => s.setVisual({ [sd.toggle!]: v } as Partial<V>) }) : undefined;
      if (tog) this.bounds.push({ b: tog });
      this.body.append(this.section(sd.title, els, tog));
    }
  }

  private control(c: Ctl): HTMLElement {
    const s = this.store;
    const set = (k: Key, v: unknown) => s.setVisual({ [k]: typeof s.visual[k] === 'number' && typeof v === 'string' ? Number(v) : v } as Partial<V>);
    let b: Bound;
    switch (c.type) {
      case 'range':
        b = rangeField(c.label, { min: c.min, max: c.max, step: c.step, format: c.fmt, help: c.help, get: () => s.visual[c.k] as number, set: (v) => set(c.k, v) });
        break;
      case 'select':
        b = selectField(c.label, { options: c.options, help: c.help, get: () => String(s.visual[c.k]), set: (v) => set(c.k, v) });
        break;
      case 'seg':
        b = segField(c.label, { options: c.options, help: c.help, get: () => String(s.visual[c.k]), set: (v) => set(c.k, v) });
        break;
      case 'toggle':
        b = toggleField(c.label, { help: c.help, get: () => !!s.visual[c.k], set: (v) => set(c.k, v) });
        break;
      case 'color':
        b = colorField(c.label, { help: c.help, get: () => String(s.visual[c.k]), set: (v) => set(c.k, v) });
        break;
      case 'text':
        b = textField(c.label, { help: c.help, placeholder: c.placeholder, get: () => String(s.visual[c.k]), set: (v) => set(c.k, v) });
        break;
      case 'custom':
        b = c.render();
        break;
    }
    return this.bind(b, c.when);
  }

  // -------------------------------------------------------------------------------------------
  // Export tab

  private renderExport(): void {
    const s = this.store;
    const a = this.actions;
    const sup = formatSupport();
    const fmtNote = h('p', { class: 'section-note' });
    this.refreshers.push(() => {
      const want = s.visual.exportFormat;
      fmtNote.textContent = !sup.mp4 && !sup.webm
        ? 'Video recording is not supported in this browser.'
        : want === 'mp4' && !sup.mp4
          ? 'MP4 recording is not supported here — WebM will be used instead.'
          : want === 'webm' && !sup.webm
            ? 'WebM recording is not supported here — MP4 will be used instead.'
            : `The video records in real time (${(this.engine.songEndSec() + s.visual.exportLead + s.visual.exportTail).toFixed(0)}s for the whole song).`;
    });
    const ctl = (c: Ctl) => this.control(c);
    this.body.append(
      this.section('Video', [
        ctl({ type: 'seg', k: 'exportFormat', label: 'Format', options: [['mp4', 'MP4'], ['webm', 'WebM']] }),
        ctl({ type: 'seg', k: 'aspect', label: 'Aspect', options: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']] }),
        ctl({ type: 'seg', k: 'exportRes', label: 'Resolution', options: [['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K']] }),
        ctl({ type: 'seg', k: 'exportFps', label: 'Frame rate', options: [['30', '30 fps'], ['60', '60 fps']] }),
        ctl({ type: 'seg', k: 'exportQuality', label: 'Quality', options: [['low', 'Small'], ['medium', 'Medium'], ['high', 'High']] }),
        ctl({ type: 'seg', k: 'exportRange', label: 'Range', options: [['song', 'Whole song'], ['loop', 'Loop range']] }),
        ctl({ type: 'range', k: 'exportLead', label: 'Lead-in', min: 0, max: 5, step: 0.1, fmt: sec, help: 'Silence before the first beat' }),
        ctl({ type: 'range', k: 'exportTail', label: 'Tail', min: 0, max: 8, step: 0.1, fmt: sec, help: 'Time after the last bar for reverb and the outro' }),
        fmtNote,
        h('button', { class: 'btn btn-primary btn-lg btn-block', onclick: () => a.exportVideo() }, icon('film', 17), 'Export video'),
      ]),
    );
    this.body.append(
      this.section('Audio & data', [
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => a.exportWav() }, icon('wave', 15), 'Export WAV'),
          h('button', { class: 'btn', onclick: () => a.exportMidi() }, icon('music', 15), 'Export MIDI'),
          h('button', { class: 'btn', onclick: () => a.saveProject() }, icon('download', 15), 'Save project'),
          h('button', { class: 'btn', onclick: () => a.pickAndOpen('.json,application/json') }, icon('file', 15), 'Open project'),
        ),
      ]),
    );
  }
}
