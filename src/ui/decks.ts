/**
 * Two-deck stem mixer: two songs, each split into vocals, drums, bass and the rest, played in time with
 * each other. The four pads in the middle say which song each part comes from; a click hands that part
 * to the other song on the next beat. "Transition" hands all four over in stages (drums, bass, the rest,
 * vocals), two bars apart.
 *
 * Each deck plays through Signalsmith Stretch (MIT), so Sync changes a song's tempo without moving its pitch,
 * and Key can shift the incoming song into the lead song's key.
 */
import SignalsmithStretch, { type StretchNode } from '../vendor/signalsmith-stretch.mjs';
import { detectAudioKey } from '../audio/key';
import { separateStems, type Stems } from '../audio/separate';
import { detectTempo, peakEnvelope } from '../audio/tempo';
import { encodeWav } from '../audio/render';
import { desktop } from './desktop';
import { downloadBlob, h, pickFile, toast } from './dom';

const STEMS = ['vocals', 'other', 'bass', 'drums'] as const;
type StemName = (typeof STEMS)[number];
const LABEL: Record<StemName, string> = { vocals: 'Vocals', other: 'Melody', bass: 'Bass', drums: 'Drums' };
const KEYS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const PEAK_RATE = 200;
const COLORS = ['#b98cf0', '#c9a15a'];

interface Deck {
  side: 0 | 1;
  name: string;
  buf: AudioBuffer | null;
  stems: Stems | null;
  bpm: number;
  firstBeat: number;
  key: string;
  peaks: Float32Array | null;
  gains: Record<StemName, GainNode>;
  out: GainNode;
  node: StretchNode;
  split: ChannelSplitterNode;
  /** Pitch shift in semitones (key matching). */
  semi: number;
  keyPc: number;
  minor: boolean;
  playing: boolean;
  startCtx: number;
  startPos: number;
  rate: number;
  status: string;
  /** A warning about the beat grid, shown on the deck. */
  gridNote: string;
  abort: AbortController | null;
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];

/**
 * A steady grid from tracked beats and downbeats: the tempo from the beats (their spacing is the reliable part),
 * bar 1 from the downbeats when they fall four (or three) beats apart, else from the first beat with a warning.
 */
export function gridFrom(beats: number[], downbeats: number[]): { bpm: number; firstBeat: number; gridNote: string } | null {
  if (beats.length < 8) return null;
  const rough = median(beats.slice(1).map((t, i) => t - beats[i]));
  // A line through the beats against their beat numbers (numbered by rounding, so a missed beat leaves a gap
  // instead of shifting the count), fitted twice: the second pass numbers them with the better tempo.
  let beat = rough;
  let origin = beats[0];
  for (let pass = 0; pass < 2; pass++) {
    const idx = beats.map((t) => Math.round((t - origin) / beat));
    const mi = idx.reduce((x, v) => x + v, 0) / idx.length;
    const mt = beats.reduce((x, v) => x + v, 0) / beats.length;
    beat = idx.reduce((x, v, i) => x + (v - mi) * (beats[i] - mt), 0) / idx.reduce((x, v) => x + (v - mi) ** 2, 0);
    origin = mt - mi * beat;
  }
  const bpm = Math.round((60 / beat) * 10) / 10;
  const barGap = downbeats.length >= 3 ? median(downbeats.slice(1).map((t, i) => t - downbeats[i])) : 0;
  if (Math.abs(barGap / beat - 4) < 0.3) {
    const bar = 4 * beat;
    // where the downbeats sit within the bar, as an angle so the wrap-around averages properly
    const ang = downbeats.map((t) => ((t % bar) / bar) * 2 * Math.PI);
    const mean = Math.atan2(ang.reduce((x, v) => x + Math.sin(v), 0), ang.reduce((x, v) => x + Math.cos(v), 0));
    const firstBeat = (((mean / (2 * Math.PI)) * bar) % bar + bar) % bar;
    // how far the beats stray from the steady grid (the 95th percentile: a few stray detections don't count)
    const off = beats.map((t) => { const ph = ((t - origin) % beat + beat) % beat; return Math.min(ph, beat - ph); }).sort((x, y) => x - y);
    const drift = off[Math.floor(off.length * 0.95)];
    return { bpm, firstBeat, gridNote: drift > beat / 4 ? `The tempo drifts: beats stray up to ${Math.round(drift * 1000)} ms from a steady grid` : '' };
  }
  return { bpm, firstBeat: beats[0] % (4 * beat), gridNote: 'Bar lines uncertain: check where bar 1 starts (grid buttons)' };
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const FADE_IN = Float32Array.from({ length: 33 }, (_, i) => Math.sin((i / 32) * (Math.PI / 2)));
const FADE_OUT = Float32Array.from({ length: 33 }, (_, i) => Math.cos((i / 32) * (Math.PI / 2)));

export async function showDecks(): Promise<void> {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  // A safety limiter: two songs' parts can add up past full scale.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -8, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
  master.connect(limiter);
  limiter.connect(ctx.destination);
  const tap = ctx.createMediaStreamDestination();
  limiter.connect(tap);
  /** How late the stretch engine's audio is against its schedule (measured: both decks alike, 168 ms). */
  const LAT = 0.168;

  // One stretch node per deck carries all of its audio, so the parts cannot drift apart: channel pairs 0-3 are
  // the four parts, pair 4 is the whole song (heard until the parts are separated).
  // One (unused) input on purpose: with none, the library's idle path reads a missing input, throws, and the node is dead.
  const newNode = () => SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [10] });
  const mkDeck = async (side: 0 | 1): Promise<Deck> => {
    const out = ctx.createGain();
    out.connect(master);
    const node = await newNode();
    const split = ctx.createChannelSplitter(10);
    node.connect(split);
    const pair = (i: number, dest: AudioNode) => {
      const m = ctx.createChannelMerger(2);
      split.connect(m, 2 * i, 0);
      split.connect(m, 2 * i + 1, 1);
      m.connect(dest);
    };
    const gains = {} as Record<StemName, GainNode>;
    STEMS.forEach((s, i) => {
      gains[s] = ctx.createGain();
      gains[s].connect(out);
      pair(i, gains[s]);
    });
    pair(4, out);
    return { side, name: '', buf: null, stems: null, bpm: 120, firstBeat: 0, key: '', peaks: null, gains, out, node, split, semi: 0, keyPc: 0, minor: false, playing: false, startCtx: 0, startPos: 0, rate: 1, status: '', gridNote: '', abort: null };
  };
  const decks: [Deck, Deck] = [await mkDeck(0), await mkDeck(1)];
  let keyMatch = false;
  /** A buffer's channels at the context's sample rate (the stretch node takes raw samples). */
  const atRate = async (b: AudioBuffer): Promise<Float32Array[]> => {
    let x = b;
    if (b.sampleRate !== ctx.sampleRate) {
      const off = new OfflineAudioContext(2, Math.ceil(b.duration * ctx.sampleRate), ctx.sampleRate);
      const src = off.createBufferSource();
      src.buffer = b;
      src.connect(off.destination);
      src.start();
      x = await off.startRendering();
    }
    return [x.getChannelData(0), x.getChannelData(x.numberOfChannels > 1 ? 1 : 0)];
  };
  const setBuffers = async (d: Deck) => {
    if (!d.buf) return;
    const parts = d.stems ? await Promise.all(STEMS.map((s) => atRate(d.stems![s]))) : null;
    const mix = parts ? null : await atRate(d.buf);
    const len = Math.max(...(parts ? parts.flat() : mix!).map((c) => c.length));
    const fit = (c: Float32Array | null) => {
      if (c && c.length === len) return c;
      const o = new Float32Array(len);
      if (c) o.set(c);
      return o;
    };
    const silent = fit(null);
    const chans = parts ? [...parts.flat().map(fit), silent, silent] : [...Array<Float32Array>(8).fill(silent), ...mix!.map(fit)];
    // A fresh node for each load: the library's dropBuffers() never returns when channels share one array (the
    // silent ones do), and sharing them is what keeps the memory down.
    d.node.schedule({ active: false });
    d.node.disconnect();
    d.node = await newNode();
    d.node.connect(d.split);
    await d.node.addBuffers(chans);
  };
  /** Semitones that bring `d` into `ref`'s key (relative major and minor count as one key), the shorter way round. */
  const keyShift = (d: Deck, ref: Deck): number => {
    const tonic = (x: Deck) => (x.keyPc + (x.minor ? 3 : 0)) % 12;
    return ((tonic(ref) - tonic(d) + 18) % 12) - 6;
  };
  /** Which deck each part is heard from. */
  const assign: Record<StemName, 0 | 1> = { vocals: 0, other: 0, bass: 0, drums: 0 };
  let sync = true;
  let rec: MediaRecorder | null = null;
  let busy = false; // a transition is under way

  /** Where the deck is heard to be now (the engine's delay taken off). */
  const pos = (d: Deck) => (d.playing ? d.startPos + Math.max(0, ctx.currentTime - LAT - d.startCtx) * d.rate : d.startPos);
  const lead = (): Deck => decks[STEMS.filter((s) => assign[s] === 1).length > 2 ? 1 : 0];
  const beatLen = (d: Deck) => 60 / d.bpm;

  /** The speed that plays `d` at the tempo `ref` is heard at (folding half and double time). */
  const syncRate = (d: Deck, ref: Deck): number => {
    let target = ref.bpm * ref.rate;
    while (target / d.bpm > 1.42) target /= 2;
    while (target / d.bpm < 0.71) target *= 2;
    return target / d.bpm;
  };

  const stopSources = (d: Deck) => d.node.schedule({ active: false });
  // `when` is when it should be HEARD: the engine is told LAT earlier. (Times here are heard times throughout.)
  const start = (d: Deck, from: number, heard = ctx.currentTime + LAT + 0.05) => {
    if (!d.buf) return;
    const when = Math.max(ctx.currentTime + 0.02, heard - LAT);
    const at = Math.max(0, Math.min(from, d.buf.duration - 0.05));
    d.node.schedule({ output: when, active: true, input: at, rate: d.rate, semitones: d.semi });
    d.playing = true;
    d.startCtx = when;
    d.startPos = at;
  };
  const pause = (d: Deck) => {
    d.startPos = pos(d);
    d.playing = false;
    stopSources(d);
  };
  const applyGains = () => {
    const t = ctx.currentTime;
    for (const d of decks)
      for (const s of STEMS) {
        d.gains[s].gain.cancelScheduledValues(t);
        d.gains[s].gain.setValueAtTime(assign[s] === d.side ? 1 : 0, t);
      }
  };

  /** When (context time) `d` next reaches a multiple of `beats` on its grid, and where in the song that is. */
  const nextBoundary = (d: Deck, beats: number): { when: number; at: number } => {
    const p = pos(d);
    if (!d.playing) return { when: ctx.currentTime + 0.05, at: p };
    const unit = beats * beatLen(d);
    let at = d.firstBeat + Math.ceil((p - d.firstBeat) / unit + 0.02) * unit;
    // far enough ahead for the other deck to be started in time for it
    while ((at - p) / d.rate < LAT + 0.05) at += unit;
    return { when: ctx.currentTime + (at - p) / d.rate, at };
  };
  /** Start the other deck in time with the playing one, on the playing one's next bar. Returns when. */
  const bringIn = (to: Deck, from: Deck): number => {
    if (to.playing) return nextBoundary(from, 1).when;
    const { when } = nextBoundary(from, 4);
    to.rate = sync && from.buf ? syncRate(to, from) : 1;
    to.semi = keyMatch ? keyShift(to, from) : 0;
    const bar = 4 * beatLen(to);
    const at = to.firstBeat + Math.max(0, Math.ceil((to.startPos - to.firstBeat) / bar - 0.001)) * bar;
    start(to, at, when);
    return when;
  };
  /** Hand one part to deck `side` at `when`, fading over `dur` seconds (equal power). */
  const swap = (stem: StemName, side: 0 | 1, when: number, dur: number) => {
    for (const d of decks) {
      const g = d.gains[stem].gain;
      g.cancelScheduledValues(when);
      g.setValueCurveAtTime(d.side === side ? FADE_IN : FADE_OUT, Math.max(when, ctx.currentTime + 0.005), dur);
    }
    window.setTimeout(() => {
      assign[stem] = side;
      refresh();
    }, Math.max(0, (when - ctx.currentTime + dur / 2) * 1000));
  };
  const padClick = (stem: StemName) => {
    const to = decks[assign[stem] === 0 ? 1 : 0];
    const from = decks[assign[stem]];
    if (!to.stems || !from.stems) return void toast('Both songs need their parts separated first.', 'info');
    if (busy) return;
    void ctx.resume();
    const when = from.playing ? bringIn(to, from) : ctx.currentTime + 0.05;
    if (!from.playing) {
      assign[stem] = to.side;
      applyGains();
      refresh();
    } else swap(stem, to.side, when, 0.06);
  };
  /** Which parts play in each bar of a deck: louder than a quarter of that part's usual level. */
  const activity = (d: Deck): Record<StemName, boolean[]> => {
    const bar = 4 * beatLen(d);
    const n = Math.max(0, Math.floor((d.buf!.duration - d.firstBeat) / bar));
    const out = {} as Record<StemName, boolean[]>;
    for (const st of STEMS) {
      const buf = d.stems![st];
      const ch = buf.getChannelData(0);
      const rms: number[] = [];
      for (let k = 0; k < n; k++) {
        const from = Math.floor((d.firstBeat + k * bar) * buf.sampleRate);
        const to = Math.min(ch.length, Math.floor((d.firstBeat + (k + 1) * bar) * buf.sampleRate));
        let sum = 0;
        for (let i = from; i < to; i += 4) sum += ch[i] * ch[i];
        rms.push(Math.sqrt(sum / Math.max(1, (to - from) / 4)));
      }
      const usual = [...rms].sort((x, y) => x - y)[Math.floor(rms.length * 0.9)] ?? 0;
      out[st] = rms.map((v) => v > 0.25 * usual && v > 1e-3);
    }
    return out;
  };
  /**
   * Hand the mix to the other song, planned from what the two songs are doing: it starts on the playing song's
   * next 8-bar phrase, brings the other in from its first phrase with at least two parts playing, never lets two
   * basslines or two lead vocals sound together, and takes 8 bars when both songs are busy, 4 otherwise.
   */
  const transition = () => {
    const from = lead();
    const to = decks[from.side === 0 ? 1 : 0];
    if (!to.stems || !from.stems) return void toast('Both songs need their parts separated first.', 'info');
    if (!from.playing) return void toast('Play a song first.', 'info');
    if (busy) return;
    void ctx.resume();
    if (to.playing) pause(to);
    const A = activity(from);
    const B = activity(to);
    const barF = 4 * beatLen(from);
    const barT = 4 * beatLen(to);
    const now = pos(from);
    // the next phrase line that leaves time to start the other deck
    let exit = Math.ceil(((now - from.firstBeat) / barF + 0.5) / 8) * 8;
    if (from.firstBeat + exit * barF > from.buf!.duration - 9 * barF) exit = Math.max(0, Math.floor((now - from.firstBeat) / barF) + 1);
    const count = (act: Record<StemName, boolean[]>, k: number) => STEMS.filter((x) => act[x][k] || act[x][k + 1]).length;
    let entry = 0;
    for (let k = 0; k < B.drums.length - 8; k += 8) if (count(B, k) >= 2) { entry = k; break; }
    const len = count(A, exit) >= 3 && count(B, entry) >= 3 ? 8 : 4;
    const span = (act: boolean[], k: number) => act.slice(k, k + len).some(Boolean);
    const vocA = span(A.vocals, exit);
    const vocB = span(B.vocals, entry);
    to.rate = sync ? syncRate(to, from) : 1;
    to.semi = keyMatch ? keyShift(to, from) : 0;
    const t0 = ctx.currentTime + (from.firstBeat + exit * barF - now) / from.rate;
    start(to, to.firstBeat + entry * barT, t0);
    const barRt = barF / from.rate;
    // when (in bars after the start) each part changes hands, and how long its fade is
    const at: Record<StemName, [number, number]> = {
      other: [span(A.other, exit) ? len / 4 : 0, barRt],
      drums: [len / 2, 0.1],
      bass: [len / 2, 0.1], // with the drums, cut not blended: two basslines together are mud
      vocals: vocA && vocB ? [len / 2, 0.08] : vocA ? [len, barRt / 2] : vocB ? [0, barRt / 2] : [len / 2, 0.1],
    };
    for (const st of STEMS) if (assign[st] !== to.side) swap(st, to.side, t0 + at[st][0] * barRt, at[st][1]);
    const notes: string[] = [];
    notes.push(`Starts at bar ${exit + 1} of ${from.name} (in ${Math.max(0, Math.round((t0 - ctx.currentTime) / barRt))} bars), ${len} bars long, ${to.name} comes in from its bar ${entry + 1}.`);
    notes.push(vocA && vocB ? 'Both have vocals there: they swap in one cut at the midpoint, so two leads never overlap.' : vocA ? 'Only the outgoing song sings there: its vocal stays to the end.' : vocB ? 'Only the incoming song sings there: its vocal comes in at once.' : 'No vocals in the overlap.');
    const stretch = Math.round((to.rate - 1) * 100);
    if (Math.abs(stretch) > 8) notes.push(`Low confidence: ${to.name} is stretched ${stretch > 0 ? '+' : ''}${stretch}% to match the tempo, which can sound unnatural.`);
    const apart = Math.abs(keyShift(to, from));
    if (!keyMatch && apart !== 0 && apart !== 5) notes.push(`Low confidence: the keys are ${apart} semitone${apart === 1 ? '' : 's'} apart and may clash. Try "Key: match".`);
    if (from.gridNote || to.gridNote) notes.push('Low confidence: a beat grid is uncertain (see the deck), so the songs may not line up.');
    plan.textContent = notes.join(' ');
    busy = true;
    window.setTimeout(() => {
      busy = false;
      pause(from);
      refresh();
    }, (t0 + (len + 0.5) * barRt - ctx.currentTime) * 1000);
    refresh();
  };

  const load = async (d: Deck) => {
    const file = await pickFile('audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac');
    if (!file) return;
    d.status = 'Reading…';
    refresh();
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(await file.arrayBuffer());
    } catch (e) {
      d.status = `Couldn't read it: ${(e as Error).message}`;
      return refresh();
    }
    await loadBuffer(d, buf, file.name.replace(/\.[^.]+$/, ''));
  };
  /** Put a decoded song on a deck; `given` skips the separation (parts already in hand). */
  const loadBuffer = async (d: Deck, buf: AudioBuffer, name: string, given?: Stems) => {
    d.abort?.abort();
    pause(d);
    try {
      const tempo = detectTempo(buf);
      const k = detectAudioKey(buf);
      Object.assign(d, { buf, stems: null, name, bpm: Math.round(tempo.bpm * 10) / 10, firstBeat: tempo.firstBeat, key: `${KEYS[k.key]} ${k.scale}`, keyPc: k.key, minor: k.scale === 'minor', semi: 0, gridNote: '', peaks: peakEnvelope(buf, PEAK_RATE), startPos: 0, rate: 1 });
      const other = decks[d.side === 0 ? 1 : 0];
      if (!other.buf) for (const s of STEMS) assign[s] = d.side;
      applyGains();
      await setBuffers(d);
      // Real beats and bar lines where the beat tracker is set up (desktop): the quick detector above only
      // guesses a tempo and takes the first beat for the downbeat. A straight line through the downbeats gives
      // the bar length and where bar 1 starts (a steady tempo is assumed; a drifting one is not followed).
      const app = desktop();
      if (!given && app?.beatsRun && (await app.beatsReady())) {
        d.status = 'Finding the beats…';
        refresh();
        const r = await app.beatsRun(new Uint8Array(await encodeWav(buf).arrayBuffer()));
        const g = gridFrom(r.beats ?? [], r.downbeats ?? []);
        if (g) Object.assign(d, g);
        else if (r.error) console.warn(r.error);
      }
      d.abort = new AbortController();
      d.status = 'Separating the parts…';
      refresh();
      const stems = given ?? await separateStems(buf, { signal: d.abort.signal, onProgress: (f, msg) => ((d.status = `${msg} ${Math.round(f * 100)}%`), refreshStatus()) });
      d.stems = stems;
      d.status = '';
      await setBuffers(d);
      if (d.playing) start(d, pos(d) + 0.1); // carry on from the same place, now as parts
    } catch (e) {
      d.status = (e as Error).name === 'AbortError' ? '' : `Couldn't load: ${(e as Error).message}`;
    }
    refresh();
  };

  // ---- interface
  const deckEl = (d: Deck) => {
    const title = h('div', { class: 'dk-title' });
    const sub = h('div', { class: 'dk-sub' });
    const status = h('div', { class: 'dk-status' });
    const disc = h('button', { class: 'dk-disc', title: 'Play / pause this song', onclick: () => {
      if (!d.buf) return void load(d);
      void ctx.resume();
      if (d.playing) pause(d);
      else {
        const o = decks[d.side === 0 ? 1 : 0];
        if (o.playing && sync) bringIn(d, o);
        else start(d, d.startPos);
      }
      refresh();
    } });
    const nudge = (bars: number) => () => {
      if (!d.buf) return;
      const to = pos(d) + bars * 4 * beatLen(d);
      if (d.playing) start(d, to);
      else d.startPos = Math.max(0, to);
      refresh();
    };
    const bpm = h('input', { class: 'dk-bpm', type: 'number', step: '0.1', min: '40', max: '240', title: 'Tempo (BPM): correct it here if the detection is off', onchange: () => {
      const v = Number(bpm.value);
      if (v >= 40 && v <= 240) d.bpm = v;
      refresh();
    } }) as HTMLInputElement;
    const grid = (beats: number) => () => {
      d.firstBeat += beats * beatLen(d);
      refresh();
    };
    const el = h('div', { class: `dk-deck dk-${d.side}` },
      title, sub,
      h('div', { class: 'dk-row' }, h('button', { class: 'dk-round', title: 'Back one bar', onclick: nudge(-1) }, '«'), disc, h('button', { class: 'dk-round', title: 'Forward one bar', onclick: nudge(1) }, '»')),
      h('div', { class: 'dk-row dk-small' },
        h('button', { class: 'dk-chip', onclick: () => void load(d) }, 'Change…'),
        bpm,
        h('button', { class: 'dk-chip', title: 'Half the tempo', onclick: () => ((d.bpm = Math.round(d.bpm * 5) / 10), refresh()) }, '½'),
        h('button', { class: 'dk-chip', title: 'Double the tempo', onclick: () => ((d.bpm = Math.round(d.bpm * 20) / 10), refresh()) }, '×2'),
        h('button', { class: 'dk-chip', title: 'Move the bar lines one beat earlier', onclick: grid(-1) }, '◂ grid'),
        h('button', { class: 'dk-chip', title: 'Move the bar lines one beat later', onclick: grid(1) }, 'grid ▸')),
      status);
    return { el, title, sub, status, disc, bpm };
  };
  const ui = [deckEl(decks[0]), deckEl(decks[1])];
  const pads = {} as Record<StemName, HTMLButtonElement>;
  for (const s of STEMS) pads[s] = h('button', { class: `dk-pad dk-pad-${s}`, onclick: () => padClick(s) }) as HTMLButtonElement;
  const keyBtn = h('button', { class: 'dk-chip', title: 'Shift the incoming song into the playing song’s key (applies when it is next brought in)', onclick: () => ((keyMatch = !keyMatch), refresh()) });
  const syncBtn = h('button', { class: 'dk-chip', title: 'Play the incoming song at the playing song’s tempo (its pitch is kept)', onclick: () => ((sync = !sync), refresh()) });
  const recBtn = h('button', { class: 'dk-chip', onclick: () => {
    if (rec) return void rec.stop();
    const chunks: Blob[] = [];
    const r = new MediaRecorder(tap.stream);
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      rec = null;
      refresh();
      void downloadBlob(new Blob(chunks, { type: r.mimeType }), 'Two-deck mix.webm');
    };
    r.start();
    rec = r;
    refresh();
  } });
  const transBtn = h('button', { class: 'dk-chip dk-trans', onclick: transition }, '⇄ Transition');
  const plan = h('div', { class: 'dk-plan' });
  const canvases = [h('canvas', { class: 'dk-wave' }) as HTMLCanvasElement, h('canvas', { class: 'dk-wave' }) as HTMLCanvasElement];
  canvases.forEach((c, i) => (c.onclick = (e) => {
    const d = decks[i];
    if (!d.buf) return;
    const to = pos(d) + ((e.offsetX - c.clientWidth / 2) / c.clientWidth) * 16;
    if (d.playing) start(d, to);
    else d.startPos = Math.max(0, Math.min(d.buf.duration, to));
  }));
  const clock = h('div', { class: 'dk-clock' });
  const playAll = h('button', { class: 'dk-round dk-play', onclick: () => {
    void ctx.resume();
    const l = lead();
    if (decks.some((d) => d.playing)) decks.forEach(pause);
    else if (l.buf) start(l, l.startPos);
    refresh();
  } });
  const close = () => {
    cancelAnimationFrame(raf);
    decks.forEach((d) => (d.abort?.abort(), stopSources(d)));
    rec?.stop();
    void ctx.close();
    root.remove();
  };
  const root = h('div', { class: 'dk' },
    h('div', { class: 'dk-top' }, recBtn, h('div', { class: 'dk-head' }, 'Two-deck mixer'), keyBtn, syncBtn, h('button', { class: 'dk-chip', onclick: close }, 'Close')),
    h('div', { class: 'dk-main' }, ui[0].el, h('div', { class: 'dk-pads' }, pads.vocals, h('div', { class: 'dk-padrow' }, pads.other, pads.bass), pads.drums, transBtn, plan), ui[1].el),
    h('div', { class: 'dk-waves' }, canvases[0], canvases[1]),
    h('div', { class: 'dk-bar' }, playAll, clock));
  document.body.append(root);

  const refreshStatus = () => decks.forEach((d, i) => (ui[i].status.textContent = d.status || d.gridNote));
  function refresh(): void {
    decks.forEach((d, i) => {
      const u = ui[i];
      u.title.textContent = d.name || 'No song';
      u.sub.textContent = d.buf ? `${d.key} · ${d.bpm} BPM${Math.abs(d.rate - 1) > 0.001 ? ` · at ${Math.round(d.bpm * d.rate * 10) / 10} BPM, pitch kept` : ''}${d.semi ? ` · key ${d.semi > 0 ? '+' : ''}${d.semi} st` : ''}${d === lead() && decks[1 - i].buf ? ' · lead' : ''}` : 'Click the disc to choose one';
      u.disc.textContent = !d.buf ? '+' : d.playing ? '❚❚' : '▶';
      if (document.activeElement !== u.bpm) u.bpm.value = String(d.bpm);
      u.bpm.hidden = !d.buf;
    });
    refreshStatus();
    for (const s of STEMS) {
      pads[s].textContent = LABEL[s];
      pads[s].dataset.side = String(assign[s]);
      pads[s].title = `${LABEL[s]}: from ${decks[assign[s]].name || 'deck ' + (assign[s] + 1)}. Click to take it from the other song on the next beat.`;
    }
    syncBtn.textContent = sync ? 'Sync: on' : 'Sync: off';
    keyBtn.textContent = keyMatch ? 'Key: match' : 'Key: original';
    recBtn.textContent = rec ? '■ Stop recording' : '● Record';
    transBtn.toggleAttribute('disabled', busy);
    playAll.textContent = decks.some((d) => d.playing) ? '❚❚' : '▶';
  }

  let raf = 0;
  const draw = () => {
    canvases.forEach((c, i) => {
      const d = decks[i];
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const hgt = (c.height = c.clientHeight * devicePixelRatio);
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, w, hgt);
      if (!d.peaks || !d.buf) return;
      const p = pos(d);
      const span = 16; // seconds across the view
      g.fillStyle = COLORS[i];
      for (let x = 0; x < w; x += 2) {
        const t = p + ((x - w / 2) / w) * span;
        const k = Math.round(t * PEAK_RATE);
        if (k < 0 || k >= d.peaks.length) continue;
        const a = Math.min(1, d.peaks[k] * 1.6) * hgt * 0.48;
        g.fillRect(x, hgt / 2 - a, 2, Math.max(1, a * 2));
      }
      g.fillStyle = 'rgba(255,255,255,0.35)';
      const bar = 4 * beatLen(d);
      for (let b = Math.ceil((p - span / 2 - d.firstBeat) / bar); d.firstBeat + b * bar < p + span / 2; b++) {
        const x = ((d.firstBeat + b * bar - p) / span + 0.5) * w;
        g.fillRect(x, 0, 1, hgt);
      }
      g.fillStyle = '#fff';
      g.fillRect(w / 2 - 1, 0, 2, hgt);
    });
    for (const d of decks) if (d.playing && d.buf && pos(d) >= d.buf.duration - 0.06) (pause(d), (d.startPos = 0), refresh());
    const l = lead();
    clock.textContent = l.buf ? `${l.name}   ${fmt(pos(l))} / ${fmt(l.buf.duration)}` : '';
    raf = requestAnimationFrame(draw);
  };
  applyGains();
  refresh();
  draw();
  // For tests and scripting: the same actions the buttons take.
  (window as unknown as Record<string, unknown>).beatmakerDecks = { gridFrom, ctx, master: limiter, decks, assign, loadBuffer, start, pause, pos, transition, padClick, applyGains, setKeyMatch: (v: boolean) => (keyMatch = v) };
}
