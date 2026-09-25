import type { AudioEngine } from '../audio/engine';
import { encodeWav, renderSong } from '../audio/render';
import { detectAudioKey } from '../audio/key';
import { detectTempo } from '../audio/tempo';
import { generateSong, GENRE_BY_ID } from '../beats/generator';
import { blankSong } from '../beats/templates';
import { normalizeSong, type Store } from '../core/store';
import { pcName } from '../core/theory';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, MAX_BARS, newNoteId } from '../core/types';
import { midiToSong, songToMidi } from '../midi/midi';
import { exportVideo, pickFormat } from '../visual/exporter';
import type { VisualPlayer } from '../visual/player';
import { mergeVisual, PALETTES, presetSettings, type VisualSettings } from '../visual/settings';
import { downloadBlob, h, modal, pickFile, safeName, toast } from './dom';

const SCALES_7 = new Set(['minor', 'major', 'dorian', 'phrygian', 'harmonic', 'mixolydian', 'lydian']);

export interface GenerateChoice {
  genre: string;
  bars: number;
  key: number | null;
  scale: string | null;
  bpm: number | null;
}

/** App-level commands shared by the top bar, inspector, keyboard shortcuts and drag & drop. */
export class Actions {
  lastGenre = 'trap';
  exporting = false;

  constructor(
    readonly store: Store,
    readonly engine: AudioEngine,
    readonly player: VisualPlayer,
  ) {}

  palette(): string[] {
    return (PALETTES[this.store.visual.palette] ?? PALETTES.neon).colors;
  }

  private afterNewSong(): void {
    this.engine.stop();
    this.store.setVisual({ titleText: this.store.song.name, subtitleText: this.store.song.artist ? this.store.song.artist : this.store.visual.subtitleText });
    void this.engine.ensureKits();
  }

  newBlank(): void {
    this.store.loadSong(blankSong(this.palette()));
    this.afterNewSong();
    toast('New blank beat — click the grid to add notes');
  }

  generate(c: GenerateChoice): void {
    this.lastGenre = c.genre;
    const song = generateSong({
      genre: c.genre,
      bars: c.bars,
      key: c.key ?? undefined,
      scale: c.scale ?? undefined,
      bpm: c.bpm ?? undefined,
      palette: this.palette(),
    });
    this.store.loadSong(song);
    this.afterNewSong();
    toast(`Generated a ${GENRE_BY_ID.get(c.genre)?.label ?? ''} beat · ${song.bpm} BPM`, 'ok');
  }

  async importMidiFile(file: File): Promise<void> {
    try {
      const buf = await file.arrayBuffer();
      const song = midiToSong(buf, file.name, { palette: this.palette() });
      this.store.loadSong(song);
      this.afterNewSong();
      toast(`Imported ${song.tracks.length} tracks from ${file.name}`, 'ok');
    } catch (e) {
      toast(`Couldn't read MIDI: ${(e as Error).message}`, 'error', 4000);
    }
  }

  async importAudioFile(file: File, guessed = false): Promise<void> {
    try {
      const dur = await this.engine.loadBacking(file);
      const end = this.engine.songEndSec();
      if (dur > end + 0.5) {
        const tl = this.engine.timeline;
        const bars = Math.ceil(tl.secToTick(dur) / BAR);
        this.store.update((s) => (s.bars = Math.min(MAX_BARS, bars)));
      }
      this.engine.applySynthMute();
      this.store.emit('ui');
      toast(`Loaded “${file.name}” as a reference track. Use “Detect tempo” to line the grid up with it.`, 'ok', 4500);
    } catch (e) {
      toast(
        guessed
          ? `“${file.name}” isn't a MIDI, audio, image or project file this browser can read.`
          : `Couldn't decode audio: ${(e as Error).message || 'unsupported format'}`,
        'error',
        5000,
      );
    }
  }

  /** Estimate the reference track's tempo, first beat and key, then line the song grid up with it. */
  detectBackingTempo(): void {
    const buf = this.engine.backingBuffer;
    if (!buf) {
      toast('Load a reference audio file first', 'error');
      return;
    }
    const res = detectTempo(buf);
    const key = detectAudioKey(buf);
    this.store.update((s) => {
      s.bpm = res.bpm;
      s.tempoChanges = [];
      s.audioOffset = -Math.round(res.firstBeat * 1000) / 1000;
      s.key = key.key;
      s.scale = key.scale;
      // Small offsets are within the detector's error; only retune for a clearly off-440 recording.
      s.tuning = Math.abs(key.tuning) >= 6 ? Math.round(key.tuning) : 0;
      // Fit the song to the reference (but never cut off existing notes).
      const audioBars = Math.ceil(new Timeline(s).secToTick(buf.duration + s.audioOffset) / BAR);
      const lastNote = Math.max(0, ...s.tracks.flatMap((t) => t.notes.map((n) => n.start + n.dur)));
      s.bars = Math.min(MAX_BARS, Math.max(1, audioBars, Math.ceil(lastNote / BAR)));
    });
    const tip = res.bpm > 150 ? ` (half-time feel? try ${Math.round(res.bpm / 2)})` : res.bpm < 75 ? ` (double-time? try ${Math.round(res.bpm * 2)})` : '';
    const tuned = Math.abs(key.tuning) >= 6 ? `, tuned ${key.tuning > 0 ? '+' : ''}${Math.round(key.tuning)} cents` : '';
    toast(`Detected ${res.bpm} BPM${tip} in ${pcName(key.key, true)} ${key.scale}${key.confidence < 0.3 ? ' (key uncertain)' : ''}${tuned}`, 'ok', 6000);
  }

  /** Write a starter beat in the chosen style on the current grid (tempo, key, length), keeping the reference audio. */
  starterOnGrid(genre = this.lastGenre): void {
    const cur = this.store.song;
    const song = generateSong({
      genre,
      bars: Math.max(4, cur.bars),
      key: cur.key,
      scale: SCALES_7.has(cur.scale) ? cur.scale : undefined,
      bpm: cur.bpm,
      palette: this.palette(),
    });
    song.name = cur.name;
    song.artist = cur.artist;
    song.audioOffset = cur.audioOffset;
    song.synthsWithAudio = true;
    song.swing = cur.swing;
    this.lastGenre = genre;
    this.store.loadSong(song);
    this.engine.applySynthMute();
    void this.engine.ensureKits();
    toast(`Starter ${GENRE_BY_ID.get(genre)?.label ?? ''} beat written at ${song.bpm} BPM in ${pcName(song.key, true)} ${song.scale} — edit it to match the reference`, 'ok', 5000);
  }

  /** Shift the reference audio against the grid by a number of beats. */
  shiftBacking(beats: number): void {
    const sec = (60 / this.store.song.bpm) * beats;
    this.store.update((s) => (s.audioOffset = Math.round((s.audioOffset + sec) * 1000) / 1000));
  }

  async importProjectFile(file: File): Promise<void> {
    try {
      const data = JSON.parse(await file.text()) as { format?: string; song?: unknown; visual?: Partial<VisualSettings> };
      if (!data.song) throw new Error('Not a Beatmaker project');
      this.store.loadSong(normalizeSong(data.song as never));
      if (data.visual) this.store.replaceVisual(mergeVisual(data.visual));
      this.engine.stop();
      void this.engine.ensureKits();
      toast(`Opened ${file.name}`, 'ok');
    } catch (e) {
      toast(`Couldn't open project: ${(e as Error).message}`, 'error', 4000);
    }
  }

  /** Work out what a file is from its name, MIME type or first bytes (files may have no extension). */
  private async sniff(file: File): Promise<'midi' | 'project' | 'audio' | 'image' | 'unknown'> {
    const name = file.name.toLowerCase();
    if (/\.(mid|midi|kar)$/.test(name)) return 'midi';
    if (/\.json$/.test(name)) return 'project';
    if (file.type.startsWith('audio/') || file.type.startsWith('video/') || /\.(mp3|wav|m4a|ogg|oga|flac|aac|opus|webm|mp4|aif|aiff)$/.test(name)) return 'audio';
    if (file.type.startsWith('image/')) return 'image';
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const str = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
    if (str(0, 4) === 'MThd' || (str(0, 4) === 'RIFF' && str(8, 4) === 'RMID')) return 'midi';
    if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return 'image';
    if ((b[0] === 0x89 && str(1, 3) === 'PNG') || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || str(0, 4) === 'GIF8') return 'image';
    if (str(0, 4) === 'RIFF' || str(0, 3) === 'ID3' || str(0, 4) === 'OggS' || str(0, 4) === 'fLaC' || str(4, 4) === 'ftyp' || str(0, 4) === 'FORM') return 'audio';
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio'; // MPEG / AAC frame sync
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio'; // WebM / Matroska
    if (str(0, 1) === '{') return 'project';
    return 'unknown';
  }

  async openFile(file: File): Promise<void> {
    const kind = await this.sniff(file);
    if (kind === 'midi') return this.importMidiFile(file);
    if (kind === 'project') return this.importProjectFile(file);
    if (kind === 'image') return this.setBackgroundImage(file);
    // Audio, or unknown: let the browser's decoder decide.
    return this.importAudioFile(file, kind === 'unknown');
  }

  async pickAndOpen(accept: string): Promise<void> {
    const f = await pickFile(accept);
    if (f) await this.openFile(f);
  }

  setBackgroundImage(file: File): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        this.player.bgImage = img;
        this.store.setVisual({ bgMode: 'image' });
        toast('Background image set', 'ok');
        resolve();
      };
      img.onerror = () => {
        toast('Could not load that image', 'error');
        resolve();
      };
      img.src = url;
    });
  }

  saveProject(): void {
    const data = { format: 'beatmaker', version: 1, song: this.store.song, visual: this.store.visual };
    void downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${safeName(this.store.song.name)}.beatmaker.json`);
  }

  exportMidi(): void {
    const bytes = songToMidi(this.store.song);
    void downloadBlob(new Blob([bytes as BlobPart], { type: 'audio/midi' }), `${safeName(this.store.song.name)}.mid`).then((ok) => ok && toast('MIDI exported', 'ok'));
  }

  async exportWav(): Promise<void> {
    const song = cloneSong(this.store.song);
    const tl = this.engine.timeline;
    let from = 0;
    let to = this.engine.songEndSec();
    if (this.store.visual.exportRange === 'loop' && song.loop.end > song.loop.start) {
      from = tl.rawTickToSec(song.loop.start);
      to = tl.rawTickToSec(song.loop.end);
    }
    const body = h('div', null, h('p', null, 'Rendering audio…'), h('div', { class: 'progress' }, h('div', { style: { width: '60%' } })));
    const m = modal('Export WAV', body, { closable: false });
    try {
      const buf = await renderSong(song, { from, to, tail: 2, backing: this.engine.backingBuffer, backingVolume: this.engine.backingVolume });
      m.close();
      if (await downloadBlob(encodeWav(buf), `${safeName(song.name)}.wav`)) toast('WAV exported', 'ok');
    } catch (e) {
      toast(`Render failed: ${(e as Error).message}`, 'error', 4000);
    } finally {
      m.close();
    }
  }

  async exportVideo(): Promise<void> {
    if (this.exporting) return;
    const fmt = pickFormat(this.store.visual.exportFormat);
    if (!fmt) {
      toast('This browser cannot record video. Try Chrome, Edge, Firefox or Safari.', 'error', 5000);
      return;
    }
    this.exporting = true;
    const bar = h('div');
    const status = h('p', null, 'Preparing…');
    const cancelBtn = h('button', { class: 'btn btn-block' }, 'Cancel');
    const body = h(
      'div',
      null,
      h('p', null, `Recording in real time as ${fmt.ext.toUpperCase()}. Keep this tab visible until it finishes.`),
      h('div', { class: 'progress' }, bar),
      status,
      cancelBtn,
    );
    const m = modal('Export video', body, { closable: false });
    const job = exportVideo(this.store, this.engine, this.player, (p, pos, total) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      status.textContent = `${pos.toFixed(1)}s / ${total.toFixed(1)}s`;
    });
    cancelBtn.addEventListener('click', () => job.cancel());
    try {
      const res = await job.done;
      if (res) {
        m.close();
        if (await downloadBlob(res.blob, `${safeName(this.store.song.name)}.${res.ext}`)) toast(`Video exported (${(res.blob.size / 1e6).toFixed(1)} MB)`, 'ok', 4000);
      } else toast('Export cancelled');
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error', 5000);
    } finally {
      m.close();
      this.exporting = false;
    }
  }

  applyPreset(id: string): void {
    const next = presetSettings(id, this.store.visual);
    this.store.replaceVisual(next);
    this.applyPalette(next.palette);
  }

  applyPalette(id: string): void {
    const pal = PALETTES[id];
    if (!pal) return;
    if (this.store.visual.palette !== id) this.store.setVisual({ palette: id });
    this.store.update((s) => s.tracks.forEach((t, i) => (t.color = pal.colors[i % pal.colors.length])));
  }

  doubleLength(): void {
    this.store.update((s) => {
      const len = s.bars * BAR;
      if (s.bars * 2 > MAX_BARS) return;
      for (const t of s.tracks) {
        const copies = t.notes.filter((n) => n.start < len).map((n) => ({ ...n, id: newNoteId(), start: n.start + len }));
        t.notes.push(...copies);
      }
      s.bars *= 2;
    });
    toast(`Song is now ${this.store.song.bars} bars`);
  }
}
