export type Direction = 'rtl' | 'ttb';
export type NoteStyle = 'solid' | 'outline' | 'gradient' | 'neon' | 'line';
export type MarkerShape = 'none' | 'circle' | 'diamond' | 'star' | 'heart' | 'square' | 'emoji';
export type HitEffect = 'ripple' | 'spark' | 'flare' | 'pluck' | 'pulse' | 'none';
export type ParticleStyle = 'sparkles' | 'dust' | 'comets' | 'snow' | 'twinkle' | 'bubbles';
export type Anchor = 'tl' | 'tc' | 'tr' | 'center' | 'bl' | 'bc' | 'br';

export interface VisualSettings {
  preset: string;
  aspect: '16:9' | '9:16' | '1:1' | '4:5';

  direction: Direction;
  playheadPos: number;
  showPlayhead: boolean;
  playheadColor: string;
  /** Seconds visible across the time axis. */
  window: number;
  drumLayout: 'band' | 'pitch' | 'hidden';
  pitchSpacing: 'compact' | 'true';
  drumBandSize: number;
  showGrid: boolean;
  gridOpacity: number;

  palette: string;
  noteStyle: NoteStyle;
  noteThickness: number;
  roundness: number;
  futureOpacity: number;
  pastOpacity: number;
  activeGlow: number;
  marker: MarkerShape;
  markerEmoji: string;
  markerSize: number;
  hitEffect: HitEffect;
  hitStrength: number;
  linkNotes: boolean;

  bgMode: 'solid' | 'gradient' | 'image';
  bgColor: string;
  bgColor2: string;
  bgAngle: number;
  bgImageOpacity: number;

  particles: boolean;
  particleStyle: ParticleStyle;
  particleCount: number;
  particleSize: number;
  particleSpeed: number;
  particleDirection: number;
  particleColor: string;
  particleOpacity: number;
  particleReact: boolean;

  camera: boolean;
  cameraSource: string;
  cameraTrigger: 'kick' | 'snare' | 'all';
  shake: number;
  zoomPunch: number;

  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  grade: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  vignette: number;
  distortion: 'none' | 'fisheye' | 'pincushion';
  distortionAmount: number;
  chroma: number;
  grain: number;
  scanlines: number;

  title: boolean;
  titleText: string;
  subtitleText: string;
  titleFont: string;
  titleSize: number;
  titleColor: string;
  titlePos: Anchor;
  titleAnim: 'fade' | 'slide' | 'type' | 'none';
  titleHold: number;

  chord: boolean;
  chordSource: string;
  chordFont: string;
  chordSize: number;
  chordColor: string;
  chordPos: Anchor;

  spectrum: 'off' | 'bars' | 'wave' | 'circle';
  spectrumColor: string;
  spectrumSize: number;
  progress: boolean;

  transition: boolean;
  transitionStyle: 'fade' | 'iris' | 'wipe' | 'zoom';
  transitionDur: number;

  exportRes: number;
  exportFps: number;
  exportFormat: 'mp4' | 'webm';
  exportQuality: 'low' | 'medium' | 'high';
  exportRange: 'song' | 'loop';
  exportLead: number;
  exportTail: number;
}

export const PALETTES: Record<string, { label: string; colors: string[] }> = {
  neon: { label: 'Neon', colors: ['#00e5ff', '#ff3d9a', '#b388ff', '#ffe066', '#3dffb0', '#ff8a3d', '#5c7cff', '#ff5e5e'] },
  aurora: { label: 'Aurora', colors: ['#5ef2c9', '#4fc3f7', '#9d8cff', '#e27dff', '#7dffa1', '#ffd6a5', '#6ee7ff', '#c4b5fd'] },
  candy: { label: 'Candy', colors: ['#ff5fa2', '#ffb703', '#2ec4f1', '#9b5de5', '#00c49a', '#ff7b54', '#f15bb5', '#3a86ff'] },
  sunset: { label: 'Sunset', colors: ['#ff6b6b', '#ffa94d', '#ffd43b', '#f783ac', '#da77f2', '#748ffc', '#ff8787', '#ffc078'] },
  lofi: { label: 'Lo-Fi', colors: ['#f4d58d', '#e6a57e', '#d98f8f', '#8fb996', '#a3c4bc', '#f2e8cf', '#c9ada7', '#e9c46a'] },
  violet: { label: 'Violet', colors: ['#c77dff', '#ff9ef5', '#7b8cff', '#e0aaff', '#ff6fd8', '#9d4edd', '#f3c4fb', '#72efdd'] },
  ocean: { label: 'Ocean', colors: ['#48cae4', '#90e0ef', '#00f5d4', '#4895ef', '#caf0f8', '#56cfe1', '#80ffdb', '#64dfdf'] },
  mono: { label: 'Mono', colors: ['#ffffff', '#cfcfcf', '#a6a6a6', '#e6e6e6', '#bdbdbd', '#f5f5f5', '#8f8f8f', '#dedede'] },
};

export const FONTS = [
  'Inter',
  'Montserrat',
  'Poppins',
  'Bebas Neue',
  'Anton',
  'Oswald',
  'Space Grotesk',
  'Unbounded',
  'Righteous',
  'Bungee',
  'Orbitron',
  'Monoton',
  'Press Start 2P',
  'Permanent Marker',
  'Pacifico',
  'Lobster',
  'Playfair Display',
  'Abril Fatface',
  'Cinzel',
  'JetBrains Mono',
];

export const DEFAULT_VISUAL: VisualSettings = {
  preset: 'neon',
  aspect: '16:9',

  direction: 'rtl',
  playheadPos: 0.38,
  showPlayhead: true,
  playheadColor: '#ffffff',
  window: 7,
  drumLayout: 'band',
  pitchSpacing: 'compact',
  drumBandSize: 0.24,
  showGrid: true,
  gridOpacity: 0.06,

  palette: 'neon',
  noteStyle: 'solid',
  noteThickness: 1,
  roundness: 1,
  futureOpacity: 0.9,
  pastOpacity: 0.28,
  activeGlow: 0.9,
  marker: 'circle',
  markerEmoji: '🔥',
  markerSize: 1,
  hitEffect: 'ripple',
  hitStrength: 1,
  linkNotes: false,

  bgMode: 'gradient',
  bgColor: '#05060f',
  bgColor2: '#170b33',
  bgAngle: 135,
  bgImageOpacity: 0.55,

  particles: true,
  particleStyle: 'sparkles',
  particleCount: 70,
  particleSize: 1,
  particleSpeed: 1,
  particleDirection: 200,
  particleColor: '#bfe9ff',
  particleOpacity: 0.7,
  particleReact: true,

  camera: true,
  cameraSource: 'auto',
  cameraTrigger: 'kick',
  shake: 0.25,
  zoomPunch: 0.35,

  bloom: true,
  bloomStrength: 0.9,
  bloomRadius: 0.6,
  bloomThreshold: 0.35,
  grade: true,
  brightness: 1,
  contrast: 1.05,
  saturation: 1.1,
  hue: 0,
  vignette: 0.35,
  distortion: 'none',
  distortionAmount: 0.3,
  chroma: 0.15,
  grain: 0.04,
  scanlines: 0,

  title: true,
  titleText: 'Untitled Beat',
  subtitleText: 'prod. by you',
  titleFont: 'Unbounded',
  titleSize: 1,
  titleColor: '#ffffff',
  titlePos: 'bl',
  titleAnim: 'slide',
  titleHold: 0,

  chord: true,
  chordSource: 'auto',
  chordFont: 'Space Grotesk',
  chordSize: 1,
  chordColor: '#ffffff',
  chordPos: 'tr',

  spectrum: 'off',
  spectrumColor: '#ffffff',
  spectrumSize: 1,
  progress: true,

  transition: true,
  transitionStyle: 'iris',
  transitionDur: 1.2,

  exportRes: 1080,
  exportFps: 30,
  exportFormat: 'mp4',
  exportQuality: 'high',
  exportRange: 'song',
  exportLead: 0.5,
  exportTail: 2,
};

type Partial2 = Partial<VisualSettings>;

export interface VisualPreset {
  id: string;
  label: string;
  settings: Partial2;
}

export const PRESETS: VisualPreset[] = [
  { id: 'neon', label: 'Neon Pulse', settings: {} },
  {
    id: 'aurora',
    label: 'Aurora Flow',
    settings: {
      palette: 'aurora',
      bgMode: 'gradient',
      bgColor: '#021a1f',
      bgColor2: '#0b1a3a',
      bgAngle: 160,
      noteStyle: 'gradient',
      noteThickness: 0.9,
      marker: 'none',
      hitEffect: 'pluck',
      particleStyle: 'dust',
      particleColor: '#a7fff0',
      particleDirection: 270,
      particleCount: 90,
      linkNotes: true,
      bloomStrength: 1.1,
      bloomRadius: 0.8,
      saturation: 1.15,
      chroma: 0.05,
      transitionStyle: 'fade',
      titleFont: 'Montserrat',
      chordFont: 'Montserrat',
    },
  },
  {
    id: 'candy',
    label: 'Candy Pop',
    settings: {
      palette: 'candy',
      bgMode: 'gradient',
      bgColor: '#fff1f7',
      bgColor2: '#e3f4ff',
      bgAngle: 120,
      noteStyle: 'solid',
      noteThickness: 1.1,
      marker: 'heart',
      markerSize: 1.2,
      hitEffect: 'spark',
      particleStyle: 'bubbles',
      particleColor: '#ff8fc7',
      particleOpacity: 0.45,
      particleDirection: 270,
      playheadColor: '#ff5fa2',
      pastOpacity: 0.3,
      futureOpacity: 1,
      bloom: false,
      bloomStrength: 0.35,
      bloomThreshold: 0.9,
      vignette: 0.1,
      chroma: 0,
      grain: 0,
      titleColor: '#3b1f4a',
      chordColor: '#3b1f4a',
      titleFont: 'Righteous',
      chordFont: 'Righteous',
      spectrumColor: '#ff5fa2',
      transitionStyle: 'wipe',
    },
  },
  {
    id: 'lofi',
    label: 'Lo-Fi Tape',
    settings: {
      palette: 'lofi',
      bgMode: 'gradient',
      bgColor: '#1b1411',
      bgColor2: '#2b1d17',
      bgAngle: 90,
      noteStyle: 'outline',
      noteThickness: 0.9,
      roundness: 0.3,
      marker: 'square',
      markerSize: 0.8,
      hitEffect: 'pulse',
      particleStyle: 'dust',
      particleColor: '#ffe3b3',
      particleOpacity: 0.4,
      particleSpeed: 0.4,
      bloomStrength: 0.55,
      saturation: 0.85,
      contrast: 0.95,
      hue: -0.02,
      vignette: 0.6,
      distortion: 'fisheye',
      distortionAmount: 0.18,
      chroma: 0.3,
      grain: 0.28,
      scanlines: 0.25,
      playheadColor: '#ffe3b3',
      titleFont: 'Permanent Marker',
      chordFont: 'JetBrains Mono',
      titleColor: '#ffe9c7',
      chordColor: '#ffe9c7',
      transitionStyle: 'fade',
    },
  },
  {
    id: 'mono',
    label: 'Minimal Mono',
    settings: {
      palette: 'mono',
      bgMode: 'solid',
      bgColor: '#000000',
      noteStyle: 'line',
      noteThickness: 0.9,
      marker: 'circle',
      markerSize: 0.7,
      hitEffect: 'flare',
      particles: false,
      showGrid: true,
      gridOpacity: 0.09,
      bloomStrength: 0.6,
      saturation: 0,
      chroma: 0,
      vignette: 0.2,
      titleFont: 'Inter',
      chordFont: 'Inter',
      transitionStyle: 'wipe',
      shake: 0,
      zoomPunch: 0.2,
    },
  },
  {
    id: 'sunrise',
    label: 'Morning Sky',
    settings: {
      palette: 'sunset',
      bgMode: 'gradient',
      bgColor: '#2a1b3d',
      bgColor2: '#d9737b',
      bgAngle: 180,
      noteStyle: 'solid',
      noteThickness: 1,
      marker: 'star',
      markerSize: 1.2,
      hitEffect: 'spark',
      particleStyle: 'twinkle',
      particleColor: '#fff4d6',
      particleCount: 110,
      bloomStrength: 0.55,
      bloomThreshold: 0.82,
      saturation: 1.05,
      titleFont: 'Playfair Display',
      chordFont: 'Playfair Display',
      transitionStyle: 'fade',
    },
  },
  {
    id: 'violet',
    label: 'Mystic Violet',
    settings: {
      palette: 'violet',
      bgMode: 'gradient',
      bgColor: '#0a0118',
      bgColor2: '#2a0548',
      bgAngle: 200,
      noteStyle: 'neon',
      noteThickness: 0.95,
      marker: 'diamond',
      markerSize: 1.1,
      hitEffect: 'flare',
      particleStyle: 'comets',
      particleColor: '#e7c6ff',
      particleCount: 40,
      particleDirection: 215,
      bloomStrength: 1.3,
      bloomRadius: 0.75,
      distortion: 'fisheye',
      distortionAmount: 0.35,
      chroma: 0.35,
      vignette: 0.5,
      titleFont: 'Cinzel',
      chordFont: 'Cinzel',
    },
  },
  {
    id: 'keys',
    label: 'Falling Keys',
    settings: {
      direction: 'ttb',
      playheadPos: 0.82,
      window: 5,
      palette: 'ocean',
      bgMode: 'gradient',
      bgColor: '#020b16',
      bgColor2: '#06243b',
      bgAngle: 180,
      noteStyle: 'solid',
      noteThickness: 0.85,
      roundness: 0.6,
      marker: 'none',
      hitEffect: 'spark',
      particleStyle: 'snow',
      particleColor: '#d6f4ff',
      particleDirection: 90,
      particleCount: 80,
      drumBandSize: 0.22,
      bloomStrength: 1,
      titlePos: 'tl',
      chordPos: 'tr',
      titleFont: 'Poppins',
      chordFont: 'Poppins',
      spectrum: 'off',
    },
  },
  {
    id: 'club',
    label: 'Club Spectrum',
    settings: {
      palette: 'neon',
      bgMode: 'gradient',
      bgColor: '#000000',
      bgColor2: '#1a0010',
      bgAngle: 90,
      noteStyle: 'neon',
      noteThickness: 0.9,
      marker: 'emoji',
      markerEmoji: '⚡',
      hitEffect: 'ripple',
      particleStyle: 'sparkles',
      spectrum: 'bars',
      spectrumColor: '#ff3d9a',
      bloomStrength: 1.2,
      shake: 0.5,
      zoomPunch: 0.6,
      chroma: 0.4,
      titleFont: 'Bebas Neue',
      chordFont: 'Bebas Neue',
      titleSize: 1.3,
    },
  },
];

export function presetSettings(id: string, keep: VisualSettings): VisualSettings {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  // Keep content & export settings when switching looks.
  const preserved: Partial2 = {
    aspect: keep.aspect,
    titleText: keep.titleText,
    subtitleText: keep.subtitleText,
    title: keep.title,
    chord: keep.chord,
    chordSource: keep.chordSource,
    cameraSource: keep.cameraSource,
    exportRes: keep.exportRes,
    exportFps: keep.exportFps,
    exportFormat: keep.exportFormat,
    exportQuality: keep.exportQuality,
    exportRange: keep.exportRange,
    exportLead: keep.exportLead,
    exportTail: keep.exportTail,
  };
  return { ...DEFAULT_VISUAL, ...p.settings, ...preserved, preset: p.id };
}

export function aspectSize(aspect: VisualSettings['aspect'], shortEdge: number): { w: number; h: number } {
  const [a, b] = aspect.split(':').map(Number);
  let w: number;
  let h: number;
  if (a >= b) {
    h = shortEdge;
    w = Math.round((shortEdge * a) / b);
  } else {
    w = shortEdge;
    h = Math.round((shortEdge * b) / a);
  }
  // Video encoders want even dimensions.
  return { w: w - (w % 2), h: h - (h % 2) };
}

/**
 * Merge saved or imported visual settings over the defaults, keeping only known keys whose value
 * has the default's type, so a stale or hand-edited file can't break the renderer.
 */
export function mergeVisual(saved: unknown): VisualSettings {
  const out: Record<string, unknown> = { ...DEFAULT_VISUAL };
  if (!saved || typeof saved !== 'object') return out as unknown as VisualSettings;
  for (const [k, def] of Object.entries(DEFAULT_VISUAL)) {
    const v = (saved as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  if (!/^\d+:\d+$/.test(String(out.aspect))) out.aspect = DEFAULT_VISUAL.aspect;
  return out as unknown as VisualSettings;
}
