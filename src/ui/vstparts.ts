/**
 * Your own VST instruments in the remake (desktop app only). Sounds are picked once in the plugin's
 * own window (`Beatmaker.exe --pick-sound melody|drums`); after that, the remake's melody and drums
 * are played through them offline and come back as audio tracks that replace the built-in ones.
 *
 * A VST sound stays only if the part still matches the original about as well as the built-in sound
 * did (the same score as the report's comparison): a plugin can't make a bad transcription good.
 */
import { busyStretches } from '../audio/finder';
import { partScore, type Role } from '../audio/compare';
import { renderSong } from '../audio/render';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, type Song, type Track } from '../core/types';
import type { Store } from '../core/store';
import { desktop } from './desktop';
import { vocalTrack } from './vocaltrack';

const ROLES: { role: 'melody' | 'drums'; part: 'other' | 'drums'; label: string }[] = [
  { role: 'melody', part: 'other', label: 'melody' },
  { role: 'drums', part: 'drums', label: 'drums' },
];
/** How many points of match a VST sound may lose to the built-in one and still be kept. */
const TOLERANCE = 5;

export interface VstContext {
  store: Store;
  roleOf: Map<string, Role>;
  stems: { other: AudioBuffer; drums: AudioBuffer };
  offset: number;
  colors: string[];
}

const rms = (b: AudioBuffer): number => {
  const d = b.getChannelData(0);
  let s = 0;
  for (let i = 0; i < d.length; i += 3) s += d[i] * d[i];
  return Math.sqrt(s / Math.ceil(d.length / 3));
};

/** Play the melody and drums through the picked VST sounds; returns lines for the report. */
export async function applyVstSounds(c: VstContext): Promise<string[]> {
  const app = desktop();
  if (!app?.vstSounds || !app.vstRender) return [];
  const sounds = await app.vstSounds();
  const song = c.store.song;
  const wanted = ROLES.filter((r) => sounds[r.role] && song.tracks.some((t) => c.roleOf.get(t.id) === r.role));
  if (!wanted.length) return [];
  const tl = new Timeline(song);
  const duration = tl.tickToSec(song.bars * BAR) + 2;
  const trackOf = (role: string): Track => song.tracks.find((t) => c.roleOf.get(t.id) === role)!;
  const parts = wanted.map((r) => ({
    role: r.role,
    // (Sub-semitone tuning is left to the plugin.)
    notes: trackOf(r.role).notes.map((n) => ({ p: n.pitch, s: tl.tickToSec(n.start), e: tl.tickToSec(n.start + n.dur), v: n.vel })),
  }));
  const res = await app.vstRender({ duration, parts });
  if (res.error || !res.files) return [`VST sounds: not used (${res.error ?? 'nothing came back'})`];

  const report: string[] = [];
  const ctx = new OfflineAudioContext(2, 1, 44100);
  for (const r of wanted) {
    const builtin = trackOf(r.role);
    const wav = res.files[r.role];
    try {
      const buf = await ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
      if (rms(buf) < 1e-5) {
        report.push(`VST ${r.label}: ${sounds[r.role].name} played nothing (is the sound loaded?), so the built-in one stays`);
        continue;
      }
      const name = `${builtin.name} (${sounds[r.role].name})`;
      const track = await vocalTrack(buf, song, builtin.color, { name, withOriginal: false });
      // The notes stay on the built-in track (muted) for the editor and the video; the audio is the plugin's.
      track.visible = false;
      c.store.update((s) => s.tracks.push(track));
      const solo = (tracks: Track[]): Song => {
        const s = cloneSong(c.store.song);
        s.tracks = s.tracks.filter((t) => tracks.some((x) => x.id === t.id));
        for (const t of s.tracks) t.mute = t.solo = false;
        return s;
      };
      // Level: as loud as the built-in track was, once rendered.
      const level = async (tracks: Track[]) => rms(await renderSong(solo(tracks), { from: 0, to: duration - 2, tail: 0, dynamics: false, sampleRate: 22050 }));
      const want = await level([builtin]);
      const got = await level([track]);
      if (got > 0 && want > 0) c.store.update(() => (track.volume = Math.round(Math.max(0.02, Math.min(1.5, track.volume * (want / got))) * 1000) / 1000));
      // The score of the part, with the built-in sound and with the plugin's.
      const others = song.tracks.filter((t) => r.part === 'other' && t !== builtin && t !== track && ['chords', 'melody'].includes(c.roleOf.get(t.id) ?? ''));
      const spans = busyStretches(c.store.song, builtin, 8, 3);
      const stem = r.part === 'other' ? c.stems.other : c.stems.drums;
      const before = await partScore(solo([builtin, ...others]), stem, c.offset, r.part, spans);
      const after = await partScore(solo([track, ...others]), stem, c.offset, r.part, spans);
      if (after + TOLERANCE >= before) {
        c.store.update(() => (builtin.mute = true));
        c.roleOf.set(track.id, r.role);
        report.push(`VST ${r.label}: ${sounds[r.role].name}, matches the original ${Math.round(after)} of 100 (the built-in ${builtin.instrument} sound: ${Math.round(before)})`);
      } else {
        c.store.update((s) => (s.tracks = s.tracks.filter((t) => t.id !== track.id)));
        report.push(`VST ${r.label}: ${sounds[r.role].name} matches the original ${Math.round(after)} of 100, the built-in sound ${Math.round(before)}: kept the built-in one`);
      }
    } catch (e) {
      report.push(`VST ${r.label}: couldn't use ${sounds[r.role].name} (${(e as Error).message})`);
    }
  }
  return report;
}
