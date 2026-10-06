/**
 * After an automatic remake, write everything out in one go: the project, MIDI (a file per track),
 * an MP3 of the remake, the lyrics as .lrc, optionally the separated parts, the music video, and a
 * report of what was found. In the desktop app the files go straight into a folder; in a browser
 * they download.
 */
import { renderSong, encodeWav } from '../audio/render';
import { encodeMp3 } from '../audio/mp3';
import { ensureSongSamplesStrict } from '../audio/samples';
import type { AudioEngine } from '../audio/engine';
import { toLrc } from '../core/lyrics';
import type { Store } from '../core/store';
import { cloneSong } from '../core/types';
import { exportVideo } from '../visual/exporter';
import type { Actions } from './actions';
import { desktop } from './desktop';
import { downloadBlob, safeName } from './dom';

export interface ExportAllOptions {
  video: boolean;
  /** Also write the separated parts (drums, bass, melody, vocals) as WAVs. */
  stems: boolean;
}

export interface ExportAllContext {
  store: Store;
  engine: AudioEngine;
  actions: Actions;
}

/** Save one output: into the folder (desktop) or as a download. Returns where it went. */
async function save(outDir: string | null, name: string, blob: Blob): Promise<string> {
  const app = desktop();
  if (app && outDir) return app.writeFile(outDir, name, new Uint8Array(await blob.arrayBuffer()));
  await downloadBlob(blob, name);
  return name;
}

export async function exportEverything(
  c: ExportAllContext,
  outDir: string | null,
  o: ExportAllOptions,
  report: string[],
  step: (label: string, fraction: number) => void,
  signal: AbortSignal,
): Promise<string[]> {
  const { store, engine, actions } = c;
  const song = store.song;
  // Readable names in the folder (the song's own name), safe on every file system.
  const base = song.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || safeName(song.name);
  const files: string[] = [];
  const stopIf = () => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  // The outputs are the remake alone: the original is only there to compare with.
  const backingVolume = engine.backingVolume;
  engine.backingVolume = 0;
  try {
    step('Saving the project…', 0);
    const project = await actions.projectFile();
    files.push(await save(outDir, `${base}.${project.name.endsWith('.zip') ? 'beatmaker.zip' : 'beatmaker.json'}`, project.blob));
    const midi = await actions.midiZip();
    if (midi) files.push(await save(outDir, `${base} - MIDI.zip`, midi.blob));
    if (song.lyrics?.length) files.push(await save(outDir, `${base}.lrc`, new Blob([toLrc(song, song.lyrics, true)], { type: 'text/plain' })));
    stopIf();

    // Every recorded sound must be in before anything is rendered (a stand-in would be heard).
    step('Loading every recorded sound…', 0.05);
    const missing = await ensureSongSamplesStrict(song.tracks.filter((t) => !t.mute));
    if (missing.length) report.push(`Warning: ${missing.join(', ')} couldn't be downloaded, so the audio and video use synth stand-ins for ${missing.length === 1 ? 'it' : 'them'}`);
    stopIf();

    step('Rendering the MP3…', 0.1);
    const audio = await renderSong(cloneSong(song), { from: 0, to: engine.songEndSec(), tail: 2 });
    stopIf();
    const mp3 = await encodeMp3(audio, 256, (f) => step('Encoding the MP3…', 0.1 + 0.1 * f));
    files.push(await save(outDir, `${base}.mp3`, mp3));
    stopIf();

    if (o.stems && engine.stems) {
      const names: Record<string, string> = { drums: 'Drums', bass: 'Bass', other: 'Melody and chords', vocals: 'Vocals' };
      for (const [k, buf] of Object.entries(engine.stems)) {
        if (!buf) continue;
        step(`Saving the separated ${names[k]?.toLowerCase() ?? k}…`, 0.2);
        files.push(await save(outDir, `${base} - original ${names[k] ?? k}.wav`, encodeWav(buf)));
      }
    }

    if (o.video) {
      const v = store.visual;
      store.setVisual({ exportRange: 'song' });
      step('Recording the video (it plays the song through once)…', 0.25);
      const job = exportVideo(store, engine, actions.player, (p, pos, total) => step(`Recording the video: ${Math.round(pos)} of ${Math.round(total)} s`, 0.25 + 0.7 * p));
      const onAbort = () => job.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await job.done;
        stopIf();
        if (res) files.push(await save(outDir, `${base}.${res.ext}`, res.blob));
      } finally {
        signal.removeEventListener('abort', onAbort);
        store.setVisual({ exportRange: v.exportRange });
      }
    }

    step('Writing the report…', 0.97);
    const text = [
      `Beatmaker: automatic remake of ${engine.backingName || song.name}`,
      `Made ${new Date().toLocaleString()}`,
      '',
      ...report.map((l) => `- ${l}`),
      '',
      'Files:',
      ...files.map((f) => `- ${f.split(/[\\/]/).pop()}`),
      '',
      'Open the project (.zip) in Beatmaker to change anything: notes, instruments, mix, lyrics, video look.',
    ].join('\n');
    files.push(await save(outDir, `${base} - report.txt`, new Blob([text], { type: 'text/plain' })));
    step('Done', 1);
    return files;
  } finally {
    engine.backingVolume = backingVolume;
  }
}
