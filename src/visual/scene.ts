import { detectChord, DRUM_VOICES, keyPrefersFlats } from '../core/theory';
import type { Timeline } from '../core/timing';
import type { Song, Track } from '../core/types';
import type { Anchor, VisualSettings } from './settings';

// ---------------------------------------------------------------------------------------------
// Helpers

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: RGB = [255, 255, 255];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hash = (n: number) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shapePath(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'diamond':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case 'square':
      ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
      break;
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r * 1.15 : r * 0.5;
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'heart': {
      const s = r * 1.05;
      ctx.moveTo(x, y + s * 0.9);
      ctx.bezierCurveTo(x - s * 1.4, y - s * 0.1, x - s * 0.7, y - s * 1.2, x, y - s * 0.45);
      ctx.bezierCurveTo(x + s * 0.7, y - s * 1.2, x + s * 1.4, y - s * 0.1, x, y + s * 0.9);
      ctx.closePath();
      break;
    }
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

// ---------------------------------------------------------------------------------------------
// Precomputed note geometry

interface VNote {
  t0: number;
  t1: number;
  /** Pitch-axis position 0..1 (0 = low). */
  u: number;
  /** Lane size along the pitch axis, in 0..1 units. */
  lane: number;
  /** Full note thickness along the pitch axis, in 0..1 units. */
  thick: number;
  rgb: RGB;
  vel: number;
  id: number;
  drum: boolean;
  trackIdx: number;
  /** Index of the next note in the same track (for link lines). */
  next: number;
}

interface Prepared {
  key: string;
  notes: VNote[];
  maxDur: number;
  triggers: { t: number; vel: number; id: number }[];
  chordTracks: Track[];
  bandSplit: number;
}

const DRUM_ORDER = DRUM_VOICES.map((v) => v.pitch); // kick first (bottom lane)

function prepare(song: Song, tl: Timeline, v: VisualSettings, key: string): Prepared {
  const visible = song.tracks.filter((t) => t.visible);
  const synth = visible.filter((t) => t.kind === 'synth');
  const drums = v.drumLayout === 'hidden' ? [] : visible.filter((t) => t.kind === 'drums');

  // Pitch range for melodic notes (and drums when laid out by pitch).
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of synth) for (const n of t.notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  if (v.drumLayout === 'pitch') for (const t of drums) for (const n of t.notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  if (!Number.isFinite(lo)) {
    lo = 48;
    hi = 72;
  }
  // Pitch → lane position. "Compact" squeezes big empty gaps (e.g. between an 808 and a lead)
  // so notes stay thick; "true" keeps real intervals.
  const usedPitches = new Set<number>();
  for (const t of synth) for (const n of t.notes) usedPitches.add(n.pitch);
  if (v.drumLayout === 'pitch') for (const t of drums) for (const n of t.notes) usedPitches.add(n.pitch);
  const sortedPitches = [...usedPitches].sort((a, b) => a - b);
  const lanePos = new Map<number, number>();
  let span: number;
  const pad = 1.5;
  if (v.pitchSpacing === 'compact' && sortedPitches.length) {
    let pos = 0;
    lanePos.set(sortedPitches[0], 0);
    for (let i = 1; i < sortedPitches.length; i++) {
      pos += Math.min(sortedPitches[i] - sortedPitches[i - 1], 3);
      lanePos.set(sortedPitches[i], pos);
    }
    span = Math.max(pos + 1 + pad * 2, 12);
    const extra = (span - (pos + 1)) / 2;
    for (const [p, q] of lanePos) lanePos.set(p, q + extra);
  } else {
    lo -= 2;
    hi += 2;
    const minSpan = 20;
    if (hi - lo < minSpan) {
      const c = (hi + lo) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    span = hi - lo + 1;
    for (const p of sortedPitches) lanePos.set(p, p - lo);
  }

  const usedVoices = DRUM_ORDER.filter((p) => drums.some((t) => t.notes.some((n) => n.pitch === p)));
  const hasBand = v.drumLayout === 'band' && usedVoices.length > 0;
  const hasMelodic = synth.some((t) => t.notes.length > 0) || v.drumLayout === 'pitch';
  const bandSize = hasBand ? (hasMelodic ? Math.max(0.08, Math.min(0.6, v.drumBandSize)) : 1) : 0;
  const gap = hasBand && hasMelodic ? 0.04 : 0;
  const melStart = bandSize + gap;
  const melLen = 1 - melStart;

  const notes: VNote[] = [];
  let maxDur = 0;
  visible.forEach((track, trackIdx) => {
    if (track.kind === 'drums' && v.drumLayout === 'hidden') return;
    const rgb = hexToRgb(track.color);
    const sorted = [...track.notes].sort((a, b) => a.start - b.start);
    const first = notes.length;
    for (const n of sorted) {
      const t0 = tl.tickToSec(n.start);
      const t1 = Math.max(t0 + 0.03, tl.tickToSec(n.start + n.dur));
      let u: number;
      let lane: number;
      const drum = track.kind === 'drums';
      if (drum && hasBand) {
        const row = usedVoices.indexOf(n.pitch);
        if (row < 0) continue;
        lane = bandSize / usedVoices.length;
        u = (row + 0.5) * lane;
      } else {
        lane = melLen / span;
        u = melStart + ((lanePos.get(n.pitch) ?? n.pitch - lo) + 0.5) * lane;
      }
      notes.push({ t0, t1: drum ? t0 + Math.min(t1 - t0, 0.12) : t1, u, lane, thick: Math.min(lane * 0.9, 0.05), rgb, vel: n.vel, id: n.id, drum, trackIdx, next: -1 });
      maxDur = Math.max(maxDur, t1 - t0);
    }
    if (track.kind !== 'drums' && maxPolyphony(track) <= 1) for (let i = first; i < notes.length - 1; i++) notes[i].next = i + 1;
  });
  // Melodic notes: as thick as possible without touching any note that sounds at the same time.
  {
    const mel = notes.filter((n) => !(n.drum && hasBand)).sort((a, b) => a.t0 - b.t0);
    let minGap = Infinity;
    const active: VNote[] = [];
    for (const n of mel) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].t1 <= n.t0 + 0.01) active.splice(i, 1);
      for (const a of active) {
        const g = Math.abs(a.u - n.u);
        if (g > 1e-6 && g < minGap) minGap = g;
      }
      active.push(n);
    }
    const lane = mel.length ? mel[0].lane : 0.05;
    const thick = Math.min(Math.max(lane, Math.min(minGap * 0.82, lane * 4)), 0.06);
    for (const n of mel) n.thick = thick;
  }

  // Sort by start time; remap next indices.
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].t0 - notes[b].t0);
  const inv = new Array(order.length);
  order.forEach((oldIdx, newIdx) => (inv[oldIdx] = newIdx));
  const sortedNotes = order.map((i) => ({ ...notes[i], next: notes[i].next >= 0 ? inv[notes[i].next] : -1 }));

  // Camera triggers.
  let srcTrack = song.tracks.find((t) => t.id === v.cameraSource);
  if (!srcTrack) srcTrack = song.tracks.find((t) => t.kind === 'drums' && t.notes.length) ?? song.tracks.find((t) => t.notes.length);
  const triggers: Prepared['triggers'] = [];
  if (srcTrack) {
    for (const n of srcTrack.notes) {
      if (srcTrack.kind === 'drums') {
        if (v.cameraTrigger === 'kick' && n.pitch !== 36) continue;
        if (v.cameraTrigger === 'snare' && n.pitch !== 38 && n.pitch !== 39) continue;
      }
      triggers.push({ t: tl.tickToSec(n.start), vel: n.vel, id: n.id });
    }
    triggers.sort((a, b) => a.t - b.t);
  }

  // Chord source.
  let chordTracks: Track[];
  const chosen = song.tracks.find((t) => t.id === v.chordSource);
  if (chosen) chordTracks = [chosen];
  else {
    const poly = song.tracks.filter((t) => t.kind === 'synth' && !t.mute && maxPolyphony(t) >= 3);
    chordTracks = poly.length ? poly : song.tracks.filter((t) => t.kind === 'synth' && !t.mute);
  }

  return { key, notes: sortedNotes, maxDur, triggers, chordTracks, bandSplit: hasBand && hasMelodic ? bandSize + gap / 2 : -1 };
}

function maxPolyphony(t: Track): number {
  const ev: [number, number][] = [];
  for (const n of t.notes) ev.push([n.start, 1], [n.start + n.dur, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

// ---------------------------------------------------------------------------------------------

export interface FrameInput {
  t: number;
  dt: number;
  song: Song;
  songVersion: number;
  timeline: Timeline;
  v: VisualSettings;
  visualVersion: number;
  spectrum: Uint8Array | null;
  wave: Uint8Array | null;
  bgImage: HTMLImageElement | null;
  /** Range for intro/outro transitions, or null to disable. */
  transition: { start: number; end: number } | null;
  songEnd: number;
}

export class Scene {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private prepared: Prepared | null = null;
  private particleTime = 0;
  private energy = 0;
  private lastChord: { name: string; notes: string[]; since: number; at: number } | null = null;
  private dotSprite: HTMLCanvasElement | null = null;
  private dotSpriteColor = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
  }

  setSize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private getPrepared(f: FrameInput): Prepared {
    const v = f.v;
    const key = `${f.songVersion}|${v.drumLayout}|${v.drumBandSize}|${v.pitchSpacing}|${v.cameraSource}|${v.cameraTrigger}|${v.chordSource}`;
    if (!this.prepared || this.prepared.key !== key) this.prepared = prepare(f.song, f.timeline, v, key);
    return this.prepared;
  }

  render(f: FrameInput): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const v = f.v;
    const base = Math.min(W, H);
    const t = f.t;
    const P = this.getPrepared(f);
    this.lastV = v;

    // Audio energy (low end) for reactive elements.
    let e = 0;
    if (f.spectrum) {
      for (let i = 1; i < 10; i++) e += f.spectrum[i];
      e /= 9 * 255;
    }
    this.energy += (e - this.energy) * Math.min(1, f.dt * 12);
    this.particleTime += f.dt * v.particleSpeed * (1 + (v.particleReact ? this.energy * 2.5 : 0));

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawBackground(f, W, H);

    // Camera
    let zoom = 0;
    let sx = 0;
    let sy = 0;
    if (v.camera && P.triggers.length) {
      let lo = 0;
      let hi = P.triggers.length;
      const from = t - 0.6;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (P.triggers[m].t < from) lo = m + 1;
        else hi = m;
      }
      for (let i = lo; i < P.triggers.length && P.triggers[i].t <= t; i++) {
        const tr = P.triggers[i];
        const el = t - tr.t;
        zoom += v.zoomPunch * 0.045 * tr.vel * Math.exp(-el * 9);
        const amp = v.shake * base * 0.018 * tr.vel * Math.exp(-el * 11);
        sx += amp * Math.sin(el * 70 + tr.id);
        sy += amp * Math.cos(el * 61 + tr.id * 1.7);
      }
    }
    if (f.transition && v.transition && v.transitionStyle === 'zoom') {
      const d = Math.max(0.05, v.transitionDur);
      const p = easeOut(Math.min(clamp01((t - f.transition.start) / d), clamp01((f.transition.end - t) / d)));
      zoom += (1 - p) * 0.35;
    }
    ctx.translate(W / 2 + sx, H / 2 + sy);
    ctx.scale(1 + zoom, 1 + zoom);
    ctx.translate(-W / 2, -H / 2);

    if (v.particles) this.drawParticles(v, W, H, base);
    this.drawNotes(f, P, W, H, base);
    ctx.restore();

    this.drawOverlays(f, P, W, H, base);
    if (f.transition) this.drawTransition(f, W, H);
  }

  // -------------------------------------------------------------------------------------------

  private drawBackground(f: FrameInput, W: number, H: number): void {
    const ctx = this.ctx;
    const v = f.v;
    if (v.bgMode === 'gradient') {
      const a = (v.bgAngle * Math.PI) / 180;
      const r = Math.hypot(W, H) / 2;
      const cx = W / 2;
      const cy = H / 2;
      const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.addColorStop(0, v.bgColor);
      g.addColorStop(1, v.bgColor2);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = v.bgColor;
    }
    ctx.fillRect(0, 0, W, H);
    if (v.bgMode === 'image' && f.bgImage && f.bgImage.complete && f.bgImage.naturalWidth) {
      const img = f.bgImage;
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const iw = img.naturalWidth * s;
      const ih = img.naturalHeight * s;
      ctx.globalAlpha = v.bgImageOpacity;
      ctx.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
      ctx.globalAlpha = 1;
    }
  }

  private sprite(color: string): HTMLCanvasElement {
    if (this.dotSprite && this.dotSpriteColor === color) return this.dotSprite;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const rgb = hexToRgb(color);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(rgb, 1));
    grad.addColorStop(0.25, rgba(rgb, 0.6));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.dotSprite = c;
    this.dotSpriteColor = color;
    return c;
  }

  private drawParticles(v: VisualSettings, W: number, H: number, base: number): void {
    const ctx = this.ctx;
    const n = Math.round(v.particleCount);
    const pt = this.particleTime;
    const rgb = hexToRgb(v.particleColor);
    const dir = (v.particleDirection * Math.PI) / 180;
    const dx = Math.cos(dir);
    const dy = Math.sin(dir);
    const sprite = this.sprite(v.particleColor);
    const margin = base * 0.1;
    const spanW = W + margin * 2;
    const spanH = H + margin * 2;
    const react = v.particleReact ? this.energy : 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const h1 = hash(i + 1);
      const h2 = hash(i * 3.1 + 7);
      const h3 = hash(i * 7.7 + 3);
      const h4 = hash(i * 1.3 + 11);
      let speed = (0.02 + h3 * 0.05) * base;
      let size = (0.003 + h4 * 0.006) * base * v.particleSize;
      let alpha = v.particleOpacity * (0.35 + 0.65 * h2);
      let px = h1 * spanW + dx * speed * pt;
      let py = h2 * spanH + dy * speed * pt;
      switch (v.particleStyle) {
        case 'comets':
          speed *= 4;
          px = h1 * spanW + dx * speed * pt;
          py = h2 * spanH + dy * speed * pt;
          break;
        case 'snow':
          px += Math.sin(pt * (0.6 + h3) + i) * base * 0.02;
          break;
        case 'bubbles':
          px += Math.sin(pt * (0.8 + h3) + i) * base * 0.015;
          size *= 2.2;
          break;
        case 'twinkle':
          px = h1 * spanW + dx * speed * pt * 0.15;
          py = h2 * spanH + dy * speed * pt * 0.15;
          alpha *= 0.5 + 0.5 * Math.sin(pt * (2 + h3 * 4) + i * 1.7);
          break;
        case 'sparkles':
          alpha *= 0.55 + 0.45 * Math.sin(pt * (1.5 + h4 * 3) + i);
          break;
      }
      const x = (((px % spanW) + spanW) % spanW) - margin;
      const y = (((py % spanH) + spanH) % spanH) - margin;
      alpha = clamp01(alpha * (1 + react * 0.8));
      size *= 1 + react * 0.5;
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      switch (v.particleStyle) {
        case 'sparkles': {
          const s = size * 2.2;
          ctx.fillStyle = rgba(rgb, 1);
          ctx.beginPath();
          ctx.moveTo(x, y - s);
          ctx.quadraticCurveTo(x, y, x + s, y);
          ctx.quadraticCurveTo(x, y, x, y + s);
          ctx.quadraticCurveTo(x, y, x - s, y);
          ctx.quadraticCurveTo(x, y, x, y - s);
          ctx.fill();
          ctx.drawImage(sprite, x - s, y - s, s * 2, s * 2);
          break;
        }
        case 'comets': {
          const len = base * (0.06 + h1 * 0.08);
          const g = ctx.createLinearGradient(x, y, x - dx * len, y - dy * len);
          g.addColorStop(0, rgba(rgb, 1));
          g.addColorStop(1, rgba(rgb, 0));
          ctx.strokeStyle = g;
          ctx.lineWidth = size * 0.8;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - dx * len, y - dy * len);
          ctx.stroke();
          ctx.drawImage(sprite, x - size * 2, y - size * 2, size * 4, size * 4);
          break;
        }
        case 'bubbles':
          ctx.strokeStyle = rgba(rgb, 1);
          ctx.lineWidth = Math.max(1, size * 0.15);
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.stroke();
          break;
        default:
          ctx.drawImage(sprite, x - size * 2, y - size * 2, size * 4, size * 4);
      }
    }
    ctx.restore();
  }

  private drawNotes(f: FrameInput, P: Prepared, W: number, H: number, base: number): void {
    const ctx = this.ctx;
    const v = f.v;
    const t = f.t;
    const rtl = v.direction === 'rtl';
    const timeLen = rtl ? W : H;
    const pitchLen = rtl ? H : W;
    const pps = timeLen / Math.max(1, v.window);
    const ph = timeLen * v.playheadPos;
    const pm = pitchLen * (rtl ? 0.075 : 0.05);
    const pUsable = pitchLen - pm * 2;
    const S = (time: number) => (rtl ? ph + (time - t) * pps : ph - (time - t) * pps);
    const Pp = (u: number) => (rtl ? H - (pm + u * pUsable) : pm + u * pUsable);
    // Visible time window.
    const tA = rtl ? t - ph / pps : t - (timeLen - ph) / pps;
    const tB = rtl ? t + (timeLen - ph) / pps : t + ph / pps;

    // Grid
    if (v.showGrid) {
      const tl = f.timeline;
      const beatSec = 60 / tl.bpmAt(tl.secToTick(Math.max(0, t)));
      const firstBeat = Math.floor(tl.secToTick(Math.max(0, tA)) / 96);
      ctx.save();
      for (let b = firstBeat; ; b++) {
        const bt = tl.rawTickToSec(b * 96);
        if (bt > tB) break;
        if (b < 0 || bt < tA - beatSec) continue;
        const s = S(bt);
        const bar = b % 4 === 0;
        ctx.fillStyle = rgba(WHITE, v.gridOpacity * (bar ? 1.6 : 0.7));
        const lw = bar ? Math.max(1, base * 0.0016) : Math.max(1, base * 0.001);
        if (rtl) ctx.fillRect(s - lw / 2, 0, lw, H);
        else ctx.fillRect(0, s - lw / 2, W, lw);
      }
      if (P.bandSplit > 0) {
        const p = Pp(P.bandSplit);
        ctx.fillStyle = rgba(WHITE, v.gridOpacity * 0.8);
        if (rtl) ctx.fillRect(0, p, W, 1);
        else ctx.fillRect(p, 0, 1, H);
      }
      ctx.restore();
    }

    const notes = P.notes;
    // First candidate by t0 >= tA - maxDur.
    let lo = 0;
    let hi = notes.length;
    const from = tA - P.maxDur - 0.1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (notes[m].t0 < from) lo = m + 1;
      else hi = m;
    }
    let end = lo;
    while (end < notes.length && notes[end].t0 <= tB + 0.1) end++;

    const radiusFor = (thick: number) => (thick / 2) * v.roundness;

    // Link lines
    if (v.linkNotes) {
      ctx.save();
      ctx.lineWidth = Math.max(1, base * 0.0022);
      for (let i = lo; i < end; i++) {
        const n = notes[i];
        if (n.next < 0 || n.drum) continue;
        const m = notes[n.next];
        if (m.t0 - n.t1 > 2.5) continue;
        const a = S(n.t1);
        const b = S(m.t0);
        const pa = Pp(n.u);
        const pb = Pp(m.u);
        const active = t >= n.t1 && t < m.t0;
        ctx.strokeStyle = rgba(n.rgb, active ? 0.8 : t > m.t0 ? v.pastOpacity * 0.8 : v.futureOpacity * 0.45);
        ctx.beginPath();
        if (rtl) {
          ctx.moveTo(a, pa);
          ctx.bezierCurveTo((a + b) / 2, pa, (a + b) / 2, pb, b, pb);
        } else {
          ctx.moveTo(pa, a);
          ctx.bezierCurveTo(pa, (a + b) / 2, pb, (a + b) / 2, pb, b);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    const drawBar = (sA: number, sB: number, p: number, thick: number, r: number) => {
      const s0 = Math.min(sA, sB);
      const len = Math.max(Math.abs(sB - sA), thick * (v.noteStyle === 'line' ? 0.5 : 1));
      if (rtl) roundRect(ctx, s0, p - thick / 2, len, thick, r);
      else roundRect(ctx, p - thick / 2, s0 - (len - Math.abs(sB - sA)), thick, len, r);
    };

    const activeList: number[] = [];
    // Pass 1: inactive notes.
    for (let i = lo; i < end; i++) {
      const n = notes[i];
      if (n.t1 < tA || n.t0 > tB) continue;
      const active = t >= n.t0 && t < n.t1 + (n.drum ? 0.08 : 0);
      if (active) {
        activeList.push(i);
        continue;
      }
      const past = t >= n.t1;
      const alpha = past ? v.pastOpacity : v.futureOpacity;
      const thick = Math.max(2, n.thick * pUsable * v.noteThickness * (v.noteStyle === 'line' ? 0.45 : 1));
      this.paintNote(n, S(n.t0), S(n.t1), Pp(n.u), thick, alpha, 0, radiusFor(thick), drawBar, base, false);
    }
    // Pass 2: active notes with glow + hit effects.
    for (const i of activeList) {
      const n = notes[i];
      const el = t - n.t0;
      const env = Math.exp(-el * 5);
      let thick = Math.max(2, n.thick * pUsable * v.noteThickness * (v.noteStyle === 'line' ? 0.45 : 1));
      if (v.hitEffect === 'pulse') thick *= 1 + 0.55 * v.hitStrength * Math.exp(-el * 8);
      const s0 = S(n.t0);
      const s1 = S(n.t1);
      const p = Pp(n.u);
      // Outer glow
      if (v.activeGlow > 0) {
        ctx.save();
        ctx.globalAlpha = 0.18 * v.activeGlow * (0.5 + env);
        ctx.fillStyle = rgba(n.rgb, 1);
        drawBar(s0, s1, p, thick * 2.2, radiusFor(thick * 2.2));
        ctx.fill();
        ctx.restore();
      }
      this.paintNote(n, s0, s1, p, thick, 1, v.activeGlow * (0.35 + 0.65 * env), radiusFor(thick), drawBar, base, true, el);
    }
    // Hit effects for recently started notes (stateless: derived from time since note-on).
    if (v.hitEffect !== 'none' && v.hitEffect !== 'pulse' && v.hitEffect !== 'pluck') {
      const dur = v.hitEffect === 'spark' ? 0.55 : v.hitEffect === 'flare' ? 0.45 : 0.7;
      let a = lo;
      let b = notes.length;
      const fromT = t - dur;
      while (a < b) {
        const m = (a + b) >> 1;
        if (notes[m].t0 < fromT) a = m + 1;
        else b = m;
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = a; i < notes.length && notes[i].t0 <= t; i++) {
        const n = notes[i];
        const pr = (t - n.t0) / dur;
        if (pr < 0 || pr >= 1) continue;
        const p = Pp(n.u);
        const thick = Math.max(3, n.thick * pUsable * v.noteThickness);
        const x = rtl ? ph : p;
        const y = rtl ? p : ph;
        this.paintHit(v.hitEffect, n, x, y, thick, pr, base, v.hitStrength);
      }
      ctx.restore();
    }

    // Playhead
    if (v.showPlayhead) {
      const rgb = hexToRgb(v.playheadColor);
      const lw = Math.max(1.5, base * 0.0028);
      ctx.save();
      const glow = base * 0.03;
      const g = rtl ? ctx.createLinearGradient(ph - glow, 0, ph + glow, 0) : ctx.createLinearGradient(0, ph - glow, 0, ph + glow);
      g.addColorStop(0, rgba(rgb, 0));
      g.addColorStop(0.5, rgba(rgb, 0.12 + this.energy * 0.15));
      g.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = g;
      if (rtl) ctx.fillRect(ph - glow, 0, glow * 2, H);
      else ctx.fillRect(0, ph - glow, W, glow * 2);
      ctx.fillStyle = rgba(rgb, 0.85);
      if (rtl) ctx.fillRect(ph - lw / 2, 0, lw, H);
      else ctx.fillRect(0, ph - lw / 2, W, lw);
      ctx.restore();
    }
  }

  private paintNote(
    n: VNote,
    sA: number,
    sB: number,
    p: number,
    thick: number,
    alpha: number,
    glow: number,
    radius: number,
    drawBar: (a: number, b: number, p: number, thick: number, r: number) => void,
    base: number,
    active: boolean,
    elapsed = 0,
  ): void {
    const ctx = this.ctx;
    const v = this.lastV!;
    const col = glow > 0 ? mixRgb(n.rgb, WHITE, Math.min(0.85, glow * 0.7)) : n.rgb;
    const rtl = v.direction === 'rtl';
    ctx.globalAlpha = alpha;

    // Pluck: vibrating string while sounding.
    if (active && v.hitEffect === 'pluck' && !n.drum && elapsed < 1.5) {
      const amp = thick * 0.9 * v.hitStrength * Math.exp(-elapsed * 3.5);
      const s0 = Math.min(sA, sB);
      const s1 = Math.max(sA, sB);
      const steps = Math.max(8, Math.min(60, Math.floor((s1 - s0) / 6)));
      ctx.strokeStyle = rgba(col, 1);
      ctx.lineWidth = Math.max(2, thick * 0.55);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const q = i / steps;
        const s = s0 + (s1 - s0) * q;
        const d = amp * Math.sin(Math.PI * q) * Math.sin(elapsed * 38 + q * 2);
        if (rtl) (i === 0 ? ctx.moveTo(s, p + d) : ctx.lineTo(s, p + d));
        else (i === 0 ? ctx.moveTo(p + d, s) : ctx.lineTo(p + d, s));
      }
      ctx.stroke();
      this.paintMarker(sA, p, thick, col, alpha, active, elapsed, base);
      ctx.globalAlpha = 1;
      return;
    }

    switch (n.drum ? (v.noteStyle === 'line' ? 'solid' : v.noteStyle) : v.noteStyle) {
      case 'outline': {
        drawBar(sA, sB, p, thick, radius);
        if (active) {
          ctx.fillStyle = rgba(col, 0.55);
          ctx.fill();
        }
        ctx.strokeStyle = rgba(col, 1);
        ctx.lineWidth = Math.max(1.5, thick * 0.16);
        ctx.stroke();
        break;
      }
      case 'gradient': {
        const g = rtl ? ctx.createLinearGradient(sA, 0, sB, 0) : ctx.createLinearGradient(0, sA, 0, sB);
        g.addColorStop(0, rgba(col, 1));
        g.addColorStop(1, rgba(col, 0.08));
        drawBar(sA, sB, p, thick, radius);
        ctx.fillStyle = g;
        ctx.fill();
        break;
      }
      case 'neon': {
        drawBar(sA, sB, p, thick, radius);
        ctx.fillStyle = rgba(col, active ? 0.45 : 0.18);
        ctx.fill();
        ctx.strokeStyle = rgba(mixRgb(col, WHITE, 0.25), 1);
        ctx.lineWidth = Math.max(1.5, thick * 0.2);
        ctx.stroke();
        break;
      }
      case 'line': {
        const lw = Math.max(1.5, thick * 0.5);
        drawBar(sA, sB, p, lw, lw / 2);
        ctx.fillStyle = rgba(col, 1);
        ctx.fill();
        break;
      }
      default: {
        drawBar(sA, sB, p, thick, radius);
        ctx.fillStyle = rgba(col, 1);
        ctx.fill();
      }
    }
    this.paintMarker(sA, p, thick, col, alpha, active, elapsed, base);
    ctx.globalAlpha = 1;
  }

  private paintMarker(sA: number, p: number, thick: number, col: RGB, alpha: number, active: boolean, elapsed: number, base: number): void {
    const v = this.lastV!;
    if (v.marker === 'none') return;
    const ctx = this.ctx;
    const rtl = v.direction === 'rtl';
    let r = Math.max(base * 0.006, thick * 0.62) * v.markerSize;
    if (active) r *= 1 + 0.7 * Math.exp(-elapsed * 7);
    const x = rtl ? sA : p;
    const y = rtl ? p : sA;
    ctx.globalAlpha = alpha;
    if (v.marker === 'emoji') {
      ctx.font = `${Math.round(r * 2.1)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.markerEmoji || '★', x, y + r * 0.08);
      return;
    }
    shapePath(ctx, v.marker, x, y, r);
    ctx.fillStyle = rgba(active ? mixRgb(col, WHITE, 0.6) : col, 1);
    ctx.fill();
  }

  private paintHit(effect: string, n: VNote, x: number, y: number, thick: number, pr: number, base: number, strength: number): void {
    const ctx = this.ctx;
    const col = mixRgb(n.rgb, WHITE, 0.3);
    const fade = 1 - pr;
    const s = strength * (0.6 + n.vel * 0.6);
    switch (effect) {
      case 'ripple': {
        const r = thick * 0.6 + easeOut(pr) * (thick * 2.8 + base * 0.05) * s;
        ctx.strokeStyle = rgba(col, fade * 0.9);
        ctx.lineWidth = Math.max(1.5, thick * 0.22 * fade);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (pr < 0.35) {
          ctx.fillStyle = rgba(col, (0.35 - pr) * 1.2);
          ctx.beginPath();
          ctx.arc(x, y, thick * (0.8 + pr * 2), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'spark': {
        const count = 7 + Math.floor(hash(n.id) * 6);
        const dist = easeOut(pr) * (base * 0.07 + thick * 1.5) * s;
        ctx.fillStyle = rgba(col, fade);
        ctx.strokeStyle = rgba(col, fade);
        ctx.lineWidth = Math.max(1, thick * 0.12);
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + hash(n.id * 7 + i) * 0.9;
          const d = dist * (0.6 + hash(n.id + i * 13) * 0.6);
          const px = x + Math.cos(a) * d;
          const py = y + Math.sin(a) * d;
          const tail = d * 0.35;
          ctx.moveTo(px, py);
          ctx.lineTo(px - Math.cos(a) * tail, py - Math.sin(a) * tail);
        }
        ctx.stroke();
        break;
      }
      case 'flare': {
        const len = (base * 0.09 + thick * 3) * s * (0.6 + 0.4 * (1 - pr));
        const w = Math.max(1, thick * 0.12);
        const gH = ctx.createLinearGradient(x - len, y, x + len, y);
        gH.addColorStop(0, rgba(col, 0));
        gH.addColorStop(0.5, rgba(col, fade));
        gH.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = gH;
        ctx.fillRect(x - len, y - w / 2, len * 2, w);
        const gV = ctx.createLinearGradient(x, y - len * 0.6, x, y + len * 0.6);
        gV.addColorStop(0, rgba(col, 0));
        gV.addColorStop(0.5, rgba(col, fade * 0.8));
        gV.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = gV;
        ctx.fillRect(x - w / 2, y - len * 0.6, w, len * 1.2);
        const rg = ctx.createRadialGradient(x, y, 0, x, y, thick * 2.2);
        rg.addColorStop(0, rgba(WHITE, fade * 0.9));
        rg.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(x - thick * 2.2, y - thick * 2.2, thick * 4.4, thick * 4.4);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------

  private anchorXY(a: Anchor, W: number, H: number, m: number): { x: number; y: number; align: CanvasTextAlign; vy: -1 | 0 | 1 } {
    switch (a) {
      case 'tl':
        return { x: m, y: m, align: 'left', vy: -1 };
      case 'tc':
        return { x: W / 2, y: m, align: 'center', vy: -1 };
      case 'tr':
        return { x: W - m, y: m, align: 'right', vy: -1 };
      case 'center':
        return { x: W / 2, y: H / 2, align: 'center', vy: 0 };
      case 'bl':
        return { x: m, y: H - m, align: 'left', vy: 1 };
      case 'bc':
        return { x: W / 2, y: H - m, align: 'center', vy: 1 };
      case 'br':
        return { x: W - m, y: H - m, align: 'right', vy: 1 };
    }
  }

  private drawOverlays(f: FrameInput, P: Prepared, W: number, H: number, base: number): void {
    const ctx = this.ctx;
    const v = f.v;
    const t = f.t;
    const m = base * 0.06;

    if (v.spectrum !== 'off') this.drawSpectrum(f, W, H, base);

    if (v.title && (v.titleText || v.subtitleText)) {
      let a = 1;
      let off = 0;
      let chars = Infinity;
      const tt = t;
      if (v.titleAnim !== 'none') {
        const pIn = clamp01((tt - 0.1) / 0.9);
        if (v.titleAnim === 'fade') a = easeOut(pIn);
        if (v.titleAnim === 'slide') {
          a = easeOut(pIn);
          off = (1 - easeOut(pIn)) * base * 0.05;
        }
        if (v.titleAnim === 'type') chars = Math.floor(clamp01((tt - 0.1) / 1.4) * (v.titleText.length + 1));
      }
      if (v.titleHold > 0) a *= 1 - clamp01((tt - v.titleHold) / 0.8);
      if (a > 0.001) {
        const size = base * 0.058 * v.titleSize;
        const sub = size * 0.42;
        const pos = this.anchorXY(v.titlePos, W, H, m);
        const rgb = hexToRgb(v.titleColor);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.textAlign = pos.align;
        ctx.textBaseline = 'alphabetic';
        const text = v.titleText.slice(0, chars);
        const total = size + (v.subtitleText ? sub * 1.6 : 0);
        let y = pos.vy === -1 ? pos.y + size : pos.vy === 1 ? pos.y - (v.subtitleText ? sub * 1.6 : 0) : pos.y - total / 2 + size;
        y += off;
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = size * 0.3;
        ctx.fillStyle = rgba(rgb, 1);
        ctx.font = `700 ${Math.round(size)}px "${v.titleFont}", system-ui, sans-serif`;
        ctx.fillText(text, pos.x, y);
        if (v.subtitleText) {
          ctx.font = `500 ${Math.round(sub)}px "${v.titleFont}", system-ui, sans-serif`;
          ctx.globalAlpha = a * 0.75;
          ctx.fillText(v.subtitleText, pos.x, y + sub * 1.6);
        }
        ctx.restore();
      }
    }

    if (v.chord) {
      const sounding: number[] = [];
      for (const track of P.chordTracks) {
        for (const n of track.notes) {
          const t0 = f.timeline.tickToSec(n.start);
          if (t0 > t) continue;
          if (f.timeline.tickToSec(n.start + n.dur) > t) sounding.push(n.pitch);
        }
      }
      const res = sounding.length >= 2 ? detectChord(sounding, keyPrefersFlats(f.song.key, f.song.scale)) : null;
      if (res) {
        if (!this.lastChord || this.lastChord.name !== res.name) this.lastChord = { name: res.name, notes: res.notes, since: t, at: t };
        else this.lastChord.at = t;
      }
      const lc = this.lastChord;
      if (lc && (t - lc.at < 0.6 || res) && t >= lc.since - 0.05 && t >= 0) {
        const el = Math.max(0, t - lc.since);
        const pop = 1 + 0.12 * Math.exp(-el * 10);
        const size = base * 0.07 * v.chordSize * pop;
        const pos = this.anchorXY(v.chordPos, W, H, m);
        const rgb = hexToRgb(v.chordColor);
        const fadeOut = res ? 1 : clamp01(1 - (t - lc.at) / 0.6);
        ctx.save();
        ctx.globalAlpha = clamp01(el * 8) * fadeOut;
        ctx.textAlign = pos.align;
        ctx.fillStyle = rgba(rgb, 1);
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = size * 0.25;
        ctx.font = `700 ${Math.round(size)}px "${v.chordFont}", system-ui, sans-serif`;
        const y = pos.vy === -1 ? pos.y + size * 0.85 : pos.vy === 1 ? pos.y - size * 0.5 : pos.y;
        ctx.fillText(lc.name, pos.x, y);
        ctx.font = `500 ${Math.round(size * 0.3)}px "${v.chordFont}", system-ui, sans-serif`;
        ctx.globalAlpha *= 0.7;
        ctx.fillText(lc.notes.join(' · '), pos.x, y + size * 0.48);
        ctx.restore();
      }
    }

    if (v.progress && f.songEnd > 0) {
      const p = clamp01(t / f.songEnd);
      const h = Math.max(2, base * 0.004);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, H - h, W, h);
      ctx.fillStyle = rgba(hexToRgb(v.playheadColor), 0.8);
      ctx.fillRect(0, H - h, W * p, h);
    }
  }

  private drawSpectrum(f: FrameInput, W: number, H: number, base: number): void {
    const ctx = this.ctx;
    const v = f.v;
    const rgb = hexToRgb(v.spectrumColor);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (v.spectrum === 'wave') {
      const w = f.wave;
      if (!w) {
        ctx.restore();
        return;
      }
      const y0 = H * 0.86;
      const amp = H * 0.08 * v.spectrumSize;
      ctx.strokeStyle = rgba(rgb, 0.8);
      ctx.lineWidth = Math.max(1.5, base * 0.003);
      ctx.beginPath();
      const step = Math.max(1, Math.floor(w.length / 400));
      for (let i = 0; i < w.length; i += step) {
        const x = (i / (w.length - 1)) * W;
        const y = y0 + ((w[i] - 128) / 128) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    const s = f.spectrum;
    if (!s) {
      ctx.restore();
      return;
    }
    const bars = 56;
    const sr = 48000;
    const binHz = sr / 2 / s.length;
    const vals: number[] = [];
    for (let i = 0; i < bars; i++) {
      const f0 = 35 * Math.pow(14000 / 35, i / bars);
      const f1 = 35 * Math.pow(14000 / 35, (i + 1) / bars);
      const b0 = Math.max(1, Math.floor(f0 / binHz));
      const b1 = Math.max(b0 + 1, Math.floor(f1 / binHz));
      let sum = 0;
      for (let b = b0; b < b1 && b < s.length; b++) sum = Math.max(sum, s[b]);
      vals.push(Math.pow(sum / 255, 1.6));
    }
    if (v.spectrum === 'bars') {
      const bw = W / bars;
      const maxH = H * 0.16 * v.spectrumSize;
      for (let i = 0; i < bars; i++) {
        const h = Math.max(2, vals[i] * maxH);
        ctx.fillStyle = rgba(rgb, 0.25 + vals[i] * 0.6);
        roundRect(ctx, i * bw + bw * 0.18, H - h - H * 0.012, bw * 0.64, h, bw * 0.3);
        ctx.fill();
      }
    } else {
      const cx = W / 2;
      const cy = H / 2;
      const r0 = base * 0.17 * v.spectrumSize;
      ctx.strokeStyle = rgba(rgb, 0.8);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, (Math.PI * 2 * r0) / (bars * 2) * 0.55);
      ctx.beginPath();
      for (let i = 0; i < bars * 2; i++) {
        const val = vals[i < bars ? i : bars * 2 - 1 - i];
        const a = (i / (bars * 2)) * Math.PI * 2 - Math.PI / 2;
        const len = base * 0.012 + val * base * 0.12 * v.spectrumSize;
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTransition(f: FrameInput, W: number, H: number): void {
    const v = f.v;
    if (!v.transition || !f.transition) return;
    const d = Math.max(0.05, v.transitionDur);
    const pin = clamp01((f.t - f.transition.start) / d);
    const pout = clamp01((f.transition.end - f.t) / d);
    const p = easeOut(Math.min(pin, pout));
    if (p >= 1) return;
    const ctx = this.ctx;
    ctx.save();
    switch (v.transitionStyle) {
      case 'iris': {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * p, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'wipe': {
        ctx.globalCompositeOperation = 'destination-in';
        const entering = pin < pout;
        const w = W * p;
        ctx.fillRect(entering ? 0 : W - w, 0, w, H);
        break;
      }
      case 'zoom': {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(0,0,0,${1 - p})`;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      default: {
        ctx.fillStyle = `rgba(0,0,0,${1 - p})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /** The settings of the frame being rendered (for helper methods). */
  lastV: VisualSettings | null = null;
}
