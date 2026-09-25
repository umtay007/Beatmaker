import { registerKit, unregisterKit } from '../audio/drums';
import type { AudioEngine } from '../audio/engine';
import { userKitDef } from '../audio/packs';
import { AUDIO_EXT, autoMap, guessVoice, naturalCompare } from '../audio/packmap';
import { deleteKit, listKits, persistent, putFile, saveKit } from '../core/library';
import type { Store } from '../core/store';
import { DRUM_VOICES } from '../core/theory';
import { h, icon, modal, pickFiles, toast } from './dom';

interface Entry {
  file: File;
  /** Path inside the pack (folder/name) when a folder was picked or dropped. */
  path: string;
  voice: number | null;
}

/** Longest file accepted (a drum hit is tiny; this keeps a stray song out). */
const MAX_BYTES = 25e6;

export function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
}

/**
 * Load a drum pack: map a folder (or a handful of files) from any sample pack onto the drum
 * voices by file name, let the user change the picks, and save it in this browser as a kit.
 */
export function showPackLoader(store: Store, engine: AudioEngine, initial: File[] = []): void {
  let entries: Entry[] = [];
  const picks = new Map<number, number>(); // voice → index into entries
  const decoded = new Map<number, AudioBuffer>();
  let nameEdited = false;

  const nameInput = h('input', { class: 'text', type: 'text', placeholder: 'Pack name', 'aria-label': 'Pack name', maxlength: 40 }) as HTMLInputElement;
  nameInput.addEventListener('input', () => (nameEdited = true));
  const grid = h('div', { class: 'pack-grid' });
  const summary = h('p', { class: 'section-note' });
  const saveBtn = h('button', { class: 'btn btn-primary', disabled: true }, icon('drum', 15), 'Save pack & use it') as HTMLButtonElement;
  const mine = h('div', { class: 'pack-list' });
  const storage = h('p', { class: 'section-note' });

  const preview = async (i: number) => {
    try {
      const ctx = await engine.unlock();
      let buf = decoded.get(i);
      if (!buf) {
        buf = await ctx.decodeAudioData(await entries[i].file.arrayBuffer());
        decoded.set(i, buf);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.8;
      src.connect(g).connect(ctx.destination);
      src.start();
      src.stop(ctx.currentTime + Math.min(4, buf.duration));
    } catch {
      toast(`Can't play “${entries[i].file.name}” (not an audio format this browser reads)`, 'error', 3500);
    }
  };

  // Menus are narrow: lead with the file name, then its folder (minus the pack's own top folder).
  const label = (e: Entry) => {
    const parts = e.path.split('/');
    const dirs = parts.slice(entries.every((x) => x.path.split('/')[0] === parts[0] && x.path.includes('/')) ? 1 : 0, -1);
    return dirs.length ? `${parts[parts.length - 1]} · ${dirs.join('/')}` : parts[parts.length - 1];
  };

  const render = () => {
    grid.replaceChildren();
    if (!entries.length) {
      summary.textContent = '';
      saveBtn.disabled = true;
      return;
    }
    for (const v of DRUM_VOICES) {
      const sel = h('select', { class: 'select', 'aria-label': v.name }) as HTMLSelectElement;
      const guessed = entries.map((e, i) => [e, i] as const).filter(([e]) => e.voice === v.pitch);
      const fill = (all: boolean) => {
        const cur = picks.get(v.pitch);
        sel.replaceChildren(h('option', { value: '' }, '— synth —'));
        const add = (parent: HTMLElement, list: (readonly [Entry, number])[]) => {
          for (const [e, i] of list) parent.append(h('option', { value: i, selected: i === cur, title: e.path }, label(e)));
        };
        add(sel, guessed);
        const others = entries.map((e, i) => [e, i] as const).filter(([e, i]) => e.voice !== v.pitch && (all || i === cur));
        if (others.length) {
          const og = h('optgroup', { label: all ? 'Other files' : 'Picked' });
          add(og, others);
          sel.append(og);
        }
        if (cur === undefined) sel.value = '';
      };
      // The full list can be thousands of files: only build it when this menu is opened.
      fill(false);
      let full = false;
      const expand = () => {
        if (full) return;
        full = true;
        fill(true);
      };
      sel.addEventListener('pointerdown', expand);
      sel.addEventListener('focus', expand);
      sel.addEventListener('change', () => {
        if (sel.value === '') picks.delete(v.pitch);
        else {
          picks.set(v.pitch, Number(sel.value));
          void preview(Number(sel.value));
        }
        update();
      });
      const play = h('button', { class: 'icon-btn', title: `Hear the ${v.name.toLowerCase()}`, 'aria-label': `Hear the ${v.name.toLowerCase()}`, onclick: () => {
        const i = picks.get(v.pitch);
        if (i !== undefined) void preview(i);
        else {
          const t = store.track;
          if (t?.kind === 'drums') engine.preview({ ...t, instrument: 'trap' }, v.pitch);
        }
      } }, icon('play', 14));
      grid.append(h('label', { class: 'pack-row' }, h('span', null, v.name), sel, play));
    }
    update();
  };

  const update = () => {
    const matched = new Set([...picks.values()]).size;
    const unmatched = entries.filter((e) => e.voice === null).length;
    summary.textContent = `${entries.length} sound${entries.length === 1 ? '' : 's'} · ${picks.size} of ${DRUM_VOICES.length} voices filled${unmatched ? ` · ${unmatched} not recognized by name (pick them from any menu)` : ''}.`;
    saveBtn.disabled = matched === 0;
  };

  const setFiles = (files: File[]) => {
    const audio = files.filter((f) => isAudioFile(f) && f.size <= MAX_BYTES).slice(0, 5000);
    if (!audio.length) {
      if (files.length) toast('No audio files there (WAV, AIFF, MP3, OGG, FLAC…)', 'error');
      return;
    }
    entries = audio
      .map((file) => {
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || (file as File & { packPath?: string }).packPath || file.name;
        return { file, path, voice: guessVoice(path) };
      })
      .sort((a, b) => naturalCompare(a.path, b.path));
    decoded.clear();
    picks.clear();
    for (const [v, i] of autoMap(entries.map((e) => e.path))) picks.set(v, i);
    if (!nameEdited) {
      // Name it after the folder, or the files' shared prefix.
      const top = entries[0].path.includes('/') ? entries[0].path.split('/')[0] : '';
      nameInput.value = top || 'My drum pack';
    }
    render();
  };

  const refreshMine = async () => {
    const kits = await listKits();
    mine.replaceChildren(
      ...(kits.length
        ? kits.map((k) =>
            h(
              'div',
              { class: 'pack-item' },
              h('b', null, k.name),
              h('span', null, `${Object.keys(k.files).length} sounds`),
              h('button', { class: 'btn btn-ghost', onclick: () => {
                useKit(k.id);
                m.close();
              } }, 'Use'),
              h('button', { class: 'btn btn-ghost danger', onclick: async () => {
                if (!confirm(`Delete the pack “${k.name}” from this browser?`)) return;
                await deleteKit(k.id);
                unregisterKit(k.id);
                // Tracks that used it fall back to the kit its missing voices came from.
                if (store.song.tracks.some((t) => t.instrument === k.id)) {
                  store.update((s) => s.tracks.forEach((t) => t.instrument === k.id && (t.instrument = 'trap')));
                } else store.emit('song'); // refresh kit menus
                void refreshMine();
              } }, 'Delete'),
            ),
          )
        : [h('p', { class: 'section-note' }, 'None yet.')]),
    );
  };

  const useKit = (id: string) => {
    const t = store.track?.kind === 'drums' ? store.track : store.song.tracks.find((x) => x.kind === 'drums');
    if (!t) {
      toast('Pack saved. Pick it from a drum track’s kit menu.', 'ok', 3500);
      store.emit('song');
      return;
    }
    store.update((s) => {
      const cur = s.tracks.find((x) => x.id === t.id);
      if (cur) cur.instrument = id;
    });
    void engine.ensureKits();
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const files: Record<number, string> = {};
      const stored = new Map<number, string>(); // entry index → file id (one copy per sound)
      for (const [v, i] of picks) {
        let id = stored.get(i);
        if (!id) {
          const data = await entries[i].file.arrayBuffer();
          // Make sure it decodes before keeping it (decodeAudioData detaches its input: use a copy).
          const ctx = await engine.unlock();
          await ctx.decodeAudioData(data.slice(0));
          id = await putFile(entries[i].file.name, data);
          stored.set(i, id);
        }
        files[v] = id;
      }
      const kit = await saveKit(nameInput.value.trim() || 'My drum pack', files);
      registerKit(userKitDef(kit));
      useKit(kit.id);
      toast(`Saved “${kit.name}” (${stored.size} sounds)`, 'ok');
      m.close();
    } catch (e) {
      toast(`Couldn't save the pack: ${(e as Error).message}`, 'error', 4500);
      saveBtn.disabled = false;
    }
  };

  const body = h(
    'div',
    { class: 'pack-loader' },
    h('p', { class: 'section-note' }, 'Use drums from any sample pack you have: pick its folder (or a few files). Sounds are matched to drum voices by their names, and you can change any pick. They stay in this browser; nothing is uploaded.'),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn', onclick: async () => setFiles(await pickFiles('audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac', true)) }, icon('file', 15), 'Choose a folder…'),
      h('button', { class: 'btn', onclick: async () => setFiles(await pickFiles('audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac')) }, icon('upload', 15), 'Choose files…'),
    ),
    h('label', { class: 'pack-name' }, h('span', null, 'Name'), nameInput),
    summary,
    grid,
    h('div', { class: 'btn-row' }, saveBtn),
    h('h3', null, 'Your packs'),
    mine,
    storage,
  );
  const m = modal('Load a drum pack', body, { wide: true });
  void refreshMine();
  void persistent().then((ok) => {
    if (!ok) storage.textContent = 'This browser is blocking storage here, so packs last until you close the tab.';
  });
  if (initial.length) setFiles(initial);
}

/** Every file inside dropped items, walking into dropped folders (their paths kept for mapping). */
export async function droppedFiles(dt: DataTransfer): Promise<{ files: File[]; folder: boolean }> {
  const entries = [...dt.items].map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e);
  if (!entries.some((e) => e.isDirectory)) return { files: [...dt.files], folder: false };
  const out: File[] = [];
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 5000) return;
    if (e.isFile) {
      const f = await new Promise<File | null>((r) => (e as FileSystemFileEntry).file(r, () => r(null)));
      if (f) {
        (f as File & { packPath?: string }).packPath = prefix + f.name;
        out.push(f);
      }
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until it returns an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((r) => reader.readEntries(r, () => r([])));
        if (!batch.length) break;
        for (const c of batch) await walk(c, prefix + e.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return { files: out, folder: true };
}
