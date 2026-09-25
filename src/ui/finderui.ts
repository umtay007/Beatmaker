import type { AudioEngine } from '../audio/engine';
import { busiestStretch, finderCandidates, findInstrument, type FinderResult } from '../audio/finder';
import { instrumentFor } from '../audio/instruments';
import type { Store } from '../core/store';
import { BAR, type Track } from '../core/types';
import { h, icon, modal, toast } from './dom';

/** Which stem of a separated original a track should be compared against. */
export function trackPart(t: Track): 'drums' | 'bass' | 'other' {
  if (t.kind === 'drums') return 'drums';
  if (instrumentFor(t.instrument).group === 'Bass') return 'bass';
  const pitches = t.notes.map((n) => n.pitch).sort((a, b) => a - b);
  return pitches.length && pitches[pitches.length >> 1] < 48 ? 'bass' : 'other';
}

/**
 * "Find the instrument": try every instrument (or kit) on the track over a stretch of the song and
 * list the closest to the original, to listen to and keep.
 */
export function showFinder(store: Store, engine: AudioEngine, trackId: string): void {
  const track = () => store.song.tracks.find((t) => t.id === trackId);
  const t0 = track();
  if (!t0) return;
  if (!engine.backingBuffer) {
    toast('Load the original song as a reference first (File → Load reference audio)', 'error', 4500);
    return;
  }
  if (!t0.notes.length) {
    toast('This track has no notes to try instruments on', 'error');
    return;
  }
  const original = t0.instrument;
  const song = store.song;
  const tl = engine.timeline;
  const loop = song.loop.enabled && song.loop.end > song.loop.start;
  const span = loop ? { from: tl.rawTickToSec(song.loop.start), to: tl.rawTickToSec(song.loop.end) } : busiestStretch(song, t0);
  const barOf = (sec: number) => Math.round(tl.secToTick(sec) / BAR) + 1;
  const part = trackPart(t0);
  const stem = engine.stems?.[part];
  let scope: 'recorded' | 'all' = 'recorded';
  let useStem = !!stem;
  let ctrl: AbortController | null = null;
  let kept = false;

  const status = h('p', null, `Compares bars ${barOf(span.from)}–${barOf(span.to) - 1}${loop ? ' (the loop)' : ' (where this track plays the most; set a loop to choose)'}.`);
  const bar = h('div', { style: { width: '0%' } });
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const list = h('div', { class: 'finder-list' });
  const seg = (items: [string, string][], get: () => string, set: (v: string) => void) => {
    const el = h('div', { class: 'seg' });
    const paint = () => el.querySelectorAll<HTMLElement>('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
    for (const [v, label] of items) el.append(h('button', { class: 'seg-btn', 'data-v': v, onclick: () => (set(v), paint()) }, label));
    paint();
    return el;
  };
  const drums = t0.kind === 'drums';
  const scopeSeg = seg(drums ? [['recorded', 'Recorded kits'], ['all', 'All kits']] : [['recorded', 'Recorded instruments'], ['all', 'Everything']], () => scope, (v) => (scope = v as typeof scope));
  const stemSeg = stem ? seg([['stem', `The separated ${part === 'other' ? 'melodic parts' : part}`], ['mix', 'The full mix']], () => (useStem ? 'stem' : 'mix'), (v) => (useStem = v === 'stem')) : null;
  const start = h('button', { class: 'btn btn-primary btn-block' }, icon('search', 15), 'Find');
  const body = h(
    'div',
    { class: 'finder' },
    h('p', null, drums ? 'Plays this drum part on every kit and ranks them by how close they sound to the original.' : 'Plays this track’s notes on every instrument and ranks them by how close they sound to the original: the overtones, the attack and decay, and how the notes move, ignoring plain EQ differences.'),
    h('div', { class: 'finder-opts' }, h('span', { class: 'lbl' }, 'Try'), scopeSeg, ...(stemSeg ? [h('span', { class: 'lbl' }, 'Against'), stemSeg] : [])),
    status,
    progress,
    start,
    list,
  );
  const m = modal(drums ? `Find the kit · ${t0.name}` : `Find the instrument · ${t0.name}`, body, {
    wide: true,
    onClose: () => {
      ctrl?.abort();
      const t = track();
      if (!kept && t && t.instrument !== original) store.update(() => (t.instrument = original));
      if (engine.playing) engine.stop();
    },
  });

  const listen = (id: string) => {
    const t = track();
    if (!t) return;
    store.update(() => (t.instrument = id));
    void engine.unlock().then(() => {
      engine.seek(span.from);
      engine.play();
    });
    list.querySelectorAll('.finder-row').forEach((r) => r.classList.toggle('on', (r as HTMLElement).dataset.id === id));
  };
  const show = (res: FinderResult[]) => {
    list.replaceChildren();
    if (!res.length) {
      list.append(h('p', null, 'Nothing could be tried (the recordings could not be downloaded?).'));
      return;
    }
    const best = res[0].score;
    const worst = res[Math.min(res.length - 1, 15)].score;
    res.slice(0, 12).forEach((r, i) => {
      const close = Math.max(0.05, 1 - (r.score - best) / Math.max(0.5, worst - best));
      list.append(
        h(
          'div',
          { class: 'finder-row', 'data-id': r.id },
          h('span', { class: 'finder-rank' }, String(i + 1)),
          h('span', { class: 'finder-name' }, r.label, h('small', null, r.group + (r.recorded ? ' · recorded' : ''))),
          h('span', { class: 'finder-meter' }, h('span', { style: { width: `${Math.round(close * 100)}%` } })),
          h('button', { class: 'btn btn-ghost', title: 'Play the stretch with this sound (B compares with the original)', onclick: () => listen(r.id) }, icon('play', 13), 'Listen'),
          h('button', { class: 'btn', onclick: () => {
            const t = track();
            if (t) store.update(() => (t.instrument = r.id));
            kept = true;
            m.close();
            toast(`${t0.name} now uses ${r.label}`, 'ok');
          } }, 'Use'),
        ),
      );
    });
  };

  start.addEventListener('click', async () => {
    if (ctrl) {
      ctrl.abort();
      return;
    }
    ctrl = new AbortController();
    start.replaceChildren(icon('close', 15), 'Stop');
    progress.hidden = false;
    list.replaceChildren();
    const cands = finderCandidates(t0, scope === 'recorded').map((c) => c.id);
    try {
      const res = await findInstrument({
        song: store.song,
        trackId,
        from: span.from,
        to: span.to,
        reference: useStem && stem ? stem : engine.backingBuffer!,
        offset: store.song.audioOffset,
        candidates: cands,
        signal: ctrl.signal,
        onProgress: (done, total, label) => {
          bar.style.width = `${Math.round((done / total) * 100)}%`;
          status.textContent = label ? `Tried ${done} of ${total}: ${label}` : 'Done.';
        },
      });
      status.textContent = `Closest ${drums ? 'kits' : 'sounds'} for bars ${barOf(span.from)}–${barOf(span.to) - 1}. Listen to a few (press B to flip to the original), then keep one.`;
      show(res);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') status.textContent = `Couldn't finish: ${(e as Error).message}`;
      else status.textContent = 'Stopped.';
    } finally {
      ctrl = null;
      progress.hidden = true;
      start.replaceChildren(icon('search', 15), 'Find again');
    }
  });
}
