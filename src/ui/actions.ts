import { analyzeSound, beatPhase, EQ_BANDS, matchGains, mixStats, pumpDip, type SoundReport } from '../audio/analyze';
import { KIT_BY_ID, registerKit } from '../audio/drums';
import { userKitDef } from '../audio/packs';
import { getKit, getStoredFile, putFileWithId, putKit, type UserKit } from '../core/library';
import type { AudioEngine } from '../audio/engine';
import { encodeWav, renderSong } from '../audio/render';
import { loadSamplerFile } from '../audio/sampler';
import { ensureSongSamplesStrict } from '../audio/samples';
import { drumNotes, splitParts } from '../audio/parts';
import { drumGrid, transcribePitches } from '../audio/transcribe';
import { detectAudioKey } from '../audio/key';
import { detectTempo } from '../audio/tempo';
import { generateSong, GENRE_BY_ID } from '../beats/generator';
import { blankSong } from '../beats/templates';
import { normalizeSong, type Store } from '../core/store';
import { pcName } from '../core/theory';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, DEFAULT_MASTER, MAX_BARS, newNoteId, newTrackId, songLengthTicks, STEP, type MasterSettings, type Note, type Track } from '../core/types';
import { midiToSong, songToMidi } from '../midi/midi';
import { exportVideo, pickFormat } from '../visual/exporter';
import type { VisualPlayer } from '../visual/player';
import { mergeVisual, PALETTES, presetSettings, type VisualSettings } from '../visual/settings';
import { downloadBlob, h, modal, pickFile, safeName, toast } from './dom';
import { showPackLoader } from './packs';
import { readZip, zipFiles } from './zip';

const SCALES_7 = new Set(['minor', 'major', 'dorian', 'phrygian', 'harmonic', 'mixolydian', 'lydian']);

export interface GenerateChoice {
  genre: string;
  bars: number;
  key: number | null;
  scale: string | null;
  bpm: number | null;
}

/** Say an export finished, and whether synth stand-ins replaced recordings that didn't download. */
function exportedToast(msg: string, missing: string[]): void {
  if (missing.length) toast(`${msg}, with synth stand-ins for ${missing.join(', ')}`, 'error', 8000);
  else toast(msg, 'ok', 4000);
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
      await this.openProjectText(await file.text(), file.name);
    } catch (e) {
      toast(`Couldn't open project: ${(e as Error).message}`, 'error', 4000);
    }
  }

  /** Load a project from its JSON, and say if it uses sounds this browser doesn't have. */
  private async openProjectText(text: string, fileName: string): Promise<void> {
    const data = JSON.parse(text) as { format?: string; song?: unknown; visual?: Partial<VisualSettings> };
    if (!data.song) throw new Error('Not a Beatmaker project');
    this.store.loadSong(normalizeSong(data.song as never));
    if (data.visual) this.store.replaceVisual(mergeVisual(data.visual));
    this.engine.stop();
    void this.engine.ensureKits();
    const tracks = this.store.song.tracks;
    const missing = tracks.filter((t) => t.kind === 'drums' && !KIT_BY_ID.has(t.instrument));
    for (const t of tracks) if (t.instrument === 'sampler' && t.sampler && !(await loadSamplerFile(t.sampler.file))) missing.push(t);
    if (missing.length) {
      toast(`Opened ${fileName}. ${missing.map((t) => `“${t.name}”`).join(', ')} used sounds that aren't saved in this browser (a drum pack or a sampler sound). Load them again: File → Load drum pack…, or the Sample button.`, 'info', 7000);
    } else toast(`Opened ${fileName}`, 'ok');
  }

  /** Work out what a file is from its name, MIME type or first bytes (files may have no extension). */
  private async sniff(file: File): Promise<'midi' | 'project' | 'bundle' | 'audio' | 'image' | 'unknown'> {
    const name = file.name.toLowerCase();
    if (/\.zip$/.test(name)) return 'bundle';
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
    if (str(0, 4) === 'PK\x03\x04') return 'bundle';
    return 'unknown';
  }

  async openFile(file: File): Promise<void> {
    const kind = await this.sniff(file);
    if (kind === 'midi') return this.importMidiFile(file);
    if (kind === 'project') return this.importProjectFile(file);
    if (kind === 'bundle') return this.importBundle(file);
    if (kind === 'image') return this.setBackgroundImage(file);
    // Audio, or unknown: let the browser's decoder decide.
    return this.importAudioFile(file, kind === 'unknown');
  }

  /** Open the drum pack loader (optionally with files already picked or dropped). */
  loadDrumPack(files: File[] = []): void {
    showPackLoader(this.store, this.engine, files);
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

  /**
   * Save the project as .json, or, when it uses sounds that live only in this browser (drum packs,
   * sampler sounds), as a .zip bundle with those sounds inside so it opens anywhere.
   */
  async saveProject(): Promise<void> {
    const song = this.store.song;
    const json = JSON.stringify({ format: 'beatmaker', version: 1, song, visual: this.store.visual });
    const base = safeName(song.name);
    const kits = (await Promise.all([...new Set(song.tracks.filter((t) => t.kind === 'drums').map((t) => t.instrument))].map(getKit))).filter((k) => k !== undefined);
    const ids = new Set([...kits.flatMap((k) => Object.values(k.files)), ...song.tracks.filter((t) => t.instrument === 'sampler' && t.sampler).map((t) => t.sampler!.file)]);
    const sounds = (await Promise.all([...ids].map(getStoredFile))).filter((f) => f !== undefined);
    if (!sounds.length) {
      void downloadBlob(new Blob([json], { type: 'application/json' }), `${base}.beatmaker.json`);
      return;
    }
    const zip = await zipFiles([
      { name: 'project.beatmaker.json', data: new Blob([json]) },
      { name: 'sounds.json', data: new Blob([JSON.stringify({ kits, sounds: sounds.map((f) => ({ id: f.id, name: f.name })) })]) },
      ...sounds.map((f) => ({ name: `sounds/${f.id}`, data: new Blob([f.data]) })),
    ]);
    if (await downloadBlob(zip, `${base}.beatmaker.zip`)) toast(`Saved with its ${sounds.length} sound${sounds.length === 1 ? '' : 's'} (.zip)`, 'ok', 3500);
  }

  /** Open a .zip bundle from saveProject: put its sounds and packs in this browser, then the song. */
  async importBundle(file: File): Promise<void> {
    try {
      const files = await readZip(file);
      const project = files.get('project.beatmaker.json');
      if (!project) throw new Error('No Beatmaker project inside');
      const manifest = files.get('sounds.json');
      if (manifest) {
        const m = JSON.parse(new TextDecoder().decode(manifest)) as { kits?: UserKit[]; sounds?: { id: string; name: string }[] };
        for (const snd of m.sounds ?? []) {
          const data = files.get(`sounds/${snd.id}`);
          if (data) await putFileWithId(snd.id, snd.name, data.slice().buffer);
        }
        for (const k of m.kits ?? []) {
          if (!k || typeof k.id !== 'string' || typeof k.files !== 'object') continue;
          if (!(await getKit(k.id))) await putKit(k);
          registerKit(userKitDef(k));
        }
      }
      await this.openProjectText(new TextDecoder().decode(project), file.name);
    } catch (e) {
      toast(`Couldn't open the bundle: ${(e as Error).message}`, 'error', 4500);
    }
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
      const missing = await this.checkSamples(song.tracks);
      const buf = await renderSong(song, { from, to, tail: 2, backing: this.engine.backingBuffer, backingVolume: this.engine.backingVolume });
      m.close();
      if (await downloadBlob(encodeWav(buf), `${safeName(song.name)}.wav`)) exportedToast('WAV exported', missing);
    } catch (e) {
      toast(`Render failed: ${(e as Error).message}`, 'error', 4000);
    } finally {
      m.close();
    }
  }

  /**
   * Render every (unmuted) track on its own and download them with the full mix as a ZIP of WAVs.
   * Stems keep each track's own effects and the master EQ, width and level, but skip the master
   * compressor and limiter, so they add up to the mix before it.
   */
  async exportStems(): Promise<void> {
    const song = cloneSong(this.store.song);
    const tl = this.engine.timeline;
    let from = 0;
    let to = this.engine.songEndSec();
    if (this.store.visual.exportRange === 'loop' && song.loop.end > song.loop.start) {
      from = tl.rawTickToSec(song.loop.start);
      to = tl.rawTickToSec(song.loop.end);
    }
    const tracks = song.tracks.filter((t) => t.notes.length && !t.mute);
    if (!tracks.length) {
      toast('No unmuted tracks with notes to export', 'error');
      return;
    }
    let cancelled = false;
    const bar = h('div', { style: { width: '0%' } });
    const status = h('p', null, 'Rendering the full mix…');
    const cancel = h('button', { class: 'btn btn-block', onclick: () => (cancelled = true) }, 'Cancel');
    const m = modal('Export stems', h('div', null, status, h('div', { class: 'progress' }, bar), cancel), { closable: false });
    const fileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Track';
    try {
      const files: { name: string; data: Blob }[] = [];
      const missing = await this.checkSamples(song.tracks);
      files.push({ name: '00 Full mix.wav', data: encodeWav(await renderSong(song, { from, to, tail: 2 })) });
      for (const [i, t] of tracks.entries()) {
        if (cancelled) break;
        status.textContent = `Rendering ${i + 1} of ${tracks.length}: ${t.name}…`;
        bar.style.width = `${Math.round(((i + 1) / (tracks.length + 1)) * 100)}%`;
        const copy = cloneSong(song);
        for (const x of copy.tracks) {
          x.solo = x.id === t.id;
          // Only this track plays; kicks stay (silent) when it is sidechained to them.
          if (x.id !== t.id) x.notes = (t.duck ?? 0) > 0 && x.kind === 'drums' ? x.notes.filter((n) => n.pitch === 35 || n.pitch === 36) : [];
        }
        const buf = await renderSong(copy, { from, to, tail: 2, dynamics: false });
        files.push({ name: `${String(i + 1).padStart(2, '0')} ${fileName(t.name)}.wav`, data: encodeWav(buf) });
      }
      if (cancelled) {
        toast('Stem export cancelled');
        return;
      }
      status.textContent = 'Zipping…';
      bar.style.width = '100%';
      const zip = await zipFiles(files);
      m.close();
      if (await downloadBlob(zip, `${safeName(song.name)}-stems.zip`)) exportedToast(`Exported ${tracks.length} stems + the full mix`, missing);
    } catch (e) {
      toast(`Stem export failed: ${(e as Error).message}`, 'error', 5000);
    } finally {
      m.close();
    }
  }

  /**
   * Write parts from the reference audio: drums from a grid detector, and bass, chords and melody
   * from the Basic Pitch model (downloaded on first use, run on this device). Covers the loop range
   * if one is set, otherwise the whole song. Earlier transcribed tracks are updated in that range.
   */
  async transcribeReference(opts: { drums: boolean; pitched: boolean; sensitivity?: number }, onProgress: (msg: string) => void): Promise<string[]> {
    const ref = this.engine.backingBuffer;
    if (!ref) throw new Error('Load the original track first');
    const song = this.store.song;
    const tl = this.engine.timeline;
    const off = song.audioOffset;
    const useLoop = song.loop.enabled && song.loop.end > song.loop.start;
    const startTick = useLoop ? song.loop.start : 0;
    const endTick = Math.min(useLoop ? song.loop.end : songLengthTicks(song), Math.ceil(tl.secToTick(ref.duration + off)));
    if (endTick <= startTick) throw new Error('The reference audio doesn’t reach the song’s grid (check the audio offset)');
    const from = Math.max(0, tl.rawTickToSec(startTick) - off);
    const to = Math.min(ref.duration, tl.rawTickToSec(endTick) - off);
    const inRange = (n: Note) => n.start >= startTick && n.start < endTick;
    const parts: { name: string; kind: Track['kind']; instrument: string; notes: Note[] }[] = [];
    // The drums run for pitched parts too: a kick's thump must not become a bass note.
    onProgress('Finding the drums…');
    await new Promise((r) => setTimeout(r, 30));
    const ticks: number[] = [];
    for (let t = Math.ceil(startTick / STEP) * STEP; t < endTick; t += STEP) ticks.push(t);
    const drums = drumNotes(drumGrid(ref, ticks.map((t) => tl.tickToSec(t) - off), opts.sensitivity), ticks).filter(inRange);
    if (opts.drums) {
      const kit = song.tracks.find((t) => t.kind === 'drums')?.instrument ?? 'trap';
      parts.push({ name: 'Drums · from audio', kind: 'drums', instrument: kit, notes: drums });
    }
    if (opts.pitched) {
      onProgress('Downloading the note model (about 2 MB, once)…');
      const { notes, struck } = await transcribePitches(ref, from, to, {}, (p) => onProgress(`Listening for notes… ${Math.round(p * 100)}%`));
      const kicks = new Set(drums.filter((n) => n.pitch === 36).map((n) => n.start));
      const split = splitParts(notes, tl, { offset: off, kicks });
      split.bass = splitParts(struck, tl, { offset: off, kicks }).bass;
      const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 40;
      parts.push(
        { name: 'Bass · from audio', kind: 'synth', instrument: median(split.bass.map((n) => n.pitch)) < 43 ? 'bass808' : 'sebass', notes: split.bass.filter(inRange) },
        { name: 'Chords · from audio', kind: 'synth', instrument: 'spiano', notes: split.chords.filter(inRange) },
        { name: 'Melody · from audio', kind: 'synth', instrument: 'pluck', notes: split.melody.filter(inRange) },
      );
    }
    const colors = this.palette();
    const summary: string[] = [];
    this.store.update((s) => {
      for (const part of parts) {
        const existing = s.tracks.find((t) => t.name === part.name);
        if (existing) {
          existing.notes = [...existing.notes.filter((n) => !inRange(n)), ...part.notes];
        } else if (part.notes.length) {
          s.tracks.push({
            id: newTrackId(),
            name: part.name,
            kind: part.kind,
            instrument: part.instrument,
            color: colors[s.tracks.length % colors.length],
            volume: 0.8,
            pan: 0,
            reverb: part.kind === 'drums' ? 0.05 : 0.2,
            mute: false,
            solo: false,
            visible: true,
            notes: part.notes,
          });
        }
        summary.push(`${part.name.split(' ·')[0]}: ${part.notes.length} note${part.notes.length === 1 ? '' : 's'}`);
      }
      s.synthsWithAudio = true;
    });
    void this.engine.ensureKits();
    return summary;
  }

  /** Measure the reference's mix (EQ, dynamics, width, reverb, echo, saturation, pumping). */
  analyzeReference(): SoundReport | null {
    const buf = this.engine.backingBuffer;
    if (!buf) {
      toast('Load the original track first (File → Load reference audio…)', 'error', 4000);
      return null;
    }
    const s = this.store.song;
    // Song beat 0 plays at reference time −audioOffset.
    return analyzeSound(buf, s.bpm, beatPhase(-s.audioOffset, 0, s.bpm));
  }

  /**
   * Match the song's master to the reference: render the remake, compare its spectrum, stereo
   * width and level with the same stretch of the reference, and set the master EQ, width and gain
   * (two passes). Also carry over the measured reverb length and echo timing.
   */
  async matchMix(report: SoundReport, onProgress?: (msg: string) => void): Promise<string[]> {
    const ref = this.engine.backingBuffer;
    if (!ref) return [];
    const song = this.store.song;
    // The comparison renders the song: fit the recorded instruments, not their stand-ins.
    await this.checkSamples(song.tracks);
    // Compare the loop range if one is set (pick an instrumental part: vocals in the original
    // would pull the EQ towards the mids), otherwise the start of the song. 30 s is plenty.
    const tl = this.engine.timeline;
    const useLoop = song.loop.enabled && song.loop.end > song.loop.start;
    const from = useLoop ? tl.rawTickToSec(song.loop.start) : 0;
    const to = Math.min(useLoop ? tl.rawTickToSec(song.loop.end) : this.engine.songEndSec(), from + 30);
    // The reference plays at song time − audioOffset.
    const refFrom = Math.max(0, from - song.audioOffset);
    const len = Math.max(2, Math.min(to - from, ref.duration - refFrom));
    const goal = mixStats(ref, refFrom, len);
    const master: MasterSettings = { ...DEFAULT_MASTER, eq: [...DEFAULT_MASTER.eq] };
    if (report.reverb !== null) master.reverbSize = Math.round(Math.max(0.8, Math.min(4.5, report.reverb)) * 10) / 10;
    // Sidechain: if the original pumps, duck the song's melodic tracks on the kick, then correct
    // the depth from how far the rendered mids dip compared with the original's.
    const hasKick = song.tracks.some((t) => t.kind === 'drums' && !t.mute && t.notes.some((n) => n.pitch === 35 || n.pitch === 36));
    const userDucked = song.tracks.filter((t) => (t.duck ?? 0) > 0).map((t) => t.id);
    const duckIds = report.pump !== null && hasKick ? (userDucked.length ? userDucked : song.tracks.filter((t) => t.kind === 'synth' && t.notes.length).map((t) => t.id)) : [];
    // In a full mix the dip reads at roughly 0.4× the ducking depth (the kick and undocked parts fill it).
    const DIP_PER_DB = 0.42;
    let duck = report.pump !== null ? Math.round(Math.max(3, Math.min(18, report.pump / DIP_PER_DB)) * 2) / 2 : 0;
    const goalDip = duckIds.length ? pumpDip(ref, refFrom, len, song.bpm, beatPhase(-song.audioOffset, refFrom, song.bpm)) : 0;
    const tried: [duck: number, dip: number][] = [];
    const render = async (m: MasterSettings) => {
      const copy = cloneSong(song);
      copy.master = m;
      for (const t of copy.tracks) if (duckIds.includes(t.id)) t.duck = duck;
      const buf = await renderSong(copy, { from, to: from + len, tail: 0 });
      if (duckIds.length) tried.push([duck, pumpDip(buf, 0, len, song.bpm, beatPhase(0, from, song.bpm))]);
      return mixStats(buf, 0, len);
    };
    // Step the depth towards the original's dip, using the measured slope once there are two tries.
    const fixDuck = () => {
      if (!tried.length) return;
      const [d1, p1] = tried[tried.length - 1];
      let slope = DIP_PER_DB;
      if (tried.length > 1) {
        const [d0, p0] = tried[tried.length - 2];
        const s = (p1 - p0) / (d1 - d0);
        if (Math.abs(d1 - d0) >= 0.5 && s > 0.1 && s < 1.5) slope = s;
      }
      duck = Math.round(Math.max(1, Math.min(24, d1 + (goalDip - p1) / slope)) * 2) / 2;
    };
    onProgress?.('Rendering your mix…');
    let mine = await render(master);
    master.eq = matchGains(goal.bands, mine.bands);
    master.width = Math.round(Math.max(0, Math.min(2.5, Math.pow(10, (goal.width - mine.width) / 20))) * 100) / 100;
    fixDuck();
    onProgress?.('Refining…');
    mine = await render(master);
    fixDuck();
    const fix = matchGains(goal.bands, mine.bands);
    master.eq = master.eq.map((g, i) => Math.round(Math.max(-12, Math.min(12, g + fix[i] * 0.7)) * 2) / 2);
    // EQ moves change the side/mid balance too (bass is mono), so correct the width again.
    master.width = Math.round(Math.max(0, Math.min(2.5, master.width * Math.pow(10, (goal.width - mine.width) / 20))) * 100) / 100;
    master.gain = Math.round(Math.max(-12, Math.min(9, goal.rms - mine.rms)) * 2) / 2;
    const changes: string[] = [];
    const fmtHz = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));
    const big = master.eq.map((g, i) => [g, i] as const).filter(([g]) => Math.abs(g) >= 2);
    changes.push(big.length ? `EQ: ${big.map(([g, i]) => `${g > 0 ? '+' : ''}${g} dB at ${fmtHz(EQ_BANDS[i])}`).join(', ')}` : 'EQ: already close, only small tweaks');
    changes.push(`Stereo width ×${master.width}`, `Output ${master.gain >= 0 ? '+' : ''}${master.gain} dB`);
    if (report.reverb !== null) changes.push(`Reverb length ${master.reverbSize} s`);
    if (duckIds.length) changes.push(`Sidechain −${duck} dB on ${duckIds.length === 1 ? song.tracks.find((t) => t.id === duckIds[0])?.name : `${duckIds.length} tracks`}`);
    else if (report.pump !== null) changes.push('Sidechain: add a kick drum to duck from');
    this.store.update((s) => {
      s.master = master;
      for (const t of s.tracks) if (duckIds.includes(t.id)) t.duck = duck;
      if (report.echo) {
        s.echoBeats = report.echo.beats;
        if (!s.tracks.some((t) => (t.echo ?? 0) > 0)) {
          // Put the echo on the lead: the highest synth part.
          const synths = s.tracks.filter((t) => t.kind === 'synth' && t.notes.length);
          const avg = (t: (typeof synths)[number]) => t.notes.reduce((a, n) => a + n.pitch, 0) / t.notes.length;
          const lead = synths.sort((a, b) => avg(b) - avg(a))[0];
          if (lead) {
            lead.echo = 0.22;
            changes.push(`Echo ${report.echo.label} on ${lead.name}`);
          }
        } else changes.push(`Echo time ${report.echo.label}`);
      }
    });
    return changes;
  }

  /**
   * Before an export: load every recorded instrument the song uses, retrying failed downloads,
   * and say which (if any) will fall back to a synth stand-in, rather than export it silently.
   */
  private async checkSamples(tracks: Track[]): Promise<string[]> {
    const missing = await ensureSongSamplesStrict(tracks.filter((t) => !t.mute));
    if (missing.length) toast(`Couldn't download the recorded ${missing.join(', ')} (offline?): the export uses synth stand-ins for ${missing.length === 1 ? 'it' : 'them'}.`, 'error', 6000);
    return missing;
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
    status.textContent = 'Loading recorded sounds…';
    const missing = await this.checkSamples(this.store.song.tracks);
    // The recording takes as long as the song: keep the warning in view, not just in a toast.
    if (missing.length) body.insertBefore(h('p', { class: 'modal-warn' }, `Synth stand-ins for ${missing.join(', ')}: their recordings couldn't be downloaded.`), cancelBtn);
    const job = exportVideo(this.store, this.engine, this.player, (p, pos, total) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      status.textContent = `${pos.toFixed(1)}s / ${total.toFixed(1)}s`;
    });
    cancelBtn.addEventListener('click', () => job.cancel());
    try {
      const res = await job.done;
      if (res) {
        m.close();
        if (await downloadBlob(res.blob, `${safeName(this.store.song.name)}.${res.ext}`)) exportedToast(`Video exported (${(res.blob.size / 1e6).toFixed(1)} MB)`, missing);
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
