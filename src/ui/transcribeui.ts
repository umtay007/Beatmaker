import type { Store } from '../core/store';
import type { Actions } from './actions';
import { rangeField, toggleField } from './controls';
import { h, icon, modal, toast } from './dom';

/** Ask what to transcribe from the reference, run it, and report what was written. */
export function showTranscriber(actions: Actions, store: Store): void {
  const opts = { drums: true, pitched: true, sensitivity: 1 };
  const loop = store.song.loop;
  const range = loop.enabled && loop.end > loop.start ? `the loop (bars ${Math.floor(loop.start / 384) + 1}–${Math.ceil(loop.end / 384)})` : 'the whole song';
  const status = h('p', { class: 'section-note' });
  const go = h('button', { class: 'btn btn-primary btn-block' }, icon('sparkle', 15), 'Transcribe') as HTMLButtonElement;
  const body = h(
    'div',
    { class: 'transcriber' },
    h(
      'p',
      { class: 'section-note' },
      `Listens to the original and writes it out as tracks, over ${range}. It lines up with the grid, so detect the tempo first. Drums come from a beat detector; bass, chords and melody from Spotify’s Basic Pitch model (about 2 MB, downloaded once and run on this device, nothing is uploaded). Expect a solid first draft to clean up, not a perfect copy: vocals and dense mixes confuse it. To redo a section, set the loop there and run it again.`,
    ),
    toggleField('Drums (kick, snare, hi-hats)', { get: () => opts.drums, set: (v) => (opts.drums = v) }).el,
    rangeField('Drum sensitivity', { min: 0.5, max: 2, step: 0.05, get: () => opts.sensitivity, set: (v) => (opts.sensitivity = v), format: (v) => `${Math.round(v * 100)}%`, help: 'Higher finds quieter hits (and more false ones)' }).el,
    toggleField('Bass, chords & melody', { get: () => opts.pitched, set: (v) => (opts.pitched = v) }).el,
    status,
    go,
  );
  const m = modal('Transcribe the original', body, { onClose: () => (closed = true) });
  let closed = false;
  go.onclick = async () => {
    if (!opts.drums && !opts.pitched) return;
    go.disabled = true;
    try {
      const summary = await actions.transcribeReference(opts, (msg) => (status.textContent = msg));
      status.replaceChildren(h('b', null, 'Written: '), summary.join(' · '), '. Undo with Ctrl+Z.');
      if (closed) toast(`Transcribed: ${summary.join(' · ')}`, 'ok', 5000);
    } catch (e) {
      status.textContent = `Couldn't transcribe: ${(e as Error).message}`;
    } finally {
      go.disabled = false;
    }
  };
  void m;
}
