/**
 * Vocal tracks: a recording (the original's separated vocals, or your own take) played in time with
 * the song by a sampler track, as one long note that starts where the recording lines up.
 */
import type { AudioEngine } from '../audio/engine';
import { encodeWav } from '../audio/render';
import { putFile } from '../core/library';
import type { Store } from '../core/store';
import { Timeline } from '../core/timing';
import { DEFAULT_SAMPLER, newNoteId, newTrackId, type Song, type Track } from '../core/types';
import { h, icon, modal, pickFile, toast } from './dom';
import { showLyrics } from './lyricsui';
import { separateButton } from './separateui';

export interface VocalOptions {
  name: string;
  /** The stored sound (else the buffer is stored as WAV). */
  fileId?: string;
  /** The recording runs in time with the original (it starts where the original starts), rather than from bar 1. */
  withOriginal: boolean;
}

/** A sampler track playing the whole recording in time with the song. */
export async function vocalTrack(buf: AudioBuffer, song: Song, color: string, o: VocalOptions): Promise<Track> {
  const id = o.fileId ?? (await putFile(`${o.name}.wav`, await encodeWav(buf).arrayBuffer()));
  const tl = new Timeline(song);
  // Song time 0 is `-audioOffset` seconds into the original.
  const lead = o.withOriginal ? Math.max(0, -song.audioOffset) : 0;
  const at = o.withOriginal ? Math.max(0, song.audioOffset) : 0;
  const startTick = Math.round(tl.secToTick(at));
  const dur = buf.duration - lead;
  return {
    id: newTrackId(),
    name: o.name.slice(0, 40),
    kind: 'synth',
    instrument: 'sampler',
    color,
    volume: 0.8,
    pan: 0,
    reverb: 0,
    // The sampler follows the song's tuning; cancel it so the vocals stay as recorded.
    tune: -(song.tuning ?? 0),
    mute: false,
    solo: false,
    visible: true,
    sampler: { ...DEFAULT_SAMPLER, file: id, name: o.name, mode: 'pitch', root: 60, start: lead / buf.duration, end: 1, attack: 0.005, release: 0.2 },
    notes: [{ id: newNoteId(), pitch: 60, start: startTick, dur: Math.max(1, Math.round(tl.secToTick(at + dur)) - startTick), vel: 1 }],
  };
}

/** "Vocal track…": the original's vocals (once separated) or a recording of your own. */
export function newVocalTrack(store: Store, engine: AudioEngine, color: string): void {
  const hasOriginal = !!engine.backingBuffer || store.song.audioOffset !== 0;
  let withOriginal = hasOriginal;
  const add = async (make: () => Promise<Track | null>) => {
    try {
      const t = await make();
      if (!t) return;
      store.update((s) => s.tracks.push(t));
      store.setUI({ selectedTrackId: t.id });
      await engine.ensureKits();
      m.close();
      toast(`Added “${t.name}”`, 'ok');
    } catch (e) {
      toast(`Couldn't add the vocals: ${(e as Error).message}`, 'error', 4500);
    }
  };
  const fromStems = h(
    'button',
    {
      class: 'btn btn-block',
      onclick: () => {
        const vocals = engine.stems?.vocals;
        if (vocals) void add(async () => vocalTrack(vocals, store.song, color, { name: 'Vocals (original)', withOriginal: true }));
      },
    },
    icon('wave', 15),
    'The original’s vocals',
  ) as HTMLButtonElement;
  const sepStatus = h('p', { class: 'section-note' });
  let sep: ReturnType<typeof separateButton> | null = null;
  if (!engine.stems?.vocals) {
    fromStems.disabled = true;
    sep = separateButton(engine, sepStatus, () => {
      sep?.el.remove();
      fromStems.disabled = false;
    });
  }
  const align = h('input', { type: 'checkbox', checked: withOriginal, disabled: !hasOriginal }) as HTMLInputElement;
  align.addEventListener('change', () => (withOriginal = align.checked));
  const fromFile = h(
    'button',
    {
      class: 'btn btn-block',
      onclick: () =>
        void add(async () => {
          const f = await pickFile('audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac');
          if (!f) return null;
          const data = await f.arrayBuffer();
          const ctx = new OfflineAudioContext(2, 1, 44100);
          const buf = await ctx.decodeAudioData(data.slice(0));
          const fileId = await putFile(f.name, data);
          return vocalTrack(buf, store.song, color, { name: f.name.replace(/\.[a-z0-9]+$/i, ''), fileId, withOriginal });
        }),
    },
    icon('upload', 15),
    'A recording of your own…',
  );
  const body = h(
    'div',
    { class: 'remake' },
    h('p', null, 'A vocal track plays a recording in time with the song. Add lyrics (Visual tab → Lyrics, or below) and they show in the video as they are sung.'),
    fromStems,
    ...(sep ? [sep.el, sepStatus] : []),
    fromFile,
    h('label', { class: 'remake-opt' + (hasOriginal ? '' : ' off') }, align, h('span', null, h('strong', null, 'It lines up with the original'), h('small', null, 'Starts where the original recording starts (a take sung over the original, or its vocals). Otherwise it starts at bar 1.'))),
    h('button', { class: 'btn btn-ghost btn-block', onclick: () => (m.close(), showLyrics(store, engine)) }, icon('mic', 15), 'Lyrics…'),
  );
  const m = modal('Vocal track', body, { onClose: () => sep?.stop() });
}
