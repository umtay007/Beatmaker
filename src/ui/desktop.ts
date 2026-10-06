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
  options: { thorough: boolean; lyrics: boolean; video: boolean; stems: boolean };
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
  ready(): void;
}

export function desktop(): DesktopApi | null {
  return (window as unknown as { beatmakerDesktop?: DesktopApi }).beatmakerDesktop ?? null;
}
