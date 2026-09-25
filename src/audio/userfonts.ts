/**
 * The user's soundfonts (SF2 / SF3 files and SFZ instruments), loaded from the library and parsed
 * once. Tracks keep only the library ids and the preset (see SoundfontSettings).
 */
import { getFile } from '../core/library';
import type { SoundfontSettings, Track } from '../core/types';
import { loadSoundFont, parseSfz, preparePreset, type SoundFont } from './soundfont';

const fonts = new Map<string, SoundFont>();
const loads = new Map<string, Promise<SoundFont | null>>();

/** Parse a soundfont from its stored files (cached by the main file's id). Null if it isn't in this browser. */
export function loadUserFont(s: SoundfontSettings): Promise<SoundFont | null> {
  let p = loads.get(s.file);
  if (!p) {
    p = (async () => {
      try {
        const data = await getFile(s.file);
        let sf: SoundFont;
        if (s.samples) {
          const files = new Map<string, ArrayBuffer>();
          await Promise.all(Object.entries(s.samples).map(async ([path, id]) => files.set(path, await getFile(id))));
          sf = await parseSfz(new TextDecoder().decode(data), files, s.name);
        } else sf = await loadSoundFont(data, s.name);
        fonts.set(s.file, sf);
        return sf;
      } catch {
        loads.delete(s.file);
        return null;
      }
    })();
    loads.set(s.file, p);
  }
  return p;
}

/** A parsed soundfont, if it's loaded. */
export function userFont(s: SoundfontSettings | undefined): SoundFont | undefined {
  return s ? fonts.get(s.file) : undefined;
}

/** Make a freshly parsed soundfont available under a library id (so it isn't parsed twice). */
export function rememberFont(id: string, sf: SoundFont): void {
  fonts.set(id, sf);
  loads.set(id, Promise.resolve(sf));
}

/** Load every soundfont the song's tracks use and build the buffers of their presets. */
export async function ensureUserFonts(tracks: Track[]): Promise<void> {
  await Promise.all(
    tracks
      .filter((t) => t.instrument === 'soundfont' && t.soundfont)
      .map(async (t) => {
        const sf = await loadUserFont(t.soundfont!);
        if (sf && t.soundfont!.preset < sf.presets.length) preparePreset(sf, t.soundfont!.preset);
      }),
  );
}
