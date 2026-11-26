/**
 * Two-deck stem mixer: two songs, each split into vocals, drums, bass and the rest, played in time with
 * each other. The four pads in the middle say which song each part comes from; a click hands that part
 * to the other song on the next beat. "Transition" hands all four over in stages (drums, bass, the rest,
 * vocals), two bars apart.
 *
 * Sync plays the incoming song at the lead song's tempo by changing its speed, which also moves its pitch
 * (no key lock yet): the amount is shown on the deck.
 */
import { detectAudioKey } from '../audio/key';
import { separateStems, type Stems } from '../audio/separate';
import { detectTempo, peakEnvelope } from '../audio/tempo';
import { downloadBlob, h, pickFile, toast } from './dom';

const STEMS = ['vocals', 'other', 'bass', 'drums'] as const;
type StemName = (typeof STEMS)[number];
const LABEL: Record<StemName, string> = { vocals: 'Vocals', other: 'Melody', bass: 'Bass', drums: 'Drums' };
/** The order a transition hands the parts over in. */
const HANDOFF: StemName[] = ['drums', 'bass', 'other', 'vocals'];
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
  sources: AudioBufferSourceNode[];
  playing: boolean;
  startCtx: number;
  startPos: number;
  rate: number;
  status: string;
  abort: AbortController | null;
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const FADE_IN = Float32Array.from({ length: 33 }, (_, i) => Math.sin((i / 32) * (Math.PI / 2)));
const FADE_OUT = Float32Array.from({ length: 33 }, (_, i) => Math.cos((i / 32) * (Math.PI / 2)));

export function showDecks(): void {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const tap = ctx.createMediaStreamDestination();
  master.connect(tap);

  const mkDeck = (side: 0 | 1): Deck => {
    const out = ctx.createGain();
    out.connect(master);
    const gains = {} as Record<StemName, GainNode>;
    for (const s of STEMS) {
      gains[s] = ctx.createGain();
      gains[s].connect(out);
    }
    return { side, name: '', buf: null, stems: null, bpm: 120, firstBeat: 0, key: '', peaks: null, gains, out, sources: [], playing: false, startCtx: 0, startPos: 0, rate: 1, status: '', abort: null };
  };
  const decks: [Deck, Deck] = [mkDeck(0), mkDeck(1)];
  /** Which deck each part is heard from. */
  const assign: Record<StemName, 0 | 1> = { vocals: 0, other: 0, bass: 0, drums: 0 };
  let sync = true;
  let rec: MediaRecorder | null = null;
  let busy = false; // a transition is under way

  const pos = (d: Deck) => (d.playing ? d.startPos + Math.max(0, ctx.currentTime - d.startCtx) * d.rate : d.startPos);
  const lead = (): Deck => decks[STEMS.filter((s) => assign[s] === 1).length > 2 ? 1 : 0];
  const beatLen = (d: Deck) => 60 / d.bpm;

  /** The speed that plays `d` at the tempo `ref` is heard at (folding half and double time). */
  const syncRate = (d: Deck, ref: Deck): number => {
    let target = ref.bpm * ref.rate;
    while (target / d.bpm > 1.42) target /= 2;
    while (target / d.bpm < 0.71) target *= 2;
    return target / d.bpm;
  };

  const stopSources = (d: Deck) => {
    for (const s of d.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    d.sources = [];
  };
  const start = (d: Deck, from: number, when = ctx.currentTime + 0.03) => {
    if (!d.buf) return;
    stopSources(d);
    const at = Math.max(0, Math.min(from, d.buf.duration - 0.05));
    const make = (buf: AudioBuffer, dest: AudioNode) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = d.rate;
      src.connect(dest);
      src.start(when, at);
      d.sources.push(src);
      return src;
    };
    // Until the parts are separated the whole song plays (it cannot be split between decks yet).
    if (d.stems) for (const s of STEMS) make(d.stems[s], d.gains[s]);
    else make(d.buf, d.out);
    d.sources[0].onended = () => {
      d.playing = false;
      d.startPos = 0;
      refresh();
    };
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
    const at = d.firstBeat + Math.ceil((p - d.firstBeat) / unit + 0.02) * unit;
    return { when: ctx.currentTime + (at - p) / d.rate, at };
  };
  /** Start the other deck in time with the playing one, on the playing one's next bar. Returns when. */
  const bringIn = (to: Deck, from: Deck): number => {
    if (to.playing) return nextBoundary(from, 1).when;
    const { when } = nextBoundary(from, 4);
    to.rate = sync && from.buf ? syncRate(to, from) : 1;
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
  const transition = () => {
    const from = lead();
    const to = decks[from.side === 0 ? 1 : 0];
    if (!to.stems || !from.stems) return void toast('Both songs need their parts separated first.', 'info');
    if (!from.playing) return void toast('Play a song first.', 'info');
    if (busy) return;
    void ctx.resume();
    busy = true;
    const t0 = bringIn(to, from);
    const barRt = (4 * beatLen(from)) / from.rate;
    const first = to.playing && t0 < ctx.currentTime + 0.3 ? nextBoundary(from, 4).when : t0;
    HANDOFF.forEach((stem, i) => {
      if (assign[stem] !== to.side) swap(stem, to.side, first + i * 2 * barRt, stem === 'drums' ? 0.1 : beatLen(from) / from.rate);
    });
    const done = first + 6 * barRt + barRt;
    window.setTimeout(() => {
      busy = false;
      pause(from);
      refresh();
    }, (done - ctx.currentTime) * 1000);
    refresh();
  };

  const load = async (d: Deck) => {
    const file = await pickFile('audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac');
    if (!file) return;
    d.abort?.abort();
    pause(d);
    d.status = 'Reading…';
    refresh();
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const tempo = detectTempo(buf);
      const k = detectAudioKey(buf);
      Object.assign(d, { buf, stems: null, name: file.name.replace(/\.[^.]+$/, ''), bpm: Math.round(tempo.bpm * 10) / 10, firstBeat: tempo.firstBeat, key: `${KEYS[k.key]} ${k.scale}`, peaks: peakEnvelope(buf, PEAK_RATE), startPos: 0, rate: 1 });
      const other = decks[d.side === 0 ? 1 : 0];
      if (!other.buf) for (const s of STEMS) assign[s] = d.side;
      applyGains();
      d.abort = new AbortController();
      d.status = 'Separating the parts…';
      refresh();
      const stems = await separateStems(buf, { signal: d.abort.signal, onProgress: (f, msg) => ((d.status = `${msg} ${Math.round(f * 100)}%`), refreshStatus()) });
      d.stems = stems;
      d.status = '';
      if (d.playing) start(d, pos(d)); // carry on from the same place, now as parts
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
  const syncBtn = h('button', { class: 'dk-chip', title: 'Play the incoming song at the playing song’s tempo (its pitch moves with it)', onclick: () => ((sync = !sync), refresh()) });
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
    h('div', { class: 'dk-top' }, recBtn, h('div', { class: 'dk-head' }, 'Two-deck mixer'), syncBtn, h('button', { class: 'dk-chip', onclick: close }, 'Close')),
    h('div', { class: 'dk-main' }, ui[0].el, h('div', { class: 'dk-pads' }, pads.vocals, h('div', { class: 'dk-padrow' }, pads.other, pads.bass), pads.drums, transBtn), ui[1].el),
    h('div', { class: 'dk-waves' }, canvases[0], canvases[1]),
    h('div', { class: 'dk-bar' }, playAll, clock));
  document.body.append(root);

  const refreshStatus = () => decks.forEach((d, i) => (ui[i].status.textContent = d.status));
  function refresh(): void {
    decks.forEach((d, i) => {
      const u = ui[i];
      u.title.textContent = d.name || 'No song';
      const cents = Math.round(1200 * Math.log2(d.rate));
      u.sub.textContent = d.buf ? `${d.key} · ${d.bpm} BPM${Math.abs(d.rate - 1) > 0.001 ? ` · playing ${Math.round(d.rate * 1000) / 10}% speed (pitch ${cents > 0 ? '+' : ''}${cents} cents)` : ''}${d === lead() && decks[1 - i].buf ? ' · lead' : ''}` : 'Click the disc to choose one';
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
    const l = lead();
    clock.textContent = l.buf ? `${l.name}   ${fmt(pos(l))} / ${fmt(l.buf.duration)}` : '';
    raf = requestAnimationFrame(draw);
  };
  applyGains();
  refresh();
  draw();
}
