/**
 * The lyrics dialog: paste or load the words (LRC, SRT/VTT or plain lines), time them by tapping
 * along with the song, or have them written out and timed from the vocals. What it saves shows in
 * the visualizer and the exported video.
 */
import type { AudioEngine } from '../audio/engine';
import { alignLyrics, transcribeLyrics, whisperCached } from '../audio/lyricsasr';
import { barTimes, parseLyrics, toLrc, toSongLines, type TimedText } from '../core/lyrics';
import type { Store } from '../core/store';
import { downloadBlob, h, icon, modal, pickFile, safeName, toast } from './dom';

const fmt = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
};

/** Timed text back to what the text box shows (LRC for timed lines, plain for the rest). */
function toText(lines: TimedText[]): string {
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push((l.time !== null ? fmt(l.time) : '') + l.text);
    const next = lines[i + 1];
    if (l.end !== undefined && (!next || next.time === null || l.end < next.time - 0.01)) out.push(fmt(l.end));
  });
  return out.join('\n');
}

/** Lines as the tapper sees them: the words, with their times if set. */
function readBox(text: string): TimedText[] {
  const parsed = parseLyrics(text);
  // An LRC end marker (a stamp with no words) belongs to the line before.
  const out: TimedText[] = [];
  for (const l of parsed) {
    if (!l.text) {
      const prev = out[out.length - 1];
      if (prev && l.time !== null) prev.end = l.time;
    } else out.push({ ...l });
  }
  return out;
}

export function showLyrics(store: Store, engine: AudioEngine): void {
  const song = store.song;
  const box = h('textarea', {
    class: 'lyrics-box',
    rows: 14,
    spellcheck: false,
    placeholder: 'Paste or type the lyrics, one line each.\nTimed lines look like [01:02.50]Words of the line (LRC); a file can be .lrc, .srt, .vtt or .txt.',
  }) as HTMLTextAreaElement;
  box.value = song.lyrics?.length ? toLrc(song) : '';
  const status = h('p', { class: 'lyrics-status' });
  const refresh = () => {
    const lines = readBox(box.value);
    const timed = lines.filter((l) => l.time !== null).length;
    status.textContent = !lines.length
      ? 'No lyrics yet.'
      : timed === lines.length
        ? `${lines.length} line${lines.length === 1 ? '' : 's'}, all timed.`
        : `${lines.length} lines, ${timed ? `${timed} timed` : 'none timed yet'}: tap to time them${stems() ? ', or time them from the vocals' : ''}.`;
    saveBtn.disabled = !timed && !song.lyrics?.length;
  };
  box.addEventListener('input', refresh);
  const stems = () => engine.stems?.vocals ?? null;

  const load = h('button', {
    class: 'btn',
    onclick: async () => {
      const f = await pickFile('.lrc,.srt,.vtt,.txt,text/plain');
      if (!f) return;
      const text = await f.text();
      const lines = parseLyrics(text);
      box.value = lines.length && lines[0].time !== null ? toText(readBox(text)) : lines.map((l) => l.text).join('\n');
      refresh();
    },
  }, icon('upload', 15), 'Load a file…');
  const saveLrc = h('button', {
    class: 'btn',
    title: 'The lyrics as an .lrc file, timed to the original recording',
    onclick: () => {
      const lines = readBox(box.value).filter((l) => l.time !== null);
      if (!lines.length) return toast('Nothing timed to save yet', 'info');
      void downloadBlob(new Blob([toText(lines)], { type: 'text/plain' }), `${safeName(song.name || 'lyrics')}.lrc`);
    },
  }, icon('download', 15), 'Save .lrc');

  // ----------------------------------------------------------------------------------------
  // Tap to time

  const now = h('p', { class: 'lyrics-now' });
  const upNext = h('p', { class: 'lyrics-next' });
  const tapNote = h('p', { class: 'section-note' }, 'Space (or Tap) as each line starts · Enter when a line ends before the next starts · Backspace to go back a line · Esc to stop.');
  const tapBtn = h('button', { class: 'btn btn-primary' }, 'Tap') as HTMLButtonElement;
  const endBtn = h('button', { class: 'btn' }, 'Line ends') as HTMLButtonElement;
  const backBtn = h('button', { class: 'btn' }, 'Back') as HTMLButtonElement;
  const stopBtn = h('button', { class: 'btn' }, 'Stop') as HTMLButtonElement;
  const tapPanel = h('div', { class: 'lyrics-tap', hidden: true }, now, upNext, h('div', { class: 'btn-row' }, tapBtn, endBtn, backBtn, stopBtn), tapNote);
  let tap: { lines: TimedText[]; i: number } | null = null;
  /** Where the listener is, in seconds of the original (a tap lands a little after the line starts). */
  const heard = () => engine.position() - store.song.audioOffset - 0.06;
  /** Play from a time of the original. */
  const playAt = (sec: number) => Math.max(0, sec + store.song.audioOffset);
  const show = () => {
    if (!tap) return;
    const l = tap.lines[tap.i];
    now.textContent = l ? l.text : 'All lines timed.';
    upNext.textContent = tap.lines[tap.i + 1]?.text ?? '';
    box.value = toText(tap.lines);
    backBtn.disabled = tap.i === 0;
    tapBtn.disabled = !l;
    refresh();
  };
  const startTap = async () => {
    const lines = readBox(box.value);
    if (!lines.length) return toast('Paste or load the lyrics first', 'info');
    // Carry on from the first line without a time.
    let i = lines.findIndex((l) => l.time === null);
    if (i < 0) i = 0;
    tap = { lines, i };
    const prev = i > 0 ? lines[i - 1].time : null;
    tapPanel.hidden = false;
    tools.hidden = true;
    box.readOnly = true;
    (document.activeElement as HTMLElement | null)?.blur();
    show();
    await engine.play(prev !== null ? playAt(prev - 2) : 0);
  };
  const stopTap = () => {
    if (!tap) return;
    engine.pause();
    tap = null;
    tapPanel.hidden = true;
    tools.hidden = false;
    box.readOnly = false;
    refresh();
  };
  const doTap = () => {
    if (!tap || !tap.lines[tap.i]) return;
    const t = heard();
    // Still before the line before it (just after going back a line): not this line yet.
    const prev = tap.i > 0 ? tap.lines[tap.i - 1].time : null;
    if (prev !== null && t <= prev + 0.05) {
      toast('That was before the line before it: tap as this line starts', 'info', 1800);
      return;
    }
    tap.lines[tap.i].time = t;
    delete tap.lines[tap.i].end;
    // A later line timed before this one no longer fits: it needs timing again.
    for (let j = tap.i + 1; j < tap.lines.length; j++) if (tap.lines[j].time !== null && tap.lines[j].time! <= tap.lines[tap.i].time!) tap.lines[j].time = null;
    tap.i++;
    show();
  };
  const doEnd = () => {
    if (!tap || tap.i === 0) return;
    const prev = tap.lines[tap.i - 1];
    const t = heard();
    if (prev.time !== null && t > prev.time + 0.2) prev.end = t;
    show();
  };
  const doBack = () => {
    if (!tap || tap.i === 0) return;
    tap.i--;
    const l = tap.lines[tap.i];
    const at = l.time;
    l.time = null;
    delete l.end;
    show();
    // Hear it again from a little before.
    const before = tap.i > 0 ? tap.lines[tap.i - 1].time : null;
    engine.seek(before !== null ? playAt(before - 1) : at !== null ? playAt(at - 3) : 0);
  };
  tapBtn.addEventListener('click', doTap);
  endBtn.addEventListener('click', doEnd);
  backBtn.addEventListener('click', doBack);
  stopBtn.addEventListener('click', stopTap);
  const onKey = (e: KeyboardEvent) => {
    if (!tap) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'Backspace' || k === 'Escape') {
      e.preventDefault();
      // Escape stops tapping, not the dialog.
      e.stopImmediatePropagation();
      if (k === ' ') doTap();
      else if (k === 'Enter') doEnd();
      else if (k === 'Backspace') doBack();
      else stopTap();
    }
  };
  window.addEventListener('keydown', onKey, true);

  // ----------------------------------------------------------------------------------------
  // From the vocals (speech recognition in the browser)

  const asrStatus = h('p', { class: 'section-note' });
  let asrCtrl: AbortController | null = null;
  const runAsr = async (mode: 'write' | 'align') => {
    const vocals = stems();
    if (!vocals) return;
    if (asrCtrl) return asrCtrl.abort();
    asrCtrl = new AbortController();
    const btn = mode === 'write' ? writeBtn : alignBtn;
    const label = btn.textContent;
    btn.textContent = 'Stop';
    try {
      const words = await transcribeLyrics(vocals, { signal: asrCtrl.signal, bars: barTimes(store.song), onProgress: (msg) => (asrStatus.textContent = msg) });
      if (mode === 'write') {
        box.value = toText(words.lines);
        asrStatus.textContent = `Wrote out ${words.lines.length} lines from the vocals. Check the words: singing fools speech recognition, above all under effects.`;
      } else {
        const mine = readBox(box.value);
        const res = alignLyrics(mine.map((l) => l.text), words.words);
        box.value = toText(res.lines);
        asrStatus.textContent = `Timed ${res.timed} of ${mine.length} lines from the vocals${res.timed < mine.length ? '; tap to time the rest' : ''}.`;
      }
      refresh();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') asrStatus.textContent = `Couldn't read the vocals: ${(e as Error).message}`;
      else asrStatus.textContent = 'Stopped.';
    } finally {
      asrCtrl = null;
      btn.textContent = label;
    }
  };
  const writeBtn = h('button', { class: 'btn', title: 'Speech recognition on the separated vocals writes the lines and their times', onclick: () => runAsr('write') }, icon('sparkle', 15), 'Write out from the vocals') as HTMLButtonElement;
  const alignBtn = h('button', { class: 'btn', title: 'Keeps your words and takes the times from the vocals', onclick: () => runAsr('align') }, icon('sparkle', 15), 'Time my lines from the vocals') as HTMLButtonElement;
  const asrRow = h('div', { class: 'btn-row' }, writeBtn, alignBtn);
  const asr = h('div', { class: 'lyrics-asr' }, asrRow, asrStatus);
  if (!stems()) {
    asrRow.hidden = true;
    asrStatus.textContent = 'Separate the parts (Remake automatically, with “Separate the parts first”) and the lyrics can be written out and timed from the vocals here.';
  } else {
    void whisperCached().then((c) => {
      if (!asrStatus.textContent) asrStatus.textContent = c ? 'Speech recognition runs in this browser (its model is already downloaded).' : 'Speech recognition runs in this browser; its model downloads once the first time (about 150 MB).';
    });
  }

  const tapStart = h('button', { class: 'btn btn-primary', onclick: () => void startTap() }, 'Tap to time…');
  const clear = h('button', {
    class: 'btn btn-ghost',
    onclick: () => {
      box.value = box.value
        .split('\n')
        .map((l) => l.replace(/^(\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/, '').trim())
        .filter(Boolean)
        .join('\n');
      refresh();
    },
  }, 'Clear the times');
  const tools = h('div', { class: 'btn-row' }, tapStart, clear);

  const saveBtn = h('button', {
    class: 'btn btn-primary btn-block',
    onclick: () => {
      const all = readBox(box.value);
      const lines = toSongLines(store.song, all);
      const untimed = all.filter((l) => l.time === null).length;
      store.update((s) => {
        if (lines.length) s.lyrics = lines;
        else delete s.lyrics;
      });
      if (lines.length && !store.visual.lyrics) store.setVisual({ lyrics: true });
      toast(lines.length ? `Lyrics saved${untimed ? ` (${untimed} untimed line${untimed === 1 ? '' : 's'} left out)` : ''}` : 'Lyrics removed', 'ok');
      m.close();
    },
  }, 'Save') as HTMLButtonElement;

  const body = h(
    'div',
    { class: 'lyrics' },
    h('p', null, 'The lyrics show in the visualizer and the video, line by line as they are sung. Times are seconds of the original recording, so an .lrc made for the original lines up as it is.'),
    box,
    status,
    h('div', { class: 'btn-row' }, load, saveLrc),
    tools,
    tapPanel,
    asr,
    saveBtn,
  );
  const m = modal('Lyrics', body, {
    wide: true,
    onClose: () => {
      window.removeEventListener('keydown', onKey, true);
      asrCtrl?.abort();
      if (tap) engine.pause();
    },
  });
  refresh();
}
