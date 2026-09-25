import type { AudioEngine } from '../audio/engine';
import { GENRES } from '../beats/generator';
import type { Store } from '../core/store';
import { formatTime } from '../core/timing';
import { BAR, PPQ, STEP } from '../core/types';
import { AbPanel } from './abpanel';
import type { Actions } from './actions';
import { h, icon, modal, showMenu, type MenuItem } from './dom';

export class TopBar {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private loopBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private metroBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private timeEl: HTMLElement;
  private bbtEl: HTMLElement;
  private bpm: HTMLInputElement;
  private abBtn: HTMLButtonElement;
  readonly ab: AbPanel;
  private lastClock = '';

  constructor(
    private store: Store,
    private engine: AudioEngine,
    private actions: Actions,
  ) {
    const btn = (ic: string, label: string, onclick: () => void, cls = 'icon-btn') =>
      h('button', { class: cls, 'aria-label': label, title: label, onclick }, icon(ic, cls.includes('play') ? 18 : 18)) as HTMLButtonElement;

    this.playBtn = btn('play', 'Play / pause (Space)', () => engine.toggle(), 'icon-btn play');
    const stopBtn = btn('stop', 'Stop (Enter)', () => engine.stop());
    this.loopBtn = btn('loop', 'Loop (L)', () => this.toggleLoop());
    this.recBtn = btn('record', 'Record from keyboard (R) — turn on the keyboard in the editor', () => store.setUI({ record: !store.ui.record }), 'icon-btn rec');
    this.metroBtn = btn('metronome', 'Metronome (M)', () => store.setUI({ metronome: !store.ui.metronome }));
    this.timeEl = h('span', null, '0:00.0');
    this.bbtEl = h('span', { class: 'bbt' }, '1.1.1');
    const clock = h('div', { class: 'clock', 'aria-live': 'off' }, this.bbtEl, this.timeEl);
    this.bpm = h('input', { type: 'number', min: 40, max: 240, step: 1, 'aria-label': 'Tempo in BPM' }) as HTMLInputElement;
    this.bpm.addEventListener('change', () => {
      const v = Math.max(40, Math.min(240, Number(this.bpm.value) || 120));
      store.update((s) => {
        const ratio = v / s.bpm;
        s.bpm = v;
        s.tempoChanges = s.tempoChanges.map((c) => ({ ...c, bpm: c.bpm * ratio }));
      });
    });
    this.bpm.addEventListener('keydown', (e) => e.stopPropagation());
    const tempo = h('label', { class: 'tempo', title: 'Tempo' }, this.bpm, h('span', null, 'BPM'));
    this.ab = new AbPanel(engine);
    document.body.append(this.ab.el);
    this.abBtn = h('button', { class: 'btn ab-btn', hidden: true, title: 'Compare with the original (B switches sides)', onclick: () => this.ab.toggle() }, 'A/B') as HTMLButtonElement;

    this.undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => store.undo());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z)', () => store.redo());

    const gen = h(
      'button',
      { class: 'btn btn-hot', title: 'Generate a new beat', onclick: (e: MouseEvent) => this.generateMenu(e.currentTarget as HTMLElement) },
      icon('sparkle', 16),
      h('span', { class: 'hide-sm' }, 'Generate'),
    );
    const fileBtn = h('button', { class: 'btn', onclick: (e: MouseEvent) => this.fileMenu(e.currentTarget as HTMLElement) }, icon('file', 16), h('span', { class: 'hide-sm' }, 'File'), icon('chevron', 14));
    const exp = h('button', { class: 'btn btn-primary', onclick: () => actions.exportVideo(), title: 'Export the music video' }, icon('film', 16), h('span', { class: 'hide-sm' }, 'Export video'));
    const help = btn('keyboard', 'Shortcuts & help (?)', () => showHelp());

    this.el = h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'brand-logo' }, icon('wave', 17)),
        h('div', null, 'BEATMAKER', h('small', null, 'Beats → music video')),
      ),
      h('div', { class: 'transport' }, stopBtn, this.playBtn, this.loopBtn, this.recBtn, this.metroBtn, clock, tempo, this.abBtn),
      h('div', { class: 'spacer' }),
      h('div', { class: 'actions' }, this.undoBtn, this.redoBtn, h('span', { class: 'hide-md', style: { width: '6px' } }), gen, fileBtn, exp, help),
    );

    store.on('ui', () => this.sync());
    store.on('song', () => this.sync());
    store.on('history', () => this.sync());
    engine.onState = () => this.sync();
    this.sync();
  }

  private toggleLoop(): void {
    this.store.update((s) => {
      s.loop.enabled = !s.loop.enabled;
      if (s.loop.end <= s.loop.start) s.loop = { enabled: true, start: 0, end: Math.min(4, s.bars) * BAR };
    });
  }

  sync(): void {
    const s = this.store;
    this.playBtn.classList.toggle('on', this.engine.playing);
    this.playBtn.replaceChildren(icon(this.engine.playing ? 'pause' : 'play', 18));
    this.loopBtn.classList.toggle('on', s.song.loop.enabled);
    this.recBtn.classList.toggle('on', s.ui.record);
    this.metroBtn.classList.toggle('on', s.ui.metronome);
    this.undoBtn.disabled = !s.canUndo;
    this.redoBtn.disabled = !s.canRedo;
    if (document.activeElement !== this.bpm) this.bpm.value = String(Math.round(s.song.bpm * 100) / 100);
    const ab = this.engine.ab;
    this.abBtn.classList.toggle('on', ab !== 'off');
    this.abBtn.textContent = ab === 'original' ? 'A/B · Original' : ab === 'remake' ? 'A/B · Remake' : 'A/B';
    this.ab.sync();
  }


  frame(): void {
    const hasRef = !!this.engine.backingBuffer;
    if (this.abBtn.hidden === hasRef) {
      this.abBtn.hidden = !hasRef;
      if (!hasRef) this.ab.close();
    }
    this.engine.abFrame();
    this.ab.frame();
    const sec = this.engine.position();
    const tick = Math.max(0, this.engine.timeline.secToTick(sec));
    const bar = Math.floor(tick / BAR) + 1;
    const beat = Math.floor((tick % BAR) / PPQ) + 1;
    const six = Math.floor((tick % PPQ) / STEP) + 1;
    const txt = `${bar}.${beat}.${six}|${formatTime(sec)} / ${formatTime(this.engine.songEndSec())}`;
    if (txt === this.lastClock) return;
    this.lastClock = txt;
    this.bbtEl.textContent = `${bar}.${beat}.${six}`;
    this.timeEl.textContent = `${formatTime(sec)} / ${formatTime(this.engine.songEndSec())}`;
  }

  private generateMenu(anchor: HTMLElement): void {
    const items: (MenuItem | '-')[] = GENRES.map((g) => ({
      label: g.label,
      hint: `${g.bpm[0]}–${g.bpm[1]}`,
      action: () => this.actions.generate({ genre: g.id, bars: 8, key: null, scale: null, bpm: null }),
    }));
    items.push('-', { label: 'More options…', icon: 'sparkle', action: () => this.store.setUI({ inspectorTab: 'beat' }) });
    showMenu(anchor, items);
  }

  private fileMenu(anchor: HTMLElement): void {
    const a = this.actions;
    showMenu(anchor, [
      { label: 'New blank beat', icon: 'plus', action: () => a.newBlank() },
      { label: 'Open file…', icon: 'file', hint: 'MIDI · audio · project', action: () => a.pickAndOpen('') },
      { label: 'Save project', icon: 'download', action: () => a.saveProject() },
      '-',
      { label: 'Import MIDI…', icon: 'upload', action: () => a.pickAndOpen('.mid,.midi,audio/midi') },
      { label: 'Load reference audio…', icon: 'wave', action: () => a.pickAndOpen('') },
      { label: 'Load drum pack…', icon: 'drum', hint: 'any sample pack', action: () => a.loadDrumPack() },
      '-',
      { label: 'Export video', icon: 'film', action: () => a.exportVideo() },
      { label: 'Export WAV', icon: 'wave', action: () => a.exportWav() },
      { label: 'Export stems', icon: 'wave', hint: 'a WAV per track', action: () => a.exportStems() },
      { label: 'Export MIDI', icon: 'music', action: () => a.exportMidi() },
      { label: 'Export MIDI per track', icon: 'music', hint: 'a .mid per track', action: () => void a.exportMidiTracks() },
    ]);
  }
}

export function showHelp(): void {
  const row = (keys: string[], what: string) => [h('span', null, keys.map((k) => h('span', { class: 'kbd' }, k)).reduce<(HTMLElement | string)[]>((acc, el, i) => (i ? [...acc, ' ', el] : [el]), [])), h('span', null, what)];
  const body = h(
    'div',
    null,
    h('p', null, 'Build a beat in the editor, then style it in the Visual tab and export a music video.'),
    h(
      'div',
      { class: 'help-list' },
      ...row(['Space'], 'Play / pause'),
      ...row(['Enter'], 'Stop and return to start'),
      ...row(['L'], 'Toggle loop  ·  Shift-drag the ruler to set it'),
      ...row(['M'], 'Metronome'),
      ...row(['F'], 'Maximize the video preview'),
      ...row(['Click'], 'Add a note / toggle a drum step (drag to paint)'),
      ...row(['Drag'], 'Move notes · drag the right edge to resize'),
      ...row(['Right-click'], 'Erase (drag to erase many)'),
      ...row(['Alt', 'Drag'], 'Duplicate notes · Alt-click a drum step for a ghost note'),
      ...row(['Shift', 'Drag'], 'Box-select'),
      ...row(['Ctrl', 'C / V / D'], 'Copy · paste at playhead · duplicate'),
      ...row(['↑ ↓'], 'Transpose selection (Shift = octave)'),
      ...row(['← →'], 'Nudge selection by one grid step'),
      ...row(['Delete'], 'Delete selection'),
      ...row(['Ctrl', 'Z'], 'Undo  (Ctrl+Shift+Z redo)'),
      ...row(['Ctrl', 'Wheel'], 'Zoom the editor'),
      ...row(['B'], 'A/B: switch between the original and your remake (with a reference loaded)'),
      ...row(['K'], 'Keyboard mode: play notes with A-row keys (Z–M and Q–U for melodic tracks)'),
    ),
  );
  modal('Shortcuts', body, { wide: true });
}
