import './styles.css';
import { AudioEngine } from './audio/engine';
import { demoSong } from './beats/templates';
import { store } from './core/store';
import { PALETTES } from './visual/settings';
import { VisualPlayer } from './visual/player';
import { Actions } from './ui/actions';
import { h, icon, toast } from './ui/dom';
import { Editor } from './ui/editor';
import { EditorBar } from './ui/editorbar';
import { Inspector } from './ui/inspector';
import { installKeyboard } from './ui/keyboard';
import { TopBar } from './ui/topbar';
import { TracksPanel } from './ui/tracks';

// ---------------------------------------------------------------------------------------------
// State

if (!store.restoreSaved()) {
  store.song = demoSong(PALETTES[store.visual.palette]?.colors ?? PALETTES.neon.colors);
  store.visual.titleText = store.song.name;
}
if (!store.song.tracks.some((t) => t.id === store.ui.selectedTrackId)) store.ui.selectedTrackId = store.song.tracks[0]?.id ?? '';

const engine = new AudioEngine(store);

// ---------------------------------------------------------------------------------------------
// Layout

const app = document.getElementById('app')!;
const stage = h('section', { class: 'stage', 'aria-label': 'Video preview' });
const workspace = h('main', { class: 'workspace' }, stage);
const resizer = h('div', { class: 'resizer', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize editor', tabindex: 0 });
const player = new VisualPlayer(store, engine, stage);
const actions = new Actions(store, engine, player);
const editor = new Editor(store, engine);
const editorBar = new EditorBar(store, engine, editor, actions);
const tracks = new TracksPanel(store, engine);
const inspector = new Inspector(store, engine, actions);
const topbar = new TopBar(store, engine, actions);

workspace.append(inspector.el);
const bottom = h('section', { class: 'bottom' }, tracks.el, h('div', { class: 'editor' }, editorBar.el, editor.wrap));
app.append(topbar.el, workspace, resizer, bottom);

// Stage overlay: big play button + tools.
const bigPlay = h(
  'button',
  {
    class: 'big-play',
    'aria-label': 'Play',
    onclick: () => {
      void engine.unlock();
      engine.toggle();
    },
  },
  icon('play', 34),
);
const maxBtn = h('button', { class: 'icon-btn', title: 'Maximize preview (F)', 'aria-label': 'Maximize preview', onclick: () => toggleMax() }, icon('maximize', 17));
const fsBtn = h(
  'button',
  {
    class: 'icon-btn',
    title: 'Full screen',
    'aria-label': 'Full screen',
    onclick: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void player.frame.requestFullscreen?.();
    },
  },
  icon('film', 17),
);
const badge = h('div', { class: 'stage-badge' });
stage.append(h('div', { class: 'stage-tools' }, fsBtn, maxBtn), badge);
player.frame.append(bigPlay);

function toggleMax(): void {
  const on = !document.body.classList.contains('maximized');
  document.body.classList.toggle('maximized', on);
  maxBtn.replaceChildren(icon(on ? 'minimize' : 'maximize', 17));
  store.ui.maximized = on;
  requestAnimationFrame(() => player.fit());
}

const syncStage = () => {
  bigPlay.classList.toggle('hidden', engine.playing);
  const v = store.visual;
  badge.textContent = `${v.aspect} · ${player.post.webgl ? 'GPU' : '2D'} preview`;
};
store.on('visual', syncStage);
const prevOnState = engine.onState;
engine.onState = () => {
  prevOnState?.();
  syncStage();
};
syncStage();

// Resizable editor panel
{
  let startY = 0;
  let startH = 0;
  const saved = Number(localStorageGet('beatmaker.bottomH'));
  if (saved > 120) document.documentElement.style.setProperty('--bottom-h', `${saved}px`);
  resizer.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startH = bottom.getBoundingClientRect().height;
    resizer.setPointerCapture(e.pointerId);
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    const hgt = Math.max(160, Math.min(window.innerHeight - 220, startH - (e.clientY - startY)));
    document.documentElement.style.setProperty('--bottom-h', `${hgt}px`);
  });
  resizer.addEventListener('pointerup', (e) => {
    resizer.releasePointerCapture(e.pointerId);
    localStorageSet('beatmaker.bottomH', String(Math.round(bottom.getBoundingClientRect().height)));
  });
  resizer.addEventListener('keydown', (e) => {
    const cur = bottom.getBoundingClientRect().height;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation(); // don't also transpose the selected notes
      const hgt = Math.max(160, Math.min(window.innerHeight - 220, cur + (e.key === 'ArrowUp' ? 30 : -30)));
      document.documentElement.style.setProperty('--bottom-h', `${hgt}px`);
    }
  });
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

// Drag & drop files anywhere
{
  document.body.append(h('div', { class: 'drop-hint' }, 'Drop a MIDI, audio, image or project file'));
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (actions.exporting) {
      toast('Wait for the video export to finish before opening files', 'error');
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])];
    // MIDI first so a dropped MIDI + audio pair lines up.
    files.sort((a, b) => Number(/\.midi?$/i.test(b.name)) - Number(/\.midi?$/i.test(a.name)));
    void (async () => {
      for (const f of files) await actions.openFile(f);
    })();
  });
}

// Unlock audio on the first interaction (browsers require a user gesture).
const unlock = () => {
  void engine.unlock();
  window.removeEventListener('pointerdown', unlock, true);
  window.removeEventListener('keydown', unlock, true);
};
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);

installKeyboard(store, engine, editor, actions, toggleMax);

// Slider edits are undo gestures that start on pointerdown in each control. A click that doesn't
// move a slider fires no 'change', so always close the gesture when the pointer is released
// (bubble phase: after the editor's own pointerup work). Keyboard changes get a gesture per key.
const endGesture = () => store.endGesture();
window.addEventListener('pointerup', endGesture);
window.addEventListener('pointercancel', endGesture);
const onRange = (e: Event) => (e.target as Element | null)?.matches?.('input[type=range]') ?? false;
window.addEventListener('keydown', (e) => onRange(e) && store.beginGesture(), true);
window.addEventListener('keyup', (e) => onRange(e) && store.endGesture());
window.addEventListener('beforeunload', () => store.saveNow());

// ---------------------------------------------------------------------------------------------
// Frame loop

let frameErrors = 0;
function frame(): void {
  requestAnimationFrame(frame);
  try {
    player.render();
    editor.frame();
    topbar.frame();
  } catch (e) {
    if (frameErrors++ < 5) console.error(e);
  }
}
requestAnimationFrame(frame);

// Expose for debugging / automated tests.
(window as unknown as Record<string, unknown>).beatmaker = { store, engine, player, actions, editor };
