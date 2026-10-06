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
  options: { thorough: boolean; lyrics: boolean; vocals: boolean; quick?: boolean; tidy?: boolean; video: boolean; stems: boolean };
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
  /** The drum one-shots in the sample folder set with --kits (path to read, and path inside the folder). */
  kitFiles(): Promise<{ path: string; rel: string }[]>;
  ready(): void;
  /** How far the current song is (0..1), for the taskbar. */
  progress(fraction: number, label: string): void;
}

export function desktop(): DesktopApi | null {
  return (window as unknown as { beatmakerDesktop?: DesktopApi }).beatmakerDesktop ?? null;
}
