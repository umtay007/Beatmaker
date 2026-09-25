import type { AudioEngine } from '../audio/engine';
import { detectSlices, guessBeats, loadSamplerFile, MAX_SLICES, samplerBuffer, SLICE_BASE, sliceBounds } from '../audio/sampler';
import { putFile } from '../core/library';
import type { Store } from '../core/store';
import { noteName } from '../core/theory';
import { BEATS_PER_BAR, DEFAULT_SAMPLER, newNoteId, newTrackId, PPQ, STEP, type Note, type SamplerSettings, type Track } from '../core/types';
import { rangeField, segField, selectField, toggleField, type Bound } from './controls';
import { h, icon, modal, pickFile, toast } from './dom';

const ACCEPT = 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a';

/** Store a sound in the library and work out sensible sampler settings for it. */
async function importSound(store: Store, engine: AudioEngine, file: File): Promise<SamplerSettings | null> {
  const data = await file.arrayBuffer();
  const ctx = await engine.unlock();
  let dur: number;
  try {
    dur = (await ctx.decodeAudioData(data.slice(0))).duration; // decodeAudioData detaches its input
  } catch {
    toast(`“${file.name}” isn't an audio format this browser can read`, 'error', 4000);
    return null;
  }
  const id = await putFile(file.name, data);
  const buf = await loadSamplerFile(id);
  if (!buf) return null;
  const bpm = store.song.bpm;
  const beats = guessBeats(dur, bpm);
  // Loops are a whole number of beats long at some tempo near the song's; longer phrases get chopped.
  const onGrid = Math.abs(Math.log2((dur * bpm) / 60 / beats)) < 0.1;
  const named = file.name.toLowerCase();
  const mode = /loop|break/.test(named) || (dur >= 1.5 && onGrid && beats >= 2) ? 'loop' : dur >= 1.5 || /chop|phrase|vocal|vox/.test(named) ? 'slice' : 'pitch';
  return { ...DEFAULT_SAMPLER, file: id, name: file.name, mode, beats, points: detectSlices(buf, 0, buf.duration, 16) };
}

/** Notes that play the whole song with the loop, back to back. */
function loopNotes(s: SamplerSettings, bars: number): Note[] {
  const len = Math.round(s.beats * PPQ);
  const total = bars * BEATS_PER_BAR * PPQ;
  const out: Note[] = [];
  for (let t = 0; t < total; t += len) out.push({ id: newNoteId(), pitch: 60, start: t, dur: Math.min(len, total - t), vel: 0.85 });
  return out;
}

/** Notes that play every chop once, where it falls in the original (at `beats` beats long). */
function chopNotes(s: SamplerSettings, buf: AudioBuffer): Note[] {
  const b = sliceBounds(s, buf);
  const span = b[b.length - 1] - b[0];
  const at = (sec: number) => Math.round((((sec - b[0]) / span) * s.beats * PPQ) / STEP) * STEP;
  const out: Note[] = [];
  for (let i = 0; i < b.length - 1; i++) {
    const start = at(b[i]);
    const end = Math.max(start + STEP, at(b[i + 1]));
    if (out.length && out[out.length - 1].start === start) continue; // two chops on one step
    out.push({ id: newNoteId(), pitch: SLICE_BASE + i, start, dur: end - start, vel: 0.85 });
  }
  return out;
}

/** Pick a sound and add a sampler track playing it. */
export async function newSamplerTrack(store: Store, engine: AudioEngine, color: string): Promise<void> {
  const file = await pickFile(ACCEPT);
  if (!file) return;
  const s = await importSound(store, engine, file);
  if (!s) return;
  const buf = samplerBuffer(s.file)!;
  const t: Track = {
    id: newTrackId(),
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'Sampler',
    kind: 'synth',
    instrument: 'sampler',
    color,
    volume: 0.8,
    pan: 0,
    reverb: 0.1,
    mute: false,
    solo: false,
    visible: true,
    sampler: s,
    notes: s.mode === 'loop' ? loopNotes(s, store.song.bars) : s.mode === 'slice' ? chopNotes(s, buf) : [],
  };
  store.update((song) => song.tracks.push(t));
  store.setUI({ selectedTrackId: t.id });
  showSamplerEditor(store, engine, t.id);
}

/** Load a (new) sound into an existing track, making it a sampler track. */
export async function replaceSamplerSound(store: Store, engine: AudioEngine, trackId: string): Promise<boolean> {
  const file = await pickFile(ACCEPT);
  if (!file) return false;
  const s = await importSound(store, engine, file);
  if (!s) return false;
  store.update((song) => {
    const t = song.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const keep = t.instrument === 'sampler' && t.sampler ? { mode: t.sampler.mode, gain: t.sampler.gain, attack: t.sampler.attack, release: t.sampler.release } : {};
    t.kind = 'synth';
    t.instrument = 'sampler';
    t.sampler = { ...s, ...keep };
  });
  return true;
}

/** Edit a sampler track: its sound, how it plays (pitched, chopped or looped), trim and envelope. */
export function showSamplerEditor(store: Store, engine: AudioEngine, trackId: string): void {
  const cur = () => store.song.tracks.find((x) => x.id === trackId);
  const s = () => cur()?.sampler;
  const set = (fn: (s: SamplerSettings) => void) => {
    const x = s();
    if (x) fn(x);
  };

  const canvas = h('canvas', { class: 'sampler-wave', height: 120, 'aria-label': 'Waveform (click a chop to hear it)' }) as HTMLCanvasElement;
  const nameEl = h('b', { class: 'sampler-name' });
  const info = h('p', { class: 'section-note' });
  const fields: Bound[] = [];
  const add = <T extends Bound>(b: T) => (fields.push(b), b);

  const audition = (i?: number) => {
    const t = cur();
    const x = s();
    const buf = x && samplerBuffer(x.file);
    if (!t || !x || !buf) return;
    const region = (x.end - x.start) * buf.duration;
    if (x.mode === 'slice') {
      const b = sliceBounds(x, buf);
      const k = i ?? 0;
      engine.preview(t, SLICE_BASE + k, 0.9, b[k + 1] - b[k]);
    } else if (x.mode === 'loop') engine.preview(t, 60, 0.9, (x.beats * 60) / store.song.bpm);
    else engine.preview(t, x.root, 0.9, region);
  };

  const mode = add(segField('Plays', { options: [['pitch', 'Pitched'], ['slice', 'Chopped'], ['loop', 'Loop']], get: () => s()?.mode ?? 'pitch', set: (v) => store.update(() => set((x) => (x.mode = v as SamplerSettings['mode']))) }));
  const root = add(selectField('Root note', {
    options: Array.from({ length: 73 }, (_, i) => [String(24 + i), noteName(24 + i)] as [string, string]),
    get: () => String(s()?.root ?? 60),
    set: (v) => store.update(() => set((x) => (x.root = Number(v)))),
    help: 'The key that plays the sound at its own pitch',
  }));
  const chops = add(selectField('Chops', {
    options: [['auto', 'At the hits (auto)'], ['4', '4 equal'], ['8', '8 equal'], ['16', '16 equal'], ['32', '32 equal']],
    get: () => (s()?.points?.length ? 'auto' : String(s()?.slices ?? 8)),
    set: (v) =>
      store.update(() =>
        set((x) => {
          const buf = samplerBuffer(x.file);
          if (v === 'auto' && buf) x.points = detectSlices(buf, x.start * buf.duration, x.end * buf.duration, 16);
          else {
            x.points = undefined;
            x.slices = Number(v);
          }
        }),
      ),
  }));
  const beats = add(selectField('Length', {
    options: () => {
      const x = s();
      const buf = x && samplerBuffer(x.file);
      const sec = x && buf ? (x.end - x.start) * buf.duration : 0;
      return [1, 2, 4, 8, 16, 32, 64].map((b) => [String(b), `${b} beat${b > 1 ? 's' : ''}${sec ? ` (${Math.round((b * 60) / sec)} BPM)` : ''}`] as [string, string]);
    },
    get: () => String(s()?.beats ?? 4),
    set: (v) => store.update(() => set((x) => (x.beats = Number(v)))),
    help: 'How many beats the sound spans: sets the loop speed, and where chops land when written into the track',
  }));
  const writeChops = h('button', { class: 'btn', onclick: () => {
    const x = s();
    const buf = x && samplerBuffer(x.file);
    if (!x || !buf) return;
    store.update(() => {
      const t = cur();
      if (t) t.notes = chopNotes(x, buf);
    });
    toast('Chops written from the start of the song: rearrange them in the piano roll', 'ok', 3500);
  } }, icon('music', 15), 'Write the chops into the track');
  const fillLoop = h('button', { class: 'btn', onclick: () => {
    const x = s();
    if (!x) return;
    store.update((song) => {
      const t = cur();
      if (t) t.notes = loopNotes(x, song.bars);
    });
  } }, icon('loop', 15), 'Fill the song with the loop');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const gesture = { onStart: () => store.beginGesture(), onEnd: () => store.endGesture() };
  const start = add(rangeField('Start', { min: 0, max: 0.99, step: 0.001, get: () => s()?.start ?? 0, set: (v) => (set((x) => (x.start = Math.min(v, x.end - 0.01))), store.touch()), format: pct, ...gesture }));
  const end = add(rangeField('End', { min: 0.01, max: 1, step: 0.001, get: () => s()?.end ?? 1, set: (v) => (set((x) => (x.end = Math.max(v, x.start + 0.01))), store.touch()), format: pct, ...gesture }));
  const gain = add(rangeField('Level', { min: -24, max: 12, step: 0.5, get: () => s()?.gain ?? 0, set: (v) => (set((x) => (x.gain = v)), store.touch()), format: (v) => `${v > 0 ? '+' : ''}${v} dB`, ...gesture }));
  const attack = add(rangeField('Attack', { min: 0, max: 0.5, step: 0.001, get: () => s()?.attack ?? 0, set: (v) => (set((x) => (x.attack = v)), store.touch()), format: (v) => `${Math.round(v * 1000)} ms`, ...gesture }));
  const release = add(rangeField('Release', { min: 0.005, max: 2, step: 0.005, get: () => s()?.release ?? 0.05, set: (v) => (set((x) => (x.release = v)), store.touch()), format: (v) => `${Math.round(v * 1000)} ms`, ...gesture }));
  const rev = add(toggleField('Reverse', { get: () => !!s()?.reverse, set: (v) => store.update(() => set((x) => (x.reverse = v))) }));

  const pitchOnly = h('div', null, root.el);
  const sliceOnly = h('div', null, chops.el, h('div', { class: 'btn-row' }, writeChops));
  const loopOnly = h('div', null, h('div', { class: 'btn-row' }, fillLoop));

  const draw = () => {
    const x = s();
    const buf = x && samplerBuffer(x.file);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, canvas.clientWidth || 640);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(120 * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, 120);
    if (!x || !buf) {
      g.fillStyle = '#626985';
      g.font = '12px system-ui';
      g.fillText('This sound is not saved in this browser: load it again with “Replace sound…”.', 12, 64);
      return;
    }
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    const per = buf.length / w;
    const mid = 60;
    for (let px = 0; px < w; px++) {
      let lo = 0;
      let hi = 0;
      const a = Math.floor(px * per);
      const b = Math.min(buf.length, Math.floor((px + 1) * per));
      for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 64))) {
        let v = 0;
        for (const ch of chans) v += ch[x.reverse ? buf.length - 1 - i : i];
        v /= chans.length;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const inside = px / w >= x.start && px / w <= x.end;
      g.fillStyle = inside ? '#3de0ff' : '#2f3752';
      g.fillRect(px, mid - hi * 56, 1, Math.max(1, (hi - lo) * 56));
    }
    // Trim shading, then chop markers or beat lines.
    g.fillStyle = 'rgba(10, 12, 18, 0.55)';
    g.fillRect(0, 0, x.start * w, 120);
    g.fillRect(x.end * w, 0, w - x.end * w, 120);
    g.font = '10px system-ui';
    if (x.mode === 'slice') {
      const bounds = sliceBounds(x, buf);
      bounds.slice(0, -1).forEach((sec, i) => {
        const px = (sec / buf.duration) * w;
        g.fillStyle = '#ff4fa3';
        g.fillRect(px, 0, 1, 120);
        g.fillText(noteName(SLICE_BASE + i), px + 3, 11);
      });
    } else if (x.mode === 'loop') {
      g.fillStyle = 'rgba(233, 236, 246, 0.25)';
      for (let k = 1; k < x.beats; k++) g.fillRect((x.start + ((x.end - x.start) * k) / x.beats) * w, 0, 1, 120);
    }
  };

  canvas.addEventListener('click', (e) => {
    const x = s();
    const buf = x && samplerBuffer(x.file);
    if (!x || !buf) return;
    if (x.mode !== 'slice') return audition();
    const r = canvas.getBoundingClientRect();
    const sec = ((e.clientX - r.left) / r.width) * buf.duration;
    const b = sliceBounds(x, buf);
    const i = b.findIndex((v, k) => k < b.length - 1 && sec >= v && sec < b[k + 1]);
    if (i >= 0) audition(i);
  });

  const refresh = () => {
    const x = s();
    const buf = x && samplerBuffer(x.file);
    if (!cur()) return m.close();
    nameEl.textContent = x?.name ?? 'No sound';
    for (const f of fields) f.refresh();
    pitchOnly.style.display = x?.mode === 'pitch' ? '' : 'none';
    sliceOnly.style.display = x?.mode === 'slice' ? '' : 'none';
    loopOnly.style.display = x?.mode === 'loop' ? '' : 'none';
    beats.el.style.display = x?.mode === 'pitch' ? 'none' : '';
    if (x && buf) {
      const n = sliceBounds(x, buf).length - 1;
      info.textContent =
        x.mode === 'pitch'
          ? `${buf.duration.toFixed(2)} s · plays at its own pitch on ${noteName(x.root)}.`
          : x.mode === 'slice'
            ? `${n} chop${n === 1 ? '' : 's'} on ${noteName(SLICE_BASE)}–${noteName(SLICE_BASE + Math.min(n, MAX_SLICES) - 1)}. Click one to hear it; each note cuts off the one before.`
            : `Stretched to ${store.song.bpm} BPM by playback speed (${Math.round(((x.end - x.start) * buf.duration * 100) / ((x.beats * 60) / store.song.bpm)) / 100}×), so its pitch moves with it.`;
    } else info.textContent = '';
    draw();
  };

  const body = h(
    'div',
    { class: 'sampler-editor' },
    h(
      'div',
      { class: 'sampler-head' },
      nameEl,
      h('button', { class: 'btn btn-ghost', onclick: () => audition() }, icon('play', 14), 'Play'),
      h('button', { class: 'btn btn-ghost', onclick: async () => {
        if (await replaceSamplerSound(store, engine, trackId)) refresh();
      } }, icon('upload', 14), 'Replace sound…'),
    ),
    canvas,
    info,
    mode.el,
    pitchOnly,
    beats.el,
    sliceOnly,
    loopOnly,
    h('div', { class: 'sampler-grid' }, start.el, end.el, gain.el, attack.el, release.el, rev.el),
  );
  const off = store.on('song', refresh);
  const m = modal(`Sampler · ${cur()?.name ?? ''}`, body, { wide: true, onClose: () => void off() });
  requestAnimationFrame(refresh);
}
