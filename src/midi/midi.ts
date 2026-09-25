import { estimateKey, normalizeDrumPitch } from '../core/theory';
import { Timeline } from '../core/timing';
import { BAR, MAX_BARS, newNoteId, newTrackId, PPQ, type Note, type Song, type Track } from '../core/types';
import { KIT_BY_ID } from '../audio/drums';

// ---------------------------------------------------------------------------------------------
// Standard MIDI File parser

interface RawNote {
  tick: number;
  dur: number;
  pitch: number;
  vel: number;
  channel: number;
}

interface RawTrack {
  name: string;
  notes: RawNote[];
  programs: Map<number, number>;
}

interface ParsedMidi {
  division: number;
  tracks: RawTrack[];
  tempos: { tick: number; bpm: number }[];
  keySig: { key: number; scale: 'major' | 'minor' } | null;
}

// Circle of fifths: sharps/flats count → major key pitch class.
const SF_TO_MAJOR = [11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1]; // index sf + 7

class Reader {
  pos = 0;
  constructor(readonly d: DataView) {}
  u8(): number {
    return this.d.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.d.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.d.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }
  str(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

export function parseMidi(buf: ArrayBuffer): ParsedMidi {
  const r = new Reader(new DataView(buf));
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = r.u32();
  r.u16(); // format
  const ntracks = r.u16();
  let division = r.u16();
  r.pos = 8 + hlen;
  if (division & 0x8000) {
    // SMPTE timing – approximate as ticks per quarter at 120 bpm.
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    division = Math.round((fps * tpf) / 2);
  }
  const tracks: RawTrack[] = [];
  const tempos: { tick: number; bpm: number }[] = [];
  let keySig: ParsedMidi['keySig'] = null;

  for (let ti = 0; ti < ntracks && r.pos < buf.byteLength - 8; ti++) {
    const id = r.str(4);
    const len = r.u32();
    const end = r.pos + len;
    if (id !== 'MTrk') {
      r.pos = end;
      ti--;
      continue;
    }
    const track: RawTrack = { name: '', notes: [], programs: new Map() };
    const open = new Map<number, { tick: number; vel: number }[]>();
    let tick = 0;
    let status = 0;
    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const l = r.vlq();
        const start = r.pos;
        if (type === 0x51 && l === 3) {
          const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          tempos.push({ tick, bpm: 60000000 / us });
        } else if (type === 0x59 && l === 2 && !keySig) {
          const sf = (r.u8() << 24) >> 24;
          const minor = r.u8() === 1;
          const major = SF_TO_MAJOR[Math.max(-7, Math.min(7, sf)) + 7];
          keySig = { key: minor ? (major + 9) % 12 : major, scale: minor ? 'minor' : 'major' };
        } else if ((type === 0x03 || type === 0x04) && !track.name) {
          track.name = decodeText(new Uint8Array(buf, start, l));
        } else if (type === 0x2f) {
          r.pos = start + l;
          break;
        }
        r.pos = start + l;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.pos += r.vlq();
        continue;
      }
      if (b & 0x80) {
        status = b;
        b = r.u8();
      } else if (!status) {
        throw new Error('Invalid MIDI data');
      }
      const type = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = b;
      const d2 = type === 0xc0 || type === 0xd0 ? 0 : r.u8();
      if (type === 0x90 && d2 > 0) {
        const key = ch * 128 + d1;
        let stack = open.get(key);
        if (!stack) open.set(key, (stack = []));
        stack.push({ tick, vel: d2 });
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        const key = ch * 128 + d1;
        const on = open.get(key)?.shift();
        if (on) track.notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), pitch: d1, vel: on.vel, channel: ch });
      } else if (type === 0xc0) {
        if (!track.programs.has(ch)) track.programs.set(ch, d1);
      }
    }
    // Close hanging notes.
    for (const [key, stack] of open) {
      for (const on of stack) {
        track.notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), pitch: key % 128, vel: on.vel, channel: Math.floor(key / 128) });
      }
    }
    r.pos = end;
    tracks.push(track);
  }
  return { division, tracks, tempos, keySig };
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0/g, '').trim();
  } catch {
    return String.fromCharCode(...bytes).trim();
  }
}

// ---------------------------------------------------------------------------------------------
// General MIDI ↔ instrument mapping

export function gmToInstrument(program: number): string {
  if (program <= 3) return 'piano';
  if (program <= 5) return 'epiano';
  if (program <= 7) return 'piano';
  if (program === 8 || program === 9) return 'glock';
  if (program <= 11) return 'bell';
  if (program <= 13) return 'marimba';
  if (program <= 15) return 'bell';
  if (program <= 23) return 'organ';
  if (program <= 31) return 'pluck';
  if (program <= 37) return 'deepbass';
  if (program <= 39) return 'reese';
  if (program <= 51) return 'strings';
  if (program <= 54) return 'choir';
  if (program === 55) return 'brass';
  if (program <= 63) return 'brass';
  if (program <= 71) return 'lead';
  if (program <= 79) return 'flute';
  if (program === 80) return 'chip';
  if (program <= 87) return 'lead';
  if (program <= 103) return 'pad';
  if (program <= 111) return 'pluck';
  if (program <= 119) return 'marimba';
  return 'pluck';
}

const INSTRUMENT_TO_GM: Record<string, number> = {
  bass808: 38, bass808s: 38, bass808p: 38, sub: 38, deepbass: 33, reese: 39, logdrum: 116, pluck: 25, marimba: 12,
  epiano: 4, piano: 0, organ: 16, pad: 89, strings: 48, darkstrings: 49, choir: 52, supersaw: 81, lead: 81, sinelead: 80,
  flute: 73, brass: 61, chip: 80, bell: 14, glock: 9,
};

const DRUM_NAME_RULES: [RegExp, number][] = [
  [/open|\boh\b/i, 46],
  [/hat|\bhh\b|hihat|hi-hat/i, 42],
  [/kick|\bbd\b|\bkck\b/i, 36],
  [/snare|\bsd\b|\bsnr\b/i, 38],
  [/clap|\bcp\b/i, 39],
  [/rim/i, 37],
  [/crash|cymbal/i, 49],
  [/ride/i, 51],
  [/shaker|shake/i, 70],
  [/tom/i, 47],
  [/cowbell/i, 56],
  [/perc|conga|bongo/i, 63],
];

function drumVoiceFromName(name: string): number | null {
  for (const [re, p] of DRUM_NAME_RULES) if (re.test(name)) return p;
  return null;
}

// ---------------------------------------------------------------------------------------------

export interface ImportOptions {
  palette: string[];
  kit?: string;
}

/** Convert a parsed MIDI file into a Beatmaker song. */
export function midiToSong(buf: ArrayBuffer, fileName: string, opts: ImportOptions): Song {
  const midi = parseMidi(buf);
  const scale = PPQ / midi.division;
  const toTick = (t: number) => Math.round(t * scale);
  const tempos = midi.tempos.sort((a, b) => a.tick - b.tick);
  const bpm = tempos.length ? tempos[0].bpm : 120;
  const tempoChanges = tempos
    .filter((t) => t.tick > 0)
    .map((t) => ({ tick: toTick(t.tick), bpm: Math.round(t.bpm * 1000) / 1000 }))
    .filter((t, i, arr) => i === 0 || Math.abs(t.bpm - arr[i - 1].bpm) > 0.001);

  const tracks: Track[] = [];
  let colorIdx = 0;
  const kit = opts.kit && KIT_BY_ID.has(opts.kit) ? opts.kit : 'trap';
  let maxStart = 0;

  for (const rt of midi.tracks) {
    const byChannel = new Map<number, RawNote[]>();
    for (const n of rt.notes) {
      let arr = byChannel.get(n.channel);
      if (!arr) byChannel.set(n.channel, (arr = []));
      arr.push(n);
    }
    for (const [ch, raw] of byChannel) {
      if (!raw.length) continue;
      const nameVoice = drumVoiceFromName(rt.name);
      const distinct = new Set(raw.map((n) => n.pitch)).size;
      const isGmDrums = ch === 9;
      const isNamedDrum = !isGmDrums && nameVoice !== null && distinct <= 3 && !/bass|808|synth|lead|keys|bell/i.test(rt.name);
      const kind = isGmDrums || isNamedDrum ? 'drums' : 'synth';
      let instrument: string;
      let name = rt.name || '';
      if (kind === 'drums') {
        instrument = kit;
        if (!name) name = 'Drums';
      } else {
        const prog = rt.programs.get(ch);
        const avg = raw.reduce((s, n) => s + n.pitch, 0) / raw.length;
        if (/808/i.test(rt.name)) instrument = 'bass808';
        else if (/bass|sub/i.test(rt.name)) instrument = avg < 40 ? 'bass808' : 'deepbass';
        else if (prog !== undefined) instrument = gmToInstrument(prog);
        else if (avg < 45) instrument = 'bass808';
        else if (/pad|string/i.test(rt.name)) instrument = 'pad';
        else if (/bell/i.test(rt.name)) instrument = 'bell';
        else if (/lead|melod|flute/i.test(rt.name)) instrument = 'pluck';
        else instrument = 'epiano';
        if (!name) name = `Track ${tracks.length + 1}`;
      }
      const notes: Note[] = raw.map((n) => {
        const start = toTick(n.tick);
        const dur = Math.max(1, toTick(n.dur));
        maxStart = Math.max(maxStart, start);
        return {
          id: newNoteId(),
          pitch: kind === 'drums' ? (isNamedDrum ? nameVoice! : normalizeDrumPitch(n.pitch)) : n.pitch,
          start,
          dur: kind === 'drums' ? Math.min(dur, PPQ / 4) : dur,
          vel: Math.max(0.05, Math.min(1, n.vel / 127)),
        };
      });
      tracks.push({
        id: newTrackId(),
        name: name.slice(0, 40),
        kind,
        instrument,
        color: opts.palette[colorIdx++ % opts.palette.length],
        volume: kind === 'drums' ? 0.85 : 0.75,
        pan: 0,
        reverb: kind === 'drums' ? 0.05 : 0.18,
        mute: false,
        solo: false,
        visible: true,
        notes,
      });
    }
  }
  if (!tracks.length) throw new Error('No notes found in this MIDI file');

  const bars = Math.min(MAX_BARS, Math.max(1, Math.ceil((maxStart + 1) / BAR)));
  const { key, scale: sc } = midi.keySig ?? detectKey(tracks);
  return {
    name: fileName.replace(/\.(mid|midi)$/i, ''),
    artist: '',
    bpm: Math.round(bpm * 100) / 100,
    tempoChanges,
    swing: 0,
    bars,
    key,
    scale: sc,
    tracks,
    loop: { enabled: false, start: 0, end: Math.min(bars, 4) * BAR },
    audioOffset: 0,
    synthsWithAudio: false,
  };
}

/** Key estimate from the notes' pitch classes, weighted by duration. */
export function detectKey(tracks: Track[]): { key: number; scale: string } {
  const hist = new Array(12).fill(0);
  for (const t of tracks) {
    if (t.kind === 'drums') continue;
    for (const n of t.notes) hist[n.pitch % 12] += n.dur;
  }
  if (hist.every((v) => v === 0)) return { key: 0, scale: 'minor' };
  const { key, scale } = estimateKey(hist);
  return { key, scale };
}

// ---------------------------------------------------------------------------------------------
// Writer

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function textBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function chunk(id: string, data: number[]): number[] {
  const len = data.length;
  return [...textBytes(id), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

export function songToMidi(song: Song): Uint8Array {
  const out: number[] = [];
  const tl = new Timeline(song);
  out.push(...chunk('MThd', [0, 1, 0, song.tracks.length + 1, 0, PPQ]));

  // Tempo track
  const tempo: number[] = [];
  const name = textBytes(song.name);
  tempo.push(0, 0xff, 0x03, ...vlq(name.length), ...name);
  tempo.push(0, 0xff, 0x58, 4, 4, 2, 24, 8);
  {
    // Key signature (modes are written as their parallel major/minor).
    const minor = ['minor', 'dorian', 'phrygian', 'harmonic', 'minpent', 'blues'].includes(song.scale);
    const majorPc = minor ? (song.key + 3) % 12 : song.key;
    let sf = SF_TO_MAJOR.indexOf(majorPc, 2) - 7;
    if (sf < -7 || sf > 7) sf = 0;
    tempo.push(0, 0xff, 0x59, 2, sf & 0xff, minor ? 1 : 0);
  }
  const changes = [{ tick: 0, bpm: song.bpm }, ...song.tempoChanges];
  let last = 0;
  for (const c of changes) {
    const us = Math.round(60000000 / c.bpm);
    tempo.push(...vlq(c.tick - last), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    last = c.tick;
  }
  tempo.push(0, 0xff, 0x2f, 0);
  out.push(...chunk('MTrk', tempo));

  let nextCh = 0;
  for (const t of song.tracks) {
    let ch: number;
    if (t.kind === 'drums') ch = 9;
    else {
      if (nextCh === 9) nextCh++;
      ch = nextCh % 16;
      nextCh++;
    }
    const data: number[] = [];
    const tn = textBytes(t.name);
    data.push(0, 0xff, 0x03, ...vlq(tn.length), ...tn);
    if (t.kind === 'synth') data.push(0, 0xc0 | ch, INSTRUMENT_TO_GM[t.instrument] ?? 0);
    const evs: { tick: number; on: boolean; pitch: number; vel: number }[] = [];
    for (const n of t.notes) {
      const v = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
      // Bake swing into the ticks: other apps would otherwise play the groove straight.
      const on = Math.round(tl.swingTick(n.start));
      const off = Math.max(on + 1, Math.round(tl.swingTick(n.start + Math.max(1, n.dur))));
      evs.push({ tick: on, on: true, pitch: n.pitch, vel: v });
      evs.push({ tick: off, on: false, pitch: n.pitch, vel: 0 });
    }
    evs.sort((a, b) => a.tick - b.tick || (a.on === b.on ? 0 : a.on ? 1 : -1));
    let prev = 0;
    for (const e of evs) {
      data.push(...vlq(e.tick - prev), (e.on ? 0x90 : 0x80) | ch, e.pitch & 127, e.vel);
      prev = e.tick;
    }
    data.push(0, 0xff, 0x2f, 0);
    out.push(...chunk('MTrk', data));
  }
  return new Uint8Array(out);
}
