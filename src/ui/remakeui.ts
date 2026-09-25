import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import type { Actions } from './actions';
import { autoRemake, type Separator } from './autoremake';
import { h, icon, modal, toast } from './dom';

/** Set once the separation module is available (it loads its model on first use). */
let separator: Separator | undefined;
let separatorCached: () => Promise<boolean> = async () => false;
export function provideSeparator(fn: Separator, cached: () => Promise<boolean>): void {
  separator = fn;
  separatorCached = cached;
}

/** "Remake a song automatically": choose the original, a few options, and watch it go. */
export function showRemake(store: Store, engine: AudioEngine, actions: Actions, onCompare: () => void): void {
  const opts = { separate: !!separator, thorough: false, keepVocals: false, tidy: true };
  const fileLine = h('p', { class: 'remake-file' });
  const pick = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac', hidden: true }) as HTMLInputElement;
  const showFile = () => {
    fileLine.replaceChildren(
      engine.backingBuffer ? h('span', null, 'Original: ', h('strong', null, engine.backingName || 'the loaded reference')) : h('span', null, 'Choose the song to remake.'),
      h('button', { class: 'btn btn-ghost', onclick: () => pick.click() }, icon('upload', 14), engine.backingBuffer ? 'Change…' : 'Choose a song…'),
    );
    start.disabled = !engine.backingBuffer;
  };
  pick.addEventListener('change', async () => {
    const f = pick.files?.[0];
    if (!f) return;
    fileLine.textContent = `Loading ${f.name}…`;
    try {
      await engine.loadBacking(f);
    } catch (e) {
      toast(`Couldn't read that file: ${(e as Error).message}`, 'error', 4500);
    }
    showFile();
  });
  const check = (label: string, note: string, get: () => boolean, set: (v: boolean) => void, disabled = false) => {
    const box = h('input', { type: 'checkbox', checked: get(), disabled }) as HTMLInputElement;
    box.addEventListener('change', () => set(box.checked));
    return h('label', { class: 'remake-opt' + (disabled ? ' off' : '') }, box, h('span', null, h('strong', null, label), h('small', null, note)));
  };
  const sepOpt = check('Separate the parts first', 'Much better notes and sounds. The first time, the separation model downloads once (about 175 MB).', () => opts.separate, (v) => (opts.separate = v), !separator);
  if (!separator) sepOpt.querySelector('small')!.textContent = 'Not available in this build.';
  void separatorCached().then((c) => {
    if (c && separator) sepOpt.querySelector('small')!.textContent = 'Much better notes and sounds. The separation model is already downloaded.';
  });
  const status = h('p', { class: 'remake-status' }, '');
  const bar = h('div', { style: { width: '0%' } });
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const summary = h('ul', { class: 'remake-summary', hidden: true });
  const start = h('button', { class: 'btn btn-primary btn-block' }, icon('sparkle', 15), 'Remake it') as HTMLButtonElement;
  const compare = h('button', { class: 'btn btn-block', hidden: true, onclick: () => (m.close(), onCompare()) }, 'Compare with the original (A/B)');
  const body = h(
    'div',
    { class: 'remake' },
    h('p', null, 'Works out the tempo and key, writes the drums, bass, chords and melody as tracks, picks the closest instruments and kit, sets their levels and tone, finds the sections, and matches the mix to the original. It replaces the current song and runs entirely in this browser: nothing is uploaded.'),
    fileLine,
    pick,
    sepOpt,
    check('Try every instrument', 'Slower, sometimes closer. Otherwise a shortlist per part.', () => opts.thorough, (v) => (opts.thorough = v)),
    check('Keep the original vocals', 'Puts the separated vocals on a track of their own (needs “Separate the parts”).', () => opts.keepVocals, (v) => (opts.keepVocals = v)),
    check('Tidy repeats', 'Loops say the same thing each time: fixes notes the transcription got wrong on some passes.', () => opts.tidy, (v) => (opts.tidy = v)),
    progress,
    status,
    start,
    summary,
    compare,
  );
  let ctrl: AbortController | null = null;
  const m = modal('Remake a song automatically', body, { wide: true, onClose: () => ctrl?.abort() });
  showFile();
  start.addEventListener('click', async () => {
    if (ctrl) {
      ctrl.abort();
      return;
    }
    ctrl = new AbortController();
    start.replaceChildren(icon('close', 15), 'Stop');
    progress.hidden = false;
    summary.hidden = true;
    body.querySelectorAll('input').forEach((i) => (i.disabled = true));
    const t0 = performance.now();
    try {
      await engine.unlock();
      const lines = await autoRemake({ store, engine, actions, separator }, opts, (label, f) => {
        status.textContent = label;
        bar.style.width = `${Math.round(f * 100)}%`;
      }, ctrl.signal);
      status.textContent = `Done in ${Math.round((performance.now() - t0) / 1000)} s. Press B while it plays to flip between the original and the remake.`;
      summary.replaceChildren(...lines.map((l) => h('li', null, l)));
      summary.hidden = false;
      compare.hidden = false;
      start.hidden = true;
    } catch (e) {
      status.textContent = (e as Error).name === 'AbortError' ? 'Stopped. What was done so far is kept (Ctrl+Z steps back).' : `Couldn't finish: ${(e as Error).message}`;
      start.replaceChildren(icon('sparkle', 15), 'Try again');
    } finally {
      ctrl = null;
      progress.hidden = true;
      body.querySelectorAll('input').forEach((i) => (i.disabled = false));
      if (!separator) (sepOpt.querySelector('input') as HTMLInputElement).disabled = true;
    }
  });
}
