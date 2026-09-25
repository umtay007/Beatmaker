import type { AudioEngine } from '../audio/engine';
import { loadSoundFont, parseSfz, type SoundFont } from '../audio/soundfont';
import { loadUserFont, rememberFont } from '../audio/userfonts';
import { AUDIO_EXT } from '../audio/packmap';
import { putFile } from '../core/library';
import type { Store } from '../core/store';
import { newTrackId, type SoundfontSettings, type Track } from '../core/types';
import { h, icon, modal, pickFile, pickFiles, toast } from './dom';

/** A soundfont chosen from disk, stored in the library and parsed. */
interface Loaded {
  sf: SoundFont;
  settings: Omit<SoundfontSettings, 'preset' | 'presetName'>;
}

async function fromSf2(file: File): Promise<Loaded> {
  const data = await file.arrayBuffer();
  const sf = await loadSoundFont(data.slice(0), file.name);
  const id = await putFile(file.name, data);
  rememberFont(id, sf);
  return { sf, settings: { file: id, name: file.name } };
}

/** An SFZ instrument from a picked folder: the .sfz (asked for if there are several) and the samples it uses. */
async function fromSfzFolder(files: File[], choose: (names: string[]) => Promise<string | null>): Promise<Loaded | null> {
  const path = (f: File) => (f.webkitRelativePath || f.name).replace(/\\/g, '/');
  const sfzs = files.filter((f) => /\.sfz$/i.test(f.name));
  if (!sfzs.length) throw new Error('No .sfz file in that folder');
  const pick = sfzs.length === 1 ? path(sfzs[0]) : await choose(sfzs.map(path));
  const sfzFile = sfzs.find((f) => path(f) === pick);
  if (!sfzFile) return null;
  const dir = path(sfzFile).split('/').slice(0, -1).join('/');
  const rel = (f: File) => {
    const p = path(f);
    return dir && p.startsWith(dir + '/') ? p.slice(dir.length + 1) : p;
  };
  const audio = files.filter((f) => AUDIO_EXT.test(f.name));
  const map = new Map<string, ArrayBuffer>();
  await Promise.all(audio.map(async (f) => map.set(rel(f), await f.arrayBuffer())));
  const text = await sfzFile.text();
  const copy = new Map([...map].map(([k, v]) => [k, v.slice(0)] as const));
  const sf = await parseSfz(text, copy, sfzFile.name);
  // Keep only the samples it plays (a folder can hold several instruments' worth).
  const used = new Set(sf.samples.map((s) => s.name.replace(/\\/g, '/').toLowerCase()));
  const keepAll = ![...map.keys()].some((k) => used.has(k.toLowerCase()) || [...used].some((u) => u.endsWith(k.toLowerCase())));
  const samples: Record<string, string> = {};
  for (const [k, data] of map) {
    const lk = k.toLowerCase();
    if (keepAll || used.has(lk) || [...used].some((u) => u.endsWith(lk) || lk.endsWith(u))) samples[k] = await putFile(k.split('/').pop() || k, data);
  }
  const id = await putFile(sfzFile.name, new TextEncoder().encode(text).buffer);
  rememberFont(id, sf);
  if (sf.missing.length) toast(`${sf.missing.length} sample${sf.missing.length === 1 ? '' : 's'} named in the .sfz weren't in the folder; those notes are skipped.`, 'info', 5000);
  return { sf, settings: { file: id, name: sfzFile.name, samples } };
}

function choice(title: string, names: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, h('div', { class: 'sf-list' }, names.map((n) => h('button', { class: 'sf-item', onclick: () => ((done = true), m.close(), resolve(n)) }, n))), { onClose: () => !done && resolve(null) });
  });
}

/** The preset list of a loaded soundfont; resolves with the chosen index (or null). */
function presetList(sf: SoundFont, current = -1): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search presets…', 'aria-label': 'Search presets' }) as HTMLInputElement;
    const list = h('div', { class: 'sf-list' });
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...sf.presets
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => !q || p.name.toLowerCase().includes(q))
          .slice(0, 400)
          .map(({ p, i }) =>
            h('button', { class: 'sf-item' + (i === current ? ' on' : ''), onclick: () => ((done = true), m.close(), resolve(i)) }, h('span', { class: 'sf-num' }, sf.format === 'sfz' ? '' : `${p.bank}:${p.program}`), p.name || `Preset ${i + 1}`),
          ),
      );
    };
    search.addEventListener('input', paint);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    paint();
    const m = modal(`${sf.name} · ${sf.presets.length} preset${sf.presets.length === 1 ? '' : 's'}`, h('div', null, sf.presets.length > 8 ? search : null, list), { onClose: () => !done && resolve(null) });
    setTimeout(() => search.focus(), 30);
  });
}

async function pickSource(): Promise<Loaded | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Loaded | null) => {
      done = true;
      m.close();
      resolve(v);
    };
    const status = h('p', { class: 'section-note' }, 'Kept in this browser. A project that uses one saves as a .zip with it inside, so it opens anywhere.');
    const run = async (job: () => Promise<Loaded | null>) => {
      status.textContent = 'Reading…';
      try {
        const r = await job();
        if (r) finish(r);
        else status.textContent = 'Nothing chosen.';
      } catch (e) {
        status.textContent = `Couldn't read it: ${(e as Error).message}`;
      }
    };
    const body = h(
      'div',
      null,
      h('p', null, 'Play any instrument from a soundfont: a .sf2 or .sf3 file (General MIDI sets, single instruments), or a folder with an .sfz instrument and its samples.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', onclick: () => void run(async () => {
          const f = await pickFile('.sf2,.sf3');
          return f ? fromSf2(f) : null;
        }) }, icon('upload', 15), '.sf2 / .sf3 file…'),
        h('button', { class: 'btn', onclick: () => void run(async () => {
          const files = await pickFiles('', true);
          return files.length ? fromSfzFolder(files, (names) => choice('Which instrument?', names)) : null;
        }) }, icon('file', 15), 'SFZ folder…'),
      ),
      status,
    );
    const m = modal('Load a soundfont', body, { onClose: () => !done && resolve(null) });
  });
}

function settingsFor(l: Loaded, preset: number): SoundfontSettings {
  return { ...l.settings, preset, presetName: l.sf.presets[preset]?.name ?? '' };
}

/** Turn a track into a soundfont track (choose the file, then the preset). */
export async function chooseSoundfont(store: Store, engine: AudioEngine, trackId: string): Promise<boolean> {
  const l = await pickSource();
  if (!l) return false;
  const preset = l.sf.presets.length === 1 ? 0 : await presetList(l.sf);
  if (preset === null) return false;
  const t = store.song.tracks.find((x) => x.id === trackId);
  if (!t) return false;
  store.update(() => {
    t.instrument = 'soundfont';
    t.soundfont = settingsFor(l, preset);
  });
  void engine.ensureKits().then(() => engine.preview(t, 60, 0.8, 0.5));
  return true;
}

/** A new track playing a soundfont (optionally one already picked or dropped). */
export async function newSoundfontTrack(store: Store, engine: AudioEngine, color: string, file?: File): Promise<void> {
  let l: Loaded | null;
  try {
    l = file ? await fromSf2(file) : await pickSource();
  } catch (e) {
    toast(`Couldn't read that soundfont: ${(e as Error).message}`, 'error', 4500);
    return;
  }
  if (!l) return;
  const preset = l.sf.presets.length === 1 ? 0 : await presetList(l.sf);
  if (preset === null) return;
  const s = settingsFor(l, preset);
  const t: Track = {
    id: newTrackId(),
    name: (s.presetName || s.name.replace(/\.[^.]+$/, '')).slice(0, 28) || 'Soundfont',
    kind: 'synth',
    instrument: 'soundfont',
    color,
    volume: 0.8,
    pan: 0,
    reverb: 0.2,
    mute: false,
    solo: false,
    visible: true,
    soundfont: s,
    notes: [],
  };
  store.update((song) => song.tracks.push(t));
  store.setUI({ selectedTrackId: t.id });
  void engine.ensureKits().then(() => engine.preview(t, 60, 0.8, 0.5));
}

/** Pick another preset of the track's soundfont. */
export async function chooseSoundfontPreset(store: Store, engine: AudioEngine, trackId: string): Promise<void> {
  const t = store.song.tracks.find((x) => x.id === trackId);
  if (!t?.soundfont) return;
  const sf = await loadUserFont(t.soundfont);
  if (!sf) {
    toast('That soundfont isn’t saved in this browser any more: load it again.', 'error', 4500);
    await chooseSoundfont(store, engine, trackId);
    return;
  }
  const preset = await presetList(sf, t.soundfont.preset);
  if (preset === null) return;
  store.update(() => {
    t.soundfont = { ...t.soundfont!, preset, presetName: sf.presets[preset]?.name ?? '' };
  });
  void engine.ensureKits().then(() => engine.preview(t, 60, 0.8, 0.5));
}
