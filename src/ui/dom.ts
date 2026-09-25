import { zipFiles } from './zip';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper. `on*` attributes become event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ICONS: Record<string, string> = {
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  loop: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  metronome: '<path d="M9 3h6l4 18H5z"/><path d="M12 15l5-8"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  maximize: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  minimize: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>',
  wave: '<path d="M2 12h2l2-6 3 12 3-15 3 18 3-12 2 3h2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  drum: '<ellipse cx="12" cy="8" rx="8" ry="3"/><path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  piano: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M13 4v16M18 4v10"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  follow: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 4v16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  duplicate: '<rect x="3" y="7" width="10" height="10" rx="2"/><rect x="11" y="7" width="10" height="10" rx="2"/>',
  broom: '<path d="M19 3l-7 7"/><path d="M12 10c-3 0-6 2-7 5l-2 6 6-2c3-1 5-4 5-7z"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};

export function icon(name: string, size = 18): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

interface HostDownloads {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}
interface HostRuntime {
  use(name: string): Promise<unknown>;
}

/** File types the embedded viewer (claude.ai artifact host) accepts for saves. */
const HOST_EXTENSIONS = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md', 'csv', 'svg', 'pdf', 'zip', 'html']);

/**
 * Save a generated file. In a normal browser tab this is a plain download; when the app runs
 * inside a host that exposes a `downloads` runtime (e.g. a claude.ai artifact), the save goes
 * through it, zipping file types the host does not accept. Resolves false if the viewer declines.
 */
export async function downloadBlob(blob: Blob, name: string): Promise<boolean> {
  const host = (window as unknown as { claude?: HostRuntime }).claude;
  if (host && typeof host.use === 'function') {
    let dl: HostDownloads | null = null;
    try {
      dl = (await host.use('downloads')) as HostDownloads | null;
    } catch {
      dl = null;
    }
    if (dl) {
      let file = blob;
      let filename = name;
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      if (!HOST_EXTENSIONS.has(ext)) {
        file = await zipFiles([{ name, data: blob }]);
        filename = `${name}.zip`;
      }
      try {
        await dl.save({ filename, data: file });
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== 'declined') toast(`Couldn't save ${filename}${code ? ` (${code})` : ''}`, 'error', 4000);
        return false;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
  return true;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: accept || undefined, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Pick several files, or (directory) every file in a folder and its subfolders. */
export function pickFiles(accept: string, directory = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: accept || undefined, multiple: true, style: { display: 'none' } }) as HTMLInputElement;
    if (directory) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function safeName(s: string): string {
  return (s || 'beat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'beat';
}

// ---------------------------------------------------------------------------------------------
// Toasts

let toastHost: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 2600): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  toastHost.append(el);
  while (toastHost.children.length > 3) toastHost.firstElementChild?.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------------------------------------
// Popup menus

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  action: () => void;
  danger?: boolean;
}

let openMenu: HTMLElement | null = null;
export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/** A floating panel with arbitrary content under `anchor`; closes on an outside click or Escape. */
export function showPopover(anchor: HTMLElement, content: HTMLElement): void {
  closeMenu();
  float(anchor, h('div', { class: 'menu popover', role: 'dialog' }, content));
}

export function showMenu(anchor: HTMLElement, items: (MenuItem | '-')[]): void {
  closeMenu();
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) =>
      it === '-'
        ? h('div', { class: 'menu-sep' })
        : h(
            'button',
            {
              class: 'menu-item' + (it.danger ? ' danger' : ''),
              role: 'menuitem',
              onclick: () => {
                closeMenu();
                it.action();
              },
            },
            it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-ico' }),
            h('span', { class: 'menu-label' }, it.label),
            it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
          ),
    ),
  );
  float(anchor, menu);
}

function float(anchor: HTMLElement, menu: HTMLElement): void {
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = r.left;
  let y = r.bottom + 6;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${y}px`;
  openMenu = menu;
  setTimeout(() => {
    const off = (e: Event) => {
      if (openMenu !== menu || (e instanceof KeyboardEvent ? e.key === 'Escape' : !menu.contains(e.target as Node))) {
        if (openMenu === menu) closeMenu();
        document.removeEventListener('pointerdown', off, true);
        document.removeEventListener('keydown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', off, true);
  });
}

// ---------------------------------------------------------------------------------------------
// Modal

const modalStack: HTMLElement[] = [];

export function modal(title: string, body: HTMLElement, opts: { onClose?: () => void; wide?: boolean; closable?: boolean } = {}): { el: HTMLElement; close: () => void } {
  const closable = opts.closable ?? true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    modalStack.splice(modalStack.indexOf(back), 1);
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  // Escape closes the top-most closable dialog.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && closable && modalStack[modalStack.length - 1] === back) {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const back = h(
    'div',
    {
      class: 'modal-back',
      onpointerdown: (e: PointerEvent) => {
        if (closable && e.target === back) close();
      },
    },
    h(
      'div',
      { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), closable ? h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close')) : null),
      body,
    ),
  );
  document.body.append(back);
  modalStack.push(back);
  return { el: back, close };
}
