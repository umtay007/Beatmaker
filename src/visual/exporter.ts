import type { AudioEngine } from '../audio/engine';
import type { Store } from '../core/store';
import type { VisualPlayer } from './player';

export interface ExportFormat {
  mime: string;
  ext: 'mp4' | 'webm';
}

const CANDIDATES: Record<'mp4' | 'webm', string[]> = {
  mp4: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
};

export function pickFormat(pref: 'mp4' | 'webm'): ExportFormat | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const order: ('mp4' | 'webm')[] = pref === 'mp4' ? ['mp4', 'webm'] : ['webm', 'mp4'];
  for (const ext of order) {
    for (const mime of CANDIDATES[ext]) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function formatSupport(): { mp4: boolean; webm: boolean } {
  const f = (ext: 'mp4' | 'webm') => {
    if (typeof MediaRecorder === 'undefined') return false;
    return CANDIDATES[ext].some((m) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch {
        return false;
      }
    });
  };
  return { mp4: f('mp4'), webm: f('webm') };
}

export interface ExportJob {
  cancel(): void;
  done: Promise<{ blob: Blob; ext: string } | null>;
}

/**
 * Real-time video export: plays the song while recording the visualizer canvas and the master
 * audio bus with MediaRecorder.
 */
export function exportVideo(
  store: Store,
  engine: AudioEngine,
  player: VisualPlayer,
  onProgress: (p: number, pos: number, total: number) => void,
): ExportJob {
  let cancelled = false;
  let progressTimer = 0;
  let finishEnded: (() => void) | null = null;

  const cleanup = () => {
    clearInterval(progressTimer);
    engine.onEnded = null;
    engine.exportMode = false;
    player.endExport();
  };

  const run = async (): Promise<{ blob: Blob; ext: string } | null> => {
    const v = store.visual;
    const fmt = pickFormat(v.exportFormat);
    if (!fmt) throw new Error('Video recording is not supported in this browser.');
    await engine.unlock();
    if (!engine.streamDest) throw new Error('Audio capture is not supported in this browser.');
    if (cancelled) return null;
    engine.stop();
    engine.exportMode = true;

    const tl = engine.timeline;
    const song = store.song;
    let start = 0;
    let end = engine.songEndSec();
    if (v.exportRange === 'loop' && song.loop.end > song.loop.start) {
      start = tl.rawTickToSec(song.loop.start);
      end = tl.rawTickToSec(song.loop.end);
    }
    const from = start - Math.max(0, v.exportLead);
    const until = end + Math.max(0, v.exportTail);
    player.beginExport(from, until);
    engine.seek(from);
    player.render();

    const canvas = player.post.canvas;
    const vstream = canvas.captureStream(v.exportFps);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...engine.streamDest.stream.getAudioTracks()]);
    const pixels = canvas.width * canvas.height;
    const qual = v.exportQuality === 'high' ? 0.22 : v.exportQuality === 'medium' ? 0.12 : 0.06;
    const videoBitsPerSecond = Math.round(Math.min(40e6, Math.max(2e6, pixels * v.exportFps * qual)));
    const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond, audioBitsPerSecond: 192000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    const ended = new Promise<void>((r) => {
      finishEnded = r;
      engine.onEnded = () => r();
    });
    rec.start(250);

    const total = until - from;
    progressTimer = window.setInterval(() => {
      const pos = engine.position();
      onProgress(Math.max(0, Math.min(1, (pos - from) / total)), pos - from, total);
    }, 200);

    if (!cancelled) await engine.play(from, until);
    await ended;
    // Let the final frames flush.
    await new Promise((r) => setTimeout(r, 150));
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    vstream.getTracks().forEach((t) => t.stop());
    cleanup();
    if (cancelled) return null;
    return { blob: new Blob(chunks, { type: fmt.mime.split(';')[0] }), ext: fmt.ext };
  };

  const done = run().catch((err) => {
    cleanup();
    engine.stop();
    throw err;
  });

  return {
    cancel() {
      cancelled = true;
      engine.stop();
      finishEnded?.();
    },
    done,
  };
}
