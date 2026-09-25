import { EQ_BANDS } from '../audio/analyze';
import type { Store } from '../core/store';
import { DEFAULT_MASTER } from '../core/types';
import type { Actions } from './actions';
import { h, icon, modal, toast } from './dom';

const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

/** A small bar chart of octave-band levels (dB). */
function bandChart(values: number[], centre = false): HTMLElement {
  const lo = centre ? -12 : Math.min(-18, ...values);
  const hi = centre ? 12 : Math.max(6, ...values);
  return h(
    'div',
    { class: 'band-chart' },
    values.map((v, i) => {
      const pct = ((v - lo) / (hi - lo)) * 100;
      return h(
        'div',
        { class: 'band', title: `${hz(EQ_BANDS[i])} Hz: ${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
        h('div', { class: 'band-bar' }, h('i', { style: { height: `${Math.max(2, Math.min(100, pct))}%` } })),
        h('span', null, hz(EQ_BANDS[i])),
      );
    }),
  );
}

/** Show what the reference's mix sounds like it was made with, and offer to match it. */
export function showSoundReport(actions: Actions): void {
  const report = actions.analyzeReference();
  if (!report) return;
  const r = report;
  const kv = (k: string, v: string) => h('div', { class: 'kv' }, h('span', null, k), h('b', null, v));
  const w = r.width;
  const status = h('p', { class: 'section-note' });
  const matchBtn = h('button', { class: 'btn btn-primary' }, icon('sparkle', 15), 'Match my mix to it') as HTMLButtonElement;
  const body = h(
    'div',
    { class: 'sound-report' },
    h('p', { class: 'section-note' }, 'What the mix engineer did, measured from the audio. It can’t tell which plugins were used, only what they did to the sound.'),
    h('ul', { class: 'report-notes' }, (r.notes.length ? r.notes : ['Nothing unusual: a balanced, moderately processed mix.']).map((n) => h('li', null, n))),
    h('h3', null, 'Tonal balance (EQ curve)'),
    bandChart(r.bands),
    h('h3', null, 'Measurements'),
    kv('Loudness', `${r.loudness.rmsDb} dBFS RMS · peak ${r.loudness.peakDb} dBFS`),
    kv('Compression', `crest ${r.loudness.crestDb} dB · range ${r.loudness.rangeDb} dB`),
    kv('Stereo width', `${w.all.toFixed(0)} dB (bass ${w.low.toFixed(0)}, mids ${w.mid.toFixed(0)}, highs ${w.high.toFixed(0)})`),
    kv('Reverb', r.reverb !== null ? `about ${r.reverb.toFixed(1)} s` : 'no clean tail to measure'),
    kv('Echo / delay', r.echo ? `${r.echo.label} (×${r.echo.strength})` : 'none found'),
    kv('Bass saturation', r.bassHarmonics ? `harmonics ${r.bassHarmonics.map((d, i) => `H${i + 2} ${d}`).join(' · ')} dB` : 'no exposed bass'),
    kv('Sidechain pumping', r.pump !== null ? `${r.pump} dB on the beat` : 'none'),
    h('p', { class: 'section-note' }, 'Match renders your song, compares it with the same stretch of the original (up to 30 s), and sets the master EQ, stereo width and level to close the gap. It also copies the reverb length and any echo timing. If the original has vocals, first set the loop to an instrumental part (an intro, break or outro): vocals would otherwise pull the EQ towards the mids.'),
    status,
    h('div', { class: 'btn-row' }, matchBtn),
  );
  const m = modal('Sound analysis', body, { wide: true });
  matchBtn.onclick = async () => {
    matchBtn.disabled = true;
    try {
      const changes = await actions.matchMix(r, (msg) => (status.textContent = msg));
      status.replaceChildren(h('b', null, 'Applied: '), changes.join(' · '));
      toast('Mix matched to the original (undo with Ctrl+Z)', 'ok', 4000);
    } catch (e) {
      status.textContent = `Couldn't match: ${(e as Error).message}`;
    } finally {
      matchBtn.disabled = false;
    }
  };
  void m;
}

/** Vertical sliders for the master graphic EQ. */
export function eqEditor(store: Store): { el: HTMLElement; refresh: () => void } {
  const inputs: HTMLInputElement[] = [];
  const el = h(
    'div',
    { class: 'eq-editor' },
    EQ_BANDS.map((f, i) => {
      const r = h('input', { type: 'range', class: 'range eq-range', min: -12, max: 12, step: 0.5, 'aria-label': `EQ ${hz(f)} Hz` }) as HTMLInputElement;
      r.addEventListener('pointerdown', () => store.beginGesture());
      r.addEventListener('input', () => {
        const s = store.song;
        s.master ??= { ...DEFAULT_MASTER, eq: [...DEFAULT_MASTER.eq] };
        s.master.eq[i] = Number(r.value);
        r.title = `${hz(f)} Hz: ${Number(r.value) > 0 ? '+' : ''}${r.value} dB`;
        store.touch();
      });
      r.addEventListener('dblclick', () => {
        store.update((s) => {
          if (s.master) s.master.eq[i] = 0;
        });
        r.value = '0';
      });
      inputs.push(r);
      return h('label', { class: 'eq-band' }, r, h('span', null, hz(f)));
    }),
  );
  const refresh = () => {
    const eq = store.song.master?.eq ?? DEFAULT_MASTER.eq;
    inputs.forEach((r, i) => {
      if (document.activeElement !== r) r.value = String(eq[i] ?? 0);
      r.title = `${hz(EQ_BANDS[i])} Hz: ${eq[i] > 0 ? '+' : ''}${eq[i]} dB (double-click to reset)`;
    });
  };
  refresh();
  return { el, refresh };
}
