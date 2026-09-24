import { h } from './dom';

export interface Bound {
  el: HTMLElement;
  refresh(): void;
}

let uid = 0;
const nextId = () => `f${++uid}`;

function field(label: string, id: string, control: HTMLElement, extra?: HTMLElement | null, help?: string): HTMLElement {
  return h(
    'div',
    { class: 'field', title: help ?? '' },
    h('label', { class: 'field-label', for: id }, label),
    h('div', { class: 'field-control' }, control, extra ?? null),
  );
}

export function rangeField(
  label: string,
  o: { min: number; max: number; step: number; get(): number; set(v: number): void; format?(v: number): string; help?: string; onStart?(): void; onEnd?(): void },
): Bound {
  const id = nextId();
  const out = h('output', { class: 'field-value', for: id });
  const input = h('input', { id, type: 'range', min: o.min, max: o.max, step: o.step, class: 'range' }) as HTMLInputElement;
  const fmt = o.format ?? ((v: number) => (o.step >= 1 ? String(Math.round(v)) : v.toFixed(o.step >= 0.1 ? 1 : 2)));
  const paint = () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    const pct = ((v - o.min) / (o.max - o.min)) * 100;
    input.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  };
  input.addEventListener('pointerdown', () => o.onStart?.());
  input.addEventListener('change', () => o.onEnd?.());
  input.addEventListener('input', () => {
    o.set(Number(input.value));
    paint();
  });
  const refresh = () => {
    if (document.activeElement !== input) input.value = String(o.get());
    paint();
  };
  refresh();
  return { el: field(label, id, input, out, o.help), refresh };
}

export function selectField(
  label: string,
  o: { options: [string, string][] | (() => [string, string][]); groups?: boolean; get(): string; set(v: string): void; help?: string },
): Bound {
  const id = nextId();
  const sel = h('select', { id, class: 'select' }) as HTMLSelectElement;
  let lastKey = '';
  const fill = () => {
    const opts = typeof o.options === 'function' ? o.options() : o.options;
    const key = JSON.stringify(opts);
    if (key === lastKey) return;
    lastKey = key;
    sel.innerHTML = '';
    let group: HTMLOptGroupElement | null = null;
    for (const [value, text] of opts) {
      if (value.startsWith('group:')) {
        group = h('optgroup', { label: text });
        sel.append(group);
        continue;
      }
      (group ?? sel).append(h('option', { value }, text));
    }
  };
  sel.addEventListener('change', () => o.set(sel.value));
  const refresh = () => {
    fill();
    sel.value = o.get();
  };
  refresh();
  return { el: field(label, id, sel, null, o.help), refresh };
}

export function toggleField(label: string, o: { get(): boolean; set(v: boolean): void; help?: string }): Bound {
  const id = nextId();
  const input = h('input', { id, type: 'checkbox', class: 'switch-input' }) as HTMLInputElement;
  input.addEventListener('change', () => o.set(input.checked));
  const sw = h('label', { class: 'switch', for: id }, input, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })));
  const refresh = () => {
    input.checked = o.get();
  };
  refresh();
  const el = h('div', { class: 'field field-toggle', title: o.help ?? '' }, h('label', { class: 'field-label', for: id }, label), sw);
  return { el, refresh };
}

export function colorField(label: string, o: { get(): string; set(v: string): void; help?: string }): Bound {
  const id = nextId();
  const input = h('input', { id, type: 'color', class: 'color' }) as HTMLInputElement;
  const hex = h('input', { type: 'text', class: 'hex', maxlength: 7, 'aria-label': `${label} hex` }) as HTMLInputElement;
  input.addEventListener('input', () => {
    o.set(input.value);
    hex.value = input.value;
  });
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      const c = v.startsWith('#') ? v : `#${v}`;
      o.set(c);
      input.value = c;
    } else hex.value = o.get();
  });
  const refresh = () => {
    input.value = o.get();
    if (document.activeElement !== hex) hex.value = o.get();
  };
  refresh();
  return { el: field(label, id, h('div', { class: 'color-wrap' }, input, hex), null, o.help), refresh };
}

export function textField(label: string, o: { get(): string; set(v: string): void; placeholder?: string; help?: string; maxlength?: number }): Bound {
  const id = nextId();
  const input = h('input', { id, type: 'text', class: 'text', placeholder: o.placeholder ?? '', maxlength: o.maxlength ?? 80 }) as HTMLInputElement;
  input.addEventListener('input', () => o.set(input.value));
  const refresh = () => {
    if (document.activeElement !== input) input.value = o.get();
  };
  refresh();
  return { el: field(label, id, input, null, o.help), refresh };
}

export function numberField(label: string, o: { min: number; max: number; step: number; get(): number; set(v: number): void; help?: string }): Bound {
  const id = nextId();
  const input = h('input', { id, type: 'number', class: 'text num', min: o.min, max: o.max, step: o.step }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) o.set(Math.max(o.min, Math.min(o.max, v)));
    input.value = String(o.get());
  });
  const refresh = () => {
    if (document.activeElement !== input) input.value = String(o.get());
  };
  refresh();
  return { el: field(label, id, input, null, o.help), refresh };
}

export function segField(label: string, o: { options: [string, string][]; get(): string; set(v: string): void; help?: string }): Bound {
  const btns = o.options.map(([value, text]) =>
    h('button', { class: 'seg-btn', type: 'button', 'data-v': value, onclick: () => o.set(value) }, text),
  );
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns);
  const refresh = () => {
    const cur = o.get();
    for (const b of btns) b.classList.toggle('on', b.dataset.v === cur);
  };
  refresh();
  return { el: h('div', { class: 'field field-seg', title: o.help ?? '' }, h('span', { class: 'field-label' }, label), seg), refresh };
}
