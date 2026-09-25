import type { AudioEngine } from '../audio/engine';
import { instrumentFor, type Voice } from '../audio/instruments';
import type { Store } from '../core/store';
import { DRUM_VOICES } from '../core/theory';
import { BAR, newNoteId, STEP } from '../core/types';
import type { Actions } from './actions';
import { toast } from './dom';
import type { Editor } from './editor';
import { showHelp } from './topbar';

const LOWER = ['z', 's', 'x', 'd', 'c', 'v', 'g', 'b', 'h', 'n', 'j', 'm', ',', 'l', '.'];
const UPPER = ['q', '2', 'w', '3', 'e', 'r', '5', 't', '6', 'y', '7', 'u', 'i', '9', 'o', '0', 'p'];

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Whether focus last moved by keyboard (Tab). After a mouse click a button keeps focus, but Space
 * should still play and pause rather than click it again.
 */
let focusByKeyboard = false;
window.addEventListener('pointerdown', () => (focusByKeyboard = false), true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') focusByKeyboard = true;
}, true);

/**
 * Space, Enter and the arrow keys belong to a control the user reached with Tab: buttons, menu
 * items, track rows, the panel resizer.
 */
function keyboardOnControl(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!focusByKeyboard || !t || !t.closest) return false;
  return !!t.closest('button, a[href], summary, [role=option], [role=separator], [role=menuitem], [role=button]');
}

export function installKeyboard(store: Store, engine: AudioEngine, editor: Editor, actions: Actions, toggleMax: () => void): void {
  const held = new Map<string, { voice: Voice | null; pitch: number; start: number | null; trackId: string }>();
  let octave = 0;

  const pitchFor = (key: string): number | null => {
    const t = store.track;
    if (!t) return null;
    if (t.kind === 'drums') return DRUM_VOICES.find((v) => v.key === key)?.pitch ?? null;
    const base = 12 * (instrumentFor(t.instrument).octave + 1 + octave);
    const lo = LOWER.indexOf(key);
    if (lo >= 0) return base + lo;
    const up = UPPER.indexOf(key);
    if (up >= 0) return base + 12 + up;
    return null;
  };

  const recTick = (): number | null => {
    if (!store.ui.record || !engine.playing) return null;
    const g = store.ui.grid;
    return Math.max(0, Math.round(engine.positionTicks() / g) * g);
  };

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    // A modal is open, or a video is recording: shortcuts would change the song or the transport
    // underneath it (and a paused export would never finish).
    if (actions.exporting || document.querySelector('.modal-back')) return;
    if ([' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && keyboardOnControl(e)) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Live note input
    if (store.ui.keys && !mod && !e.altKey) {
      if (key === 'escape') {
        store.setUI({ keys: false });
        return;
      }
      if (key === '[' || key === ']') {
        octave = Math.max(-3, Math.min(3, octave + (key === ']' ? 1 : -1)));
        toast(`Keyboard octave ${octave >= 0 ? '+' : ''}${octave}`);
        e.preventDefault();
        return;
      }
      const pitch = pitchFor(key);
      if (pitch !== null) {
        e.preventDefault();
        if (e.repeat || held.has(key)) return;
        const t = store.track!;
        held.set(key, { voice: engine.noteOn(t, pitch, 0.88), pitch, start: recTick(), trackId: t.id });
        return;
      }
    }

    if (mod) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (key === 'y') {
        e.preventDefault();
        store.redo();
      } else if (key === 'a') {
        e.preventDefault();
        editor.selectAll();
      } else if (key === 'c') {
        if (editor.copy()) toast('Copied notes');
      } else if (key === 'v') {
        e.preventDefault();
        editor.paste();
      } else if (key === 'd') {
        e.preventDefault();
        editor.duplicate();
      } else if (key === 's') {
        e.preventDefault();
        actions.saveProject();
      }
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        void engine.unlock();
        engine.toggle();
        return;
      case 'Enter':
        e.preventDefault();
        engine.stop();
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        editor.deleteSelection();
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        if (!editor.selection.size) return;
        e.preventDefault();
        editor.transpose((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!editor.selection.size) return;
        e.preventDefault();
        editor.nudge((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? BAR : store.ui.grid));
        return;
      case 'Escape':
        if (store.ui.maximized) toggleMax();
        editor.selection.clear();
        editor.invalidate();
        return;
      case '?':
        showHelp();
        return;
    }
    switch (key) {
      case 'l':
        store.update((s) => {
          s.loop.enabled = !s.loop.enabled;
          if (s.loop.end <= s.loop.start) s.loop = { enabled: true, start: 0, end: Math.min(4, s.bars) * BAR };
        });
        break;
      case 'm':
        store.setUI({ metronome: !store.ui.metronome });
        break;
      case 'f':
        toggleMax();
        break;
      case 'r':
        store.setUI({ record: !store.ui.record });
        if (store.ui.record && !store.ui.keys) store.setUI({ keys: true });
        toast(store.ui.record ? 'Record armed — press Space, then play keys' : 'Record off');
        break;
      case 'k':
        store.setUI({ keys: !store.ui.keys });
        toast(store.ui.keys ? 'Keyboard input on — Z…M / Q…U play notes, [ ] change octave, Esc exits' : 'Keyboard input off');
        break;
      case 'q':
        editor.quantize();
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    h.voice?.release(engine.ctx?.currentTime ?? 0);
    if (h.start === null) return;
    const track = store.song.tracks.find((t) => t.id === h.trackId);
    if (!track) return;
    const g = store.ui.grid;
    const endTick = Math.round(engine.positionTicks() / g) * g;
    let dur = endTick - h.start;
    if (track.kind === 'drums' || dur <= 0) dur = track.kind === 'drums' ? STEP : g;
    const start = h.start;
    store.update(() => {
      if (track.kind === 'drums' && track.notes.some((n) => n.pitch === h.pitch && Math.abs(n.start - start) < g / 2)) return;
      track.notes.push({ id: newNoteId(), pitch: h.pitch, start, dur: Math.max(g / 2, dur), vel: 0.85 });
      track.notes.sort((a, b) => a.start - b.start);
    });
  });

  window.addEventListener('blur', () => {
    for (const h of held.values()) h.voice?.release(engine.ctx?.currentTime ?? 0);
    held.clear();
  });
}
