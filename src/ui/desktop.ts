/**
 * The desktop app (Electron, in desktop/) exposes this bridge to the page. In a browser it is
 * absent and everything falls back to downloads.
 */
export interface DesktopJob {
  id: number;
  /** The song to remake, its file name and the folder the results go to. */
  path: string;
  name: string;
  outDir: string;
  options: { thorough: boolean; lyrics: boolean; vocals: boolean; quick?: boolean; tidy?: boolean; video: boolean; stems: boolean; originalStems?: ('drums' | 'bass' | 'other')[] };
}

export interface DesktopApi {
  version: string;
  platform: string;
  readFile(path: string): Promise<Uint8Array>;
  /** Write a file into a folder (made if needed); resolves to its full path. */
  writeFile(dir: string, name: string, data: Uint8Array): Promise<string>;
  /** A save dialog; resolves false if cancelled. */
  saveAs(name: string, data: Uint8Array): Promise<boolean>;
  openFolder(dir: string): Promise<void>;
  /** The folder results for this song go to (next to it), or null when its path is unknown. */
  outDirFor(file: File): Promise<string | null>;
  /** Pick songs in a dialog and queue a full automatic remake of each; resolves to how many. */
  chooseSongs(): Promise<number>;
  onJob(fn: (job: DesktopJob) => void): void;
  jobDone(id: number, result: { ok: boolean; files: string[]; error?: string }): void;
  /** The VST sounds picked so far, by role (melody, drums). */
  vstSounds(): Promise<Record<string, { name: string; plugin: string }>>;
  /** Play notes through the picked sounds: a WAV per role (44.1 kHz stereo from song time 0), or an error. */
  vstRender(job: { duration: number; parts: { role: string; sound?: string; notes: { p: number; s: number; e: number; v: number }[] }[] }): Promise<{ files?: Record<string, Uint8Array>; error?: string }>;
  /** Whether the music-listening models are available (they live in the --ymt3 folder). */
  earsReady(): Promise<boolean>;
  /** Which candidates sound most like the reference: per candidate, its mean similarity under two models (general, music). */
  earsScore(refs: Uint8Array[], cands: Uint8Array[][]): Promise<{ general?: number[]; music?: number[]; error?: string }>;
  /** Whether voice removal is set up (--sep <folder>). */
  devocalReady(): Promise<boolean>;
  /** Take the voice out of a whole song first (WAV bytes): the instrumental and the vocals, as WAV bytes. */
  devocalRun(wav: Uint8Array): Promise<{ instrumental?: Uint8Array; vocals?: Uint8Array; error?: string }>;
  /** Clean the bleed of a voice out of a stem (WAV bytes) with the vocals track as a guide; `offset` is where the song starts in the audio (seconds). */
  stemClean(stem: Uint8Array, vocals: Uint8Array, bpm: number, offset: number): Promise<{ wav?: Uint8Array; error?: string }>;
  /** Whether beat tracking (Beat This!) is set up (it lives in the --sep folder). */
  beatsReady(): Promise<boolean>;
  /** Beats and downbeats of a song (WAV bytes), in seconds. */
  beatsRun(wav: Uint8Array): Promise<{ beats?: number[]; downbeats?: number[]; error?: string }>;
  /** A melodic part (WAV bytes) read as notes on sounds fitted to it: notes are [pitch, start s, end s, level 0..1, kind, the note's own level curve]. */
  resynthRun(wav: Uint8Array): Promise<{ step?: number; harmonics?: number[]; kinds?: { envelope: number[]; notes: number }[]; notes?: [number, number, number, number, number, number[]][]; error?: string }>;
  /** Package four parts as a Stem2 track and, if the speaker is plugged in as a USB drive, copy it on (a new folder only). */
  stem2Send(job: { stems: Record<string, Uint8Array>; title: string; artist: string; bpm: number; bars: number[]; key: string; tonality: string }): Promise<{ folder?: string; copied?: boolean; drive?: string; seconds?: number; error?: string }>;
  /** Analyze a vocal against its beat, build a chain from the findings and render before / after (WAV bytes in and out). */
  vocalEngineer(job: { vocal: Uint8Array; beat: Uint8Array; direction: string; retune: boolean; preset?: string }): Promise<{
    report?: { analysis: Record<string, number> & { key: string }; chain: string[]; checks: Record<string, number | boolean> };
    before?: Uint8Array;
    after?: Uint8Array;
    processed?: Uint8Array;
    error?: string;
  }>;
  /** Spotify: login in the browser, then library, playlists and control of Spotify's own playback. No audio passes through. */
  spotify: {
    status(): Promise<{ clientId: boolean; loggedIn: boolean; redirect: string }>;
    setClient(id: string): Promise<{ error?: string }>;
    login(): Promise<{ error?: string }>;
    logout(): Promise<unknown>;
    api<T = unknown>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<{ data?: T; status?: number; error?: string }>;
  };
  /** Instrumentals on ccMixter with these tags, each with the licence its listing states. */
  beatSearch(tags: string[]): Promise<{ beats?: import('./beatfinder').Beat[]; error?: string }>;
  /** Download a found beat (ccmixter.org only) and save its licence record beside it. */
  beatFetch(beat: import('./beatfinder').Beat, record: string): Promise<{ audio?: Uint8Array; folder?: string; error?: string }>;
  /** Saved vocal presets (measured from reference vocals). */
  vocalPresets(): Promise<{ name: string; source: string; made: string; measured: Record<string, number | null>; tuning: { why: string } }[]>;
  /** Measure a reference vocal (WAV bytes) and save it as a preset. */
  vocalPresetMake(job: { reference: Uint8Array; name: string; source: string; bpm?: number }): Promise<{ preset?: { name: string; measured: Record<string, number | null> }; error?: string }>;
  /** Where a chosen file lives on disk ('' if it has no path). */
  pathOf(file: File): string;
  /** The two-deck mixer's saved session. */
  mixerSession: { load(): Promise<unknown>; save(data: unknown): Promise<string> };
  /** Separated parts kept per song file (WAV bytes by part name). */
  stemsCache: { get(file: string): Promise<Record<string, Uint8Array> | null>; put(file: string, stems: Record<string, Uint8Array>): Promise<string | null> };
  /** Whether YourMT3+ is set up (--ymt3 <folder>). */
  ymt3Ready(): Promise<boolean>;
  /** Transcribe a WAV of a stem with YourMT3+: notes by General MIDI program, in seconds from its start. */
  ymt3Run(wav: Uint8Array, seconds: number): Promise<{ notes?: { p: number; s: number; e: number; v: number; prog: number }[]; error?: string }>;
  /** The drum one-shots in the sample folder set with --kits (path to read, and path inside the folder). */
  kitFiles(): Promise<{ path: string; rel: string }[]>;
  ready(): void;
  /** How far the current song is (0..1), for the taskbar. */
  progress(fraction: number, label: string): void;
}

export function desktop(): DesktopApi | null {
  return (window as unknown as { beatmakerDesktop?: DesktopApi }).beatmakerDesktop ?? null;
}
