/**
 * Automation: per-track curves (breakpoints in ticks) for mixer and effect settings. Between
 * points the value moves in a straight line (on a log scale for filter cutoffs); before the first
 * point it holds the first value, after the last it holds the last.
 */
import { HPF_OFF, LPF_OFF, type AutoParam, type AutoPoint, type Track } from './types';

export interface AutoParamDef {
  id: AutoParam;
  label: string;
  min: number;
  max: number;
  /** Frequencies: interpolate and draw on a log scale. */
  log?: boolean;
  /** The track's value when this lane has no points. */
  base(t: Track): number;
  fmt(v: number): string;
}

const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);

export const AUTO_PARAMS: AutoParamDef[] = [
  { id: 'volume', label: 'Volume', min: 0, max: 1.5, base: (t) => t.volume, fmt: (v) => `${Math.round(v * 100)}%` },
  { id: 'pan', label: 'Pan', min: -1, max: 1, base: (t) => t.pan, fmt: (v) => (Math.abs(v) < 0.02 ? 'C' : `${Math.round(Math.abs(v) * 100)}${v < 0 ? 'L' : 'R'}`) },
  { id: 'lpf', label: 'High cut', min: 100, max: LPF_OFF, log: true, base: (t) => t.lpf ?? LPF_OFF, fmt: (v) => (v >= LPF_OFF * 0.99 ? 'open' : hz(v)) },
  { id: 'hpf', label: 'Low cut', min: HPF_OFF, max: 5000, log: true, base: (t) => t.hpf ?? HPF_OFF, fmt: (v) => (v <= HPF_OFF * 1.01 ? 'open' : hz(v)) },
  { id: 'reverb', label: 'Reverb', min: 0, max: 1, base: (t) => t.reverb, fmt: (v) => `${Math.round(v * 100)}%` },
  { id: 'echo', label: 'Echo', min: 0, max: 1, base: (t) => t.echo ?? 0, fmt: (v) => `${Math.round(v * 100)}%` },
];

export const AUTO_BY_ID = new Map(AUTO_PARAMS.map((p) => [p.id, p]));

/** 0..1 position of a value on the lane (log for frequencies). */
export function toUnit(def: AutoParamDef, v: number): number {
  if (def.log) return Math.log(Math.max(def.min, v) / def.min) / Math.log(def.max / def.min);
  return (v - def.min) / (def.max - def.min);
}

export function fromUnit(def: AutoParamDef, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return def.log ? def.min * Math.pow(def.max / def.min, x) : def.min + x * (def.max - def.min);
}

/** The automated value at a tick (points must be sorted by tick). */
export function valueAt(def: AutoParamDef, pts: AutoPoint[], tick: number): number {
  if (!pts.length) return def.min;
  if (tick <= pts[0].tick) return pts[0].value;
  const last = pts[pts.length - 1];
  if (tick >= last.tick) return last.value;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].tick <= tick) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const f = b.tick === a.tick ? 1 : (tick - a.tick) / (b.tick - a.tick);
  return fromUnit(def, toUnit(def, a.value) + f * (toUnit(def, b.value) - toUnit(def, a.value)));
}

/** The track's lanes that have points. */
export function lanes(t: Track): [AutoParamDef, AutoPoint[]][] {
  const out: [AutoParamDef, AutoPoint[]][] = [];
  if (!t.automation) return out;
  for (const def of AUTO_PARAMS) {
    const pts = t.automation[def.id];
    if (pts?.length) out.push([def, pts]);
  }
  return out;
}
