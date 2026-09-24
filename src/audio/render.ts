import { Timeline } from '../core/timing';
import type { Song } from '../core/types';
import { loadKit } from './drums';
import { buildEvents, Graph, NoteScheduler, type KitBuffers } from './graph';

export interface RenderOptions {
  from: number;
  to: number;
  tail: number;
  sampleRate?: number;
  backing?: AudioBuffer | null;
  backingVolume?: number;
}

/** Render a song (or part of it) faster than real time with an OfflineAudioContext. */
export async function renderSong(song: Song, opts: RenderOptions): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 44100;
  const tl = new Timeline(song);
  const length = Math.max(0.1, opts.to - opts.from + opts.tail);
  const ctx = new OfflineAudioContext(2, Math.ceil(length * sr), sr);
  const graph = new Graph(ctx);
  graph.applyMix(song, false);
  graph.out.connect(ctx.destination);
  const kits: KitBuffers = new Map();
  for (const id of new Set(song.tracks.filter((t) => t.kind === 'drums').map((t) => t.instrument))) {
    kits.set(id, await loadKit(id, sr));
  }
  const sched = new NoteScheduler(graph, kits);
  for (const ev of buildEvents(song, tl)) {
    if (ev.t < opts.from || ev.t >= opts.to) continue;
    sched.play(ev.track, ev.note.pitch, ev.note.vel, ev.t - opts.from, Math.max(0.02, ev.end - ev.t), ev.glideFrom);
  }
  if (opts.backing) {
    graph.synthBus.gain.value = song.synthsWithAudio ? 1 : 0;
    graph.backing.gain.value = opts.backingVolume ?? 1;
    const src = ctx.createBufferSource();
    src.buffer = opts.backing;
    src.connect(graph.backing);
    const pos = opts.from - song.audioOffset;
    if (pos >= 0) src.start(0, pos);
    else src.start(-pos, 0);
  }
  return ctx.startRendering();
}

/** Encode an AudioBuffer as a 16-bit PCM WAV file. */
export function encodeWav(buf: AudioBuffer): Blob {
  const ch = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const bytes = 44 + len * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
