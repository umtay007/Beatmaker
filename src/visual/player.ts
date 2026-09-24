import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import { ensureFont } from './fonts';
import { Post } from './post';
import { Scene } from './scene';
import { aspectSize } from './settings';

/** Owns the preview canvas and draws a frame of the visualizer for the current song position. */
export class VisualPlayer {
  readonly scene = new Scene();
  readonly post = new Post();
  readonly frame: HTMLDivElement;
  bgImage: HTMLImageElement | null = null;
  /** Set while exporting: fixed output size and transition range. */
  exportState: { w: number; h: number; start: number; end: number } | null = null;
  private lastTime = performance.now();
  private lastFonts = '';

  constructor(
    private store: Store,
    private engine: AudioEngine,
    private host: HTMLElement,
  ) {
    this.frame = document.createElement('div');
    this.frame.className = 'stage-frame';
    this.frame.append(this.post.canvas);
    this.post.canvas.setAttribute('aria-label', 'Visualizer preview');
    this.post.canvas.setAttribute('role', 'img');
    host.append(this.frame);
    new ResizeObserver(() => this.fit()).observe(host);
    store.on('visual', () => {
      this.fit();
      this.loadFonts();
    });
    this.loadFonts();
  }

  private loadFonts(): void {
    const v = this.store.visual;
    const key = v.titleFont + '|' + v.chordFont;
    if (key === this.lastFonts) return;
    this.lastFonts = key;
    void ensureFont(v.titleFont);
    void ensureFont(v.chordFont);
  }

  /** Fit the preview frame into the stage, keeping the output aspect ratio. */
  fit(): void {
    const v = this.store.visual;
    const r = this.host.getBoundingClientRect();
    const style = getComputedStyle(this.host);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const aw = Math.max(50, r.width - padX);
    const ah = Math.max(50, r.height - padY);
    const [a, b] = v.aspect.split(':').map(Number);
    let w = aw;
    let hgt = (aw * b) / a;
    if (hgt > ah) {
      hgt = ah;
      w = (ah * a) / b;
    }
    this.frame.style.width = `${Math.floor(w)}px`;
    this.frame.style.height = `${Math.floor(hgt)}px`;
    if (!this.exportState) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      let pw = Math.round(w * dpr);
      let ph = Math.round(hgt * dpr);
      const max = 1600;
      if (Math.max(pw, ph) > max) {
        const s = max / Math.max(pw, ph);
        pw = Math.round(pw * s);
        ph = Math.round(ph * s);
      }
      this.setSize(pw, ph);
    }
  }

  private setSize(w: number, h: number): void {
    this.scene.setSize(w, h);
    this.post.setSize(w, h);
  }

  beginExport(start: number, end: number): { w: number; h: number } {
    const v = this.store.visual;
    const size = aspectSize(v.aspect, v.exportRes);
    this.exportState = { ...size, start, end };
    this.setSize(size.w, size.h);
    return size;
  }

  endExport(): void {
    this.exportState = null;
    this.fit();
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const store = this.store;
    const engine = this.engine;
    const v = store.visual;
    const t = engine.position();
    const songEnd = engine.songEndSec();
    let transition: { start: number; end: number } | null = null;
    if (this.exportState) transition = { start: this.exportState.start, end: this.exportState.end };
    else if (engine.playing && v.transition) {
      const loop = engine.loopRange();
      transition = loop ? null : { start: 0, end: songEnd };
    }
    const wantAudio = v.spectrum !== 'off' || v.particleReact || v.showPlayhead;
    this.scene.render({
      t,
      dt,
      song: store.song,
      songVersion: store.songVersion,
      timeline: engine.timeline,
      v,
      visualVersion: store.visualVersion,
      spectrum: wantAudio && engine.playing ? engine.spectrum() : null,
      wave: v.spectrum === 'wave' && engine.playing ? engine.waveform() : null,
      bgImage: this.bgImage,
      transition,
      songEnd,
    });
    this.post.render(this.scene.canvas, v, dt);
  }
}
