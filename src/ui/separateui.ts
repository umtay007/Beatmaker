/**
 * "Separate the vocals" on its own (the automatic remake does it as one of its steps): HTDemucs on
 * the loaded original, keeping the parts on the engine for the lyrics and vocal-track tools.
 */
import type { AudioEngine } from '../audio/engine';
import { separateStems, separationModelCached } from '../audio/separate';
import { h, icon } from './dom';

/** A button that separates the loaded original, reporting in `status`; `onDone` once the parts are there. `stop` cancels it (the dialog closing). */
export function separateButton(engine: AudioEngine, status: HTMLElement, onDone: () => void): { el: HTMLElement; stop: () => void } {
  const btn = h('button', { class: 'btn' }, icon('sparkle', 15), 'Separate the vocals…') as HTMLButtonElement;
  const note = h('p', { class: 'section-note' });
  const say = () => {
    if (!engine.backingBuffer) {
      btn.disabled = true;
      note.textContent = 'Load the original first (File → Load reference audio…) to separate its vocals.';
      return;
    }
    void separationModelCached().then((c) => {
      note.textContent = `Splits ${engine.backingName || 'the original'} into drums, bass, melody and vocals in this browser (Meta’s Demucs). ${c ? 'Its model is already downloaded.' : 'Its model downloads once (about 180 MB).'} Takes a few minutes, longer without a GPU.`;
    });
  };
  let ctrl: AbortController | null = null;
  btn.addEventListener('click', async () => {
    const buf = engine.backingBuffer;
    if (!buf) return;
    if (ctrl) return ctrl.abort();
    ctrl = new AbortController();
    btn.replaceChildren(icon('close', 15), 'Stop');
    try {
      const stems = await separateStems(buf, { signal: ctrl.signal, onProgress: (f, msg) => (status.textContent = `${msg} ${Math.round(f * 100)}%`) });
      // Only if the same original is still loaded.
      if (engine.backingBuffer !== buf) throw new Error('the original changed while it was being separated');
      engine.stems = stems;
      status.textContent = 'The parts are separated.';
      onDone();
    } catch (e) {
      status.textContent = (e as Error).name === 'AbortError' ? 'Stopped.' : `Couldn't separate it: ${(e as Error).message}`;
      btn.replaceChildren(icon('sparkle', 15), 'Separate the vocals…');
    } finally {
      ctrl = null;
    }
  });
  say();
  return { el: h('div', { class: 'lyrics-asr' }, h('div', { class: 'btn-row' }, btn), note), stop: () => ctrl?.abort() };
}
