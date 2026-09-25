import type { AudioEngine } from '../audio/engine';
import { KIT_BY_ID, KITS } from '../audio/drums';
import { GROUPS, INSTRUMENT_BY_ID, INSTRUMENTS } from '../audio/instruments';
import type { Store } from '../core/store';
import { newNoteId, newTrackId, type Track } from '../core/types';
import { PALETTES } from '../visual/settings';
import { h, icon, showMenu, type MenuItem } from './dom';

export function instrumentLabel(t: Track): string {
  return t.kind === 'drums' ? KIT_BY_ID.get(t.instrument)?.label ?? 'Drum kit' : INSTRUMENT_BY_ID.get(t.instrument)?.label ?? t.instrument;
}

export function instrumentOptions(kind: Track['kind']): [string, string][] {
  if (kind === 'drums') return KITS.map((k) => [k.id, k.label]);
  const out: [string, string][] = [];
  for (const group of GROUPS) {
    const list = INSTRUMENTS.filter((i) => i.group === group);
    if (!list.length) continue;
    out.push([`group:${group}`, group]);
    // Real (sampled) instruments first in each family.
    for (const i of [...list.filter((x) => x.sampled), ...list.filter((x) => !x.sampled)]) out.push([i.id, i.sampled ? `${i.label} · real` : i.label]);
  }
  return out;
}

export class TracksPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private sig = '';
  private rows = new Map<string, { row: HTMLElement; m: HTMLElement; s: HTMLElement; eye: HTMLButtonElement; vol: HTMLInputElement }>();

  constructor(
    private store: Store,
    private engine: AudioEngine,
  ) {
    this.list = h('div', { class: 'track-list', role: 'listbox', 'aria-label': 'Tracks' });
    const addDrums = h('button', { class: 'btn', onclick: () => this.addTrack('drums') }, icon('drum', 16), 'Drums');
    const addInst = h('button', { class: 'btn', onclick: (e: MouseEvent) => this.addInstrumentMenu(e.currentTarget as HTMLElement) }, icon('piano', 16), 'Instrument');
    this.el = h(
      'div',
      { class: 'tracks' },
      h('div', { class: 'tracks-head' }, h('span', null, 'Tracks'), h('span', { class: 'track-count' })),
      this.list,
      h('div', { class: 'tracks-foot' }, addDrums, addInst),
    );
    store.on('song', () => this.sync());
    store.on('ui', () => this.sync());
    this.sync();
  }

  private sync(): void {
    const song = this.store.song;
    const sig = song.tracks.map((t) => [t.id, t.name, t.instrument, t.color, t.kind].join(':')).join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      this.render();
    }
    const anySolo = song.tracks.some((t) => t.solo);
    for (const t of song.tracks) {
      const r = this.rows.get(t.id);
      if (!r) continue;
      r.row.classList.toggle('sel', t.id === this.store.track?.id);
      r.row.setAttribute('aria-selected', String(t.id === this.store.track?.id));
      r.m.classList.toggle('on', t.mute);
      r.s.classList.toggle('on', t.solo);
      r.row.style.opacity = t.mute || (anySolo && !t.solo) ? '0.55' : '1';
      r.row.classList.toggle('hidden-vis', !t.visible);
      r.eye.replaceChildren(icon(t.visible ? 'eye' : 'eyeOff', 15));
      r.eye.title = t.visible ? 'Shown in video (click to hide)' : 'Hidden from video (click to show)';
      if (document.activeElement !== r.vol) r.vol.value = String(t.volume);
      r.vol.style.setProperty('--pct', `${(t.volume / 1.2) * 100}%`);
    }
    const count = this.el.querySelector('.track-count');
    if (count) count.textContent = String(song.tracks.length);
  }

  private render(): void {
    this.list.replaceChildren();
    this.rows.clear();
    for (const t of this.store.song.tracks) {
      const m = h('button', { class: 'toggle-chip m', title: 'Mute', 'aria-label': `Mute ${t.name}`, onclick: (e: Event) => this.flip(e, t.id, 'mute') }, 'M');
      const s = h('button', { class: 'toggle-chip s', title: 'Solo', 'aria-label': `Solo ${t.name}`, onclick: (e: Event) => this.flip(e, t.id, 'solo') }, 'S');
      const eye = h('button', { class: 'icon-btn sm', 'aria-label': `Toggle ${t.name} in video`, onclick: (e: Event) => this.flip(e, t.id, 'visible') }) as HTMLButtonElement;
      const more = h('button', { class: 'icon-btn sm', 'aria-label': `${t.name} options`, onclick: (e: MouseEvent) => this.trackMenu(e, t.id) }, icon('more', 15));
      const vol = h('input', {
        type: 'range',
        class: 'range track-vol',
        min: 0,
        max: 1.2,
        step: 0.01,
        'aria-label': `${t.name} volume`,
        title: 'Volume',
        onpointerdown: (e: Event) => {
          e.stopPropagation();
          this.store.beginGesture();
        },
        onclick: (e: Event) => e.stopPropagation(),
        oninput: (e: Event) => {
          const track = this.find(t.id);
          if (!track) return;
          track.volume = Number((e.target as HTMLInputElement).value);
          this.store.touch();
        },
        onchange: () => this.store.endGesture(),
      }) as HTMLInputElement;
      const name = h('div', { class: 'track-name' }, icon(t.kind === 'drums' ? 'drum' : 'piano', 14), h('span', null, t.name));
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.rename(t.id, name);
      });
      const row = h(
        'div',
        {
          class: 'track',
          role: 'option',
          tabindex: 0,
          style: { '--tc': t.color } as unknown as Partial<CSSStyleDeclaration>,
          onclick: () => this.select(t.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') this.select(t.id);
          },
        },
        h('div', { class: 'track-color' }),
        h('div', { class: 'track-main' }, name, h('div', { class: 'track-sub-row' }, h('div', { class: 'track-sub' }, instrumentLabel(t)), vol)),
        h('div', { class: 'track-btns' }, m, s, eye, more),
      );
      row.style.setProperty('--tc', t.color);
      this.list.append(row);
      this.rows.set(t.id, { row, m, s, eye, vol });
    }
  }

  private find(id: string): Track | undefined {
    return this.store.song.tracks.find((t) => t.id === id);
  }

  private select(id: string): void {
    if (this.store.ui.selectedTrackId !== id) this.store.setUI({ selectedTrackId: id });
  }

  private flip(e: Event, id: string, key: 'mute' | 'solo' | 'visible'): void {
    e.stopPropagation();
    this.store.update(() => {
      const t = this.find(id);
      if (t) t[key] = !t[key];
    });
  }

  private rename(id: string, nameEl: HTMLElement): void {
    const t = this.find(id);
    if (!t) return;
    const input = h('input', { value: t.name, maxlength: 40, 'aria-label': 'Track name' }) as HTMLInputElement;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = (save: boolean) => {
      const v = input.value.trim();
      if (save && v && v !== t.name) this.store.update(() => (t.name = v));
      else this.sig = '';
      this.sync();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private pickColor(id: string): void {
    const t = this.find(id);
    if (!t) return;
    const input = h('input', { type: 'color', value: t.color, style: { position: 'fixed', opacity: '0', pointerEvents: 'none', left: '50%', top: '50%' } }) as HTMLInputElement;
    document.body.append(input);
    input.addEventListener('input', () => {
      const cur = this.find(id);
      if (!cur) return;
      this.store.beginGesture();
      cur.color = input.value;
      this.store.touch();
    });
    input.addEventListener('change', () => {
      this.store.endGesture();
      input.remove();
    });
    input.click();
  }

  /** Track actions look the track up by id when they run: undo/redo swaps in new track objects. */
  private trackMenu(e: MouseEvent, id: string): void {
    e.stopPropagation();
    const items: (MenuItem | '-')[] = [
      { label: 'Rename', action: () => {
        const r = this.rows.get(id);
        const nm = r?.row.querySelector('.track-name') as HTMLElement | null;
        if (nm) this.rename(id, nm);
      } },
      { label: 'Change color…', action: () => this.pickColor(id) },
      { label: 'Duplicate', icon: 'duplicate', action: () => this.duplicate(id) },
      '-',
      { label: 'Move up', action: () => this.move(id, -1) },
      { label: 'Move down', action: () => this.move(id, 1) },
      '-',
      { label: 'Clear notes', icon: 'broom', action: () => this.store.update(() => {
        const t = this.find(id);
        if (t) t.notes = [];
      }) },
      { label: 'Delete track', icon: 'trash', danger: true, action: () => this.remove(id) },
    ];
    showMenu(e.currentTarget as HTMLElement, items);
  }

  private move(id: string, d: number): void {
    const tracks = this.store.song.tracks;
    const idx = tracks.findIndex((t) => t.id === id);
    const j = idx + d;
    if (idx < 0 || j < 0 || j >= tracks.length) return;
    this.store.update((s) => {
      [s.tracks[idx], s.tracks[j]] = [s.tracks[j], s.tracks[idx]];
    });
  }

  private duplicate(id: string): void {
    const t = this.find(id);
    if (!t) return;
    const copy: Track = { ...JSON.parse(JSON.stringify(t)), id: newTrackId(), name: `${t.name} copy`, solo: false };
    copy.notes = copy.notes.map((n) => ({ ...n, id: newNoteId() }));
    this.store.update((s) => {
      s.tracks.splice(s.tracks.findIndex((x) => x.id === id) + 1, 0, copy);
    });
    this.store.setUI({ selectedTrackId: copy.id });
  }

  private remove(id: string): void {
    this.store.update((s) => {
      s.tracks = s.tracks.filter((x) => x.id !== id);
    });
    if (this.store.ui.selectedTrackId === id) this.store.setUI({ selectedTrackId: this.store.song.tracks[0]?.id ?? '' });
  }

  nextColor(): string {
    const pal = PALETTES[this.store.visual.palette]?.colors ?? PALETTES.neon.colors;
    const used = new Set(this.store.song.tracks.map((t) => t.color));
    return pal.find((c) => !used.has(c)) ?? pal[this.store.song.tracks.length % pal.length];
  }

  addTrack(kind: Track['kind'], instrument?: string): void {
    const inst = instrument ?? (kind === 'drums' ? 'trap' : 'pluck');
    const label = kind === 'drums' ? 'Drums' : INSTRUMENT_BY_ID.get(inst)?.label ?? 'Synth';
    const t: Track = {
      id: newTrackId(),
      name: label,
      kind,
      instrument: inst,
      color: this.nextColor(),
      volume: 0.8,
      pan: 0,
      reverb: kind === 'drums' ? 0.05 : 0.2,
      mute: false,
      solo: false,
      visible: true,
      notes: [],
    };
    this.store.update((s) => s.tracks.push(t));
    this.store.setUI({ selectedTrackId: t.id });
    void this.engine.ensureKits();
  }

  private addInstrumentMenu(anchor: HTMLElement): void {
    const items: (MenuItem | '-')[] = [];
    let group = '';
    for (const i of INSTRUMENTS) {
      if (group && i.group !== group) items.push('-');
      group = i.group;
      items.push({ label: i.label, hint: i.group, action: () => this.addTrack('synth', i.id) });
    }
    showMenu(anchor, items);
  }
}
