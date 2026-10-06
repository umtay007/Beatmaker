/**
 * Your own VST instrument in the remake (desktop app only). A sound is picked once in the plugin's
 * own window (`Beatmaker.exe --pick-sound melody`) and captured as samples; after that the remake's
 * chords and melody (the "other" part of the song, which is usually one instrument) are played with
 * it and come back as audio tracks that replace the built-in ones.
 *
 * A VST sound stays unless its notes start against the original's (the attack measure in
 * audio/compare.ts, which also says how it compares with the built-in sound): a plugin can't make
 * a bad transcription good.
 */
import { Attacks } from '../audio/compare';
import type { Role } from '../audio/compare';
import { busyStretches } from '../audio/finder';
import { renderSong } from '../audio/render';
import { Timeline } from '../core/timing';
import { BAR, cloneSong, type Song, type Track } from '../core/types';
import type { Store } from '../core/store';
import { desktop } from './desktop';
import { vocalTrack } from './vocaltrack';

/** The parts this plays, and which picked sound each uses (chords take the melody's sound unless they have their own). */
const ROLES: { role: 'melody' | 'chords'; sounds: string[]; label: string }[] = [
  { role: 'melody', sounds: ['melody'], label: 'melody' },
  { role: 'chords', sounds: ['chords', 'melody'], label: 'chords' },
];
/** A VST sound was picked on purpose: it is used unless its attacks run against the original's (a correlation below this). */
const LEAST = 0;

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

/** Play the chords and melody with the picked VST sound; returns lines for the report. */
export async function applyVstSounds(c: VstContext): Promise<string[]> {
  const app = desktop();
  if (!app?.vstSounds || !app.vstRender) return [];
  const sounds = await app.vstSounds();
  const song = c.store.song;
  const wanted = ROLES.map((r) => ({ ...r, sound: r.sounds.find((s) => sounds[s]) })).filter((r) => r.sound && song.tracks.some((t) => c.roleOf.get(t.id) === r.role));
  if (!wanted.length) return [];
  const tl = new Timeline(song);
  const duration = tl.tickToSec(song.bars * BAR) + 2;
  const trackOf = (role: string): Track => song.tracks.find((t) => c.roleOf.get(t.id) === role && !t.mute)!;
  const secNotes = (t: Track) => t.notes.map((n) => ({ p: n.pitch, s: tl.tickToSec(n.start), e: tl.tickToSec(n.start + n.dur), v: n.vel }));
  const res = await app.vstRender({ duration, parts: wanted.map((r) => ({ role: r.role, sound: r.sound, notes: secNotes(trackOf(r.role)) })) });
  if (res.error || !res.files) return [`VST sounds: not used (${res.error ?? 'nothing came back'})`];

  const report: string[] = [];
  const ctx = new OfflineAudioContext(2, 1, 44100);
  for (const r of wanted) {
    const builtin = trackOf(r.role);
    const wav = res.files[r.role];
    const name = sounds[r.sound!].name;
    try {
      const buf = await ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
      if (rms(buf) < 1e-5) {
        report.push(`VST ${r.label}: ${name} played nothing (is the sound loaded?), so the built-in one stays`);
        continue;
      }
      // How the notes start, against the original's, with the built-in sound and with the plugin's.
      const spans = busyStretches(song, builtin, 8, 3);
      const notes = secNotes(builtin);
      const att = await Attacks.of(c.stems.other, c.offset, notes, spans);
      const solo = (tracks: Track[]): Song => {
        const s = cloneSong(c.store.song);
        s.tracks = s.tracks.filter((t) => tracks.some((x) => x.id === t.id));
        for (const t of s.tracks) t.mute = t.solo = false;
        return s;
      };
      const before = att ? await att.score(solo([builtin])) : 0;
      const after = att ? await att.scoreAudio(buf) : 0;
      if (att && after < LEAST) {
        report.push(`VST ${r.label}: ${name} starts its notes against the original's (${after.toFixed(2)}; the built-in sound ${before.toFixed(2)}), so the built-in one stays`);
        continue;
      }
      const track = await vocalTrack(buf, song, builtin.color, { name: `${builtin.name} (${name})`, withOriginal: false });
      // The notes stay on the built-in track (muted) for the editor and the video; the audio is the plugin's.
      track.visible = false;
      c.store.update((s) => s.tracks.push(track));
      // As loud as the built-in track was.
      const level = async (tracks: Track[]) => rms(await renderSong(solo(tracks), { from: 0, to: Math.min(60, duration - 2), tail: 0, dynamics: false, sampleRate: 22050 }));
      const want = await level([builtin]);
      const got = await level([track]);
      if (got > 0 && want > 0) c.store.update(() => (track.volume = Math.round(Math.max(0.02, Math.min(1.5, track.volume * (want / got))) * 1000) / 1000));
      c.store.update(() => (builtin.mute = true));
      c.roleOf.set(track.id, r.role);
      report.push(`VST ${r.label}: ${name}${att ? `, its notes start like the original's (${after.toFixed(2)}; the built-in ${builtin.instrument} sound: ${before.toFixed(2)})` : ''}`);
    } catch (e) {
      report.push(`VST ${r.label}: couldn't use ${name} (${(e as Error).message})`);
    }
  }
  return report;
}
