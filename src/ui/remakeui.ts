import { defaultWhisper } from '../audio/lyricsasr';
import { separateStems, separationModelCached } from '../audio/separate';
import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import type { Actions } from './actions';
import { exportEverything } from './autoall';
import { autoRemake, type Separator } from './autoremake';
import { desktop } from './desktop';
import { h, icon, modal, toast } from './dom';

/** HTDemucs in the browser (its model downloads once, on first use). */
const separator: Separator = (buf, onProgress, signal) => separateStems(buf, { onProgress, signal });
const separatorCached = separationModelCached;

/** A remake started for you (the desktop app's jobs): the song, where its files go, and what to make. */
export interface AutoRun {
  file: File;
  outDir: string | null;
  options: { thorough: boolean; lyrics: boolean; video: boolean; stems: boolean };
  onDone(result: { ok: boolean; files: string[]; error?: string }): void;
}

/** "Remake a song automatically": choose the original, a few options, and watch it go. */
export function showRemake(store: Store, engine: AudioEngine, actions: Actions, onCompare: () => void, auto?: AutoRun): { close(): void } {
  const app = desktop();
  // The desktop app has the time and the cores: the most thorough settings by default.
  const opts = {
    separate: true,
    thorough: auto?.options.thorough ?? !!app,
    keepVocals: true,
    tidy: true,
    lyrics: auto?.options.lyrics ?? true,
    exportAll: !!auto || !!app,
    video: auto?.options.video ?? true,
    stems: auto?.options.stems ?? false,
  };
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
  const sepOpt = check('Separate the parts first', 'Much better notes and sounds (Meta’s Demucs, running in this browser). The first time, its model downloads once (about 180 MB). Takes a few minutes, longer without a GPU; best on a desktop browser.', () => opts.separate, (v) => (opts.separate = v));
  void separatorCached().then((c) => {
    if (c) sepOpt.querySelector('small')!.textContent = 'Much better notes and sounds (Meta’s Demucs, running in this browser). Its model is already downloaded. Takes a few minutes, longer without a GPU.';
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
    check('Write out the lyrics', `Speech recognition (Whisper, on this computer) writes the words from the separated vocals, timed, for the video. Its model downloads once (${defaultWhisper() === 'small' ? 'about 280 MB' : 'about 100 MB'}). Check the words after: singing fools it.`, () => opts.lyrics, (v) => (opts.lyrics = v)),
    check('Tidy repeats', 'Loops say the same thing each time: fixes notes the transcription got wrong on some passes.', () => opts.tidy, (v) => (opts.tidy = v)),
    check(
      'Then export everything',
      app ? 'The video, an MP3, MIDI (a file per track), the lyrics, the project and a report, into a folder next to the song.' : 'The video, an MP3, MIDI (a file per track), the lyrics, the project and a report, as downloads.',
      () => opts.exportAll,
      (v) => (opts.exportAll = v),
    ),
    progress,
    status,
    start,
    summary,
    compare,
  );
  let ctrl: AbortController | null = null;
  const m = modal('Remake a song automatically', body, { wide: true, onClose: () => ctrl?.abort() });
  showFile();
  if (auto) {
    // A job from the desktop app: load the song and go, no clicks.
    fileLine.textContent = `Loading ${auto.file.name}…`;
    void engine
      .loadBacking(auto.file)
      .then(() => {
        showFile();
        start.click();
      })
      .catch((e: Error) => {
        status.textContent = `Couldn't read ${auto.file.name}: ${e.message}`;
        auto.onDone({ ok: false, files: [], error: e.message });
      });
  }
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
      // A job from the desktop app leaves a trail of its steps in the app's log.
      let said = '';
      const trail = (label: string) => {
        // One line per step: not per percent, file or instrument tried.
        const step = label.split(':')[0].replace(/[\d.]+( of [\d.]+)?( s| MB|%)?/g, '#').trim();
        if (auto && step !== said) console.info(`[job] ${label}`);
        said = step;
      };
      // With everything to export, the remake is the first 80% of the job.
      const share = opts.exportAll ? 0.8 : 1;
      const lines = await autoRemake({ store, engine, actions, separator }, opts, (label, f) => {
        status.textContent = label;
        bar.style.width = `${Math.round(f * 100)}%`;
        trail(label);
        if (auto) app?.progress(f * share, label);
      }, ctrl.signal);
      summary.replaceChildren(...lines.map((l) => h('li', null, l)));
      summary.hidden = false;
      let files: string[] = [];
      if (opts.exportAll) {
        const outDir = auto ? auto.outDir : app && engine.backingFile ? await app.outDirFor(engine.backingFile) : null;
        files = await exportEverything({ store, engine, actions }, outDir, { video: opts.video, stems: opts.stems }, lines, (label, f) => {
          status.textContent = label;
          bar.style.width = `${Math.round(f * 100)}%`;
          trail(label);
          if (auto) app?.progress(share + (1 - share) * f, label);
        }, ctrl.signal);
        if (app && outDir) {
          const dir = outDir;
          body.insertBefore(h('button', { class: 'btn btn-primary btn-block', onclick: () => void app.openFolder(dir) }, icon('file', 15), 'Open the folder'), compare);
        }
      }
      const secs = Math.round((performance.now() - t0) / 1000);
      status.textContent = `Done in ${secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs} s`}${files.length ? `: ${files.length} files written` : ''}. Press B while it plays to flip between the original and the remake.`;
      compare.hidden = false;
      start.hidden = true;
      auto?.onDone({ ok: true, files });
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      status.textContent = stopped ? 'Stopped. What was done so far is kept (Ctrl+Z steps back).' : `Couldn't finish: ${(e as Error).message}`;
      start.replaceChildren(icon('sparkle', 15), 'Try again');
      auto?.onDone({ ok: false, files: [], error: stopped ? 'stopped' : (e as Error).message });
    } finally {
      ctrl = null;
      progress.hidden = true;
      body.querySelectorAll('input').forEach((i) => (i.disabled = false));
    }
  });
  return { close: m.close };
}
