import type { AudioEngine } from '../audio/engine';
import { AB_BANDS } from '../audio/abmeter';
import { h, icon } from './dom';

/**
 * The A/B compare panel: which side you hear, the loudness match, and the two spectra (shape only,
 * each centred on its own level) with their difference, averaged over the last few seconds.
 */
export class AbPanel {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLElement;
  private seg: HTMLElement;
  private matchBox: HTMLInputElement;
  private lastDraw = 0;

  constructor(private engine: AudioEngine) {
    this.canvas = h('canvas', { class: 'ab-canvas', width: 480, height: 220 }) as HTMLCanvasElement;
    this.readout = h('p', { class: 'ab-readout' }, 'Play the song to measure both sides.');
    const side = (mode: 'original' | 'off' | 'remake', label: string) =>
      h('button', { class: 'seg-btn', 'data-mode': mode, onclick: () => engine.setAb(mode) }, label);
    this.seg = h('div', { class: 'seg ab-seg' }, side('original', 'Original'), side('off', 'Both'), side('remake', 'Remake'));
    this.matchBox = h('input', { type: 'checkbox', checked: engine.abMatch }) as HTMLInputElement;
    this.matchBox.addEventListener('change', () => {
      engine.abMatch = this.matchBox.checked;
      engine.applySynthMute();
    });
    this.el = h(
      'div',
      { class: 'ab-panel', hidden: true, role: 'dialog', 'aria-label': 'A/B compare' },
      h('div', { class: 'ab-head' }, h('strong', null, 'A/B compare'), h('span', { class: 'ab-key' }, 'B switches sides'), h('button', { class: 'icon-btn sm', 'aria-label': 'Close', onclick: () => this.close() }, icon('close', 14))),
      this.seg,
      h('label', { class: 'ab-check' }, this.matchBox, 'Match the original’s loudness to the remake'),
      this.canvas,
      h('div', { class: 'ab-legend' }, h('span', { class: 'ab-sw orig' }), 'Original', h('span', { class: 'ab-sw mix' }), 'Remake', h('span', { class: 'ab-sw diff' }), 'Remake − original'),
      this.readout,
    );
    this.sync();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    this.sync();
  }

  close(): void {
    this.el.hidden = true;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  sync(): void {
    for (const b of this.seg.querySelectorAll<HTMLElement>('.seg-btn')) b.classList.toggle('on', b.dataset.mode === this.engine.ab);
    this.matchBox.checked = this.engine.abMatch;
  }

  /** Redraw a few times a second while open. */
  frame(): void {
    if (!this.isOpen) return;
    const now = performance.now();
    if (now - this.lastDraw < 250) return;
    this.lastDraw = now;
    const db = this.engine.abMatchDb();
    this.readout.textContent =
      db === null
        ? 'Play the song (or a loop) to measure both sides.'
        : `The original is ${Math.abs(db).toFixed(1)} dB ${db > 0 ? 'quieter' : 'louder'} than the remake${this.engine.abMatch ? ', matched while you listen to it' : ''}.`;
    this.draw();
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 480;
    const hgt = c.clientHeight || 220;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(document.documentElement);
    const col = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const line = col('--line', '#232a3d');
    const dim = col('--dim', '#626985');
    const top = hgt * 0.64;
    const x = (f: number) => (Math.log(f / AB_BANDS[0]) / Math.log(AB_BANDS[AB_BANDS.length - 1] / AB_BANDS[0])) * w;
    // Grid: octaves and the zero line of the difference strip.
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.fillStyle = dim;
    g.font = '10px system-ui, sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.beginPath();
      g.moveTo(x(f), 0);
      g.lineTo(x(f), hgt);
      g.stroke();
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x(f) + 3, hgt - 4);
    }
    const zeroY = top + (hgt - top) / 2;
    g.beginPath();
    g.moveTo(0, zeroY);
    g.lineTo(w, zeroY);
    g.stroke();
    const sp = this.engine.meter?.spectra();
    if (!sp) return;
    const centre = (b: Float64Array) => {
      let sum = 0;
      let n = 0;
      b.forEach((v, i) => {
        const f = Math.sqrt(AB_BANDS[i] * AB_BANDS[i + 1]);
        if (f >= 60 && f <= 10000) {
          sum += v;
          n++;
        }
      });
      const m = n ? sum / n : 0;
      return Array.from(b, (v) => v - m);
    };
    const mix = centre(sp.mix);
    const ref = centre(sp.ref);
    const mid = (i: number) => Math.sqrt(AB_BANDS[i] * AB_BANDS[i + 1]);
    const yTop = (db: number) => top * 0.5 - db * (top / 60);
    const curve = (vals: number[], y: (v: number) => number, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(x(mid(i)), y(v)) : g.moveTo(x(mid(i)), y(v))));
      g.stroke();
    };
    curve(ref, yTop, col('--accent-2', '#ff4fa3'), 1.6);
    curve(mix, yTop, col('--accent', '#3de0ff'), 1.6);
    const diff = mix.map((v, i) => Math.max(-12, Math.min(12, v - ref[i])));
    curve(diff, (v) => zeroY - v * ((hgt - top) / 2 / 12), col('--text', '#e9ecf6'), 1.2);
    g.fillStyle = dim;
    g.fillText('±12 dB', 4, top + 12);
  }
}
