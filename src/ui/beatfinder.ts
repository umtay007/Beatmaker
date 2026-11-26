/**
 * Beat finder (desktop): beats whose licence is on record, tried against your vocal.
 *
 * Source: ccMixter, whose listings carry a Creative Commons licence URL per track. What a licence allows is read
 * from that URL, never guessed from a "free" label: an unrecognised licence is "unknown" and is not offered for
 * commercial use. Whether a beat is registered with YouTube's Content ID cannot be looked up, so it always says
 * unknown. The licence record is saved next to every beat you keep.
 */
import { detectTempo } from '../audio/tempo';
import { desktop } from './desktop';
import { downloadBlob, h, modal, pickFile, toast } from './dom';

export interface Terms {
  name: string;
  /** May it be used in something you earn from? */
  commercial: 'yes' | 'no' | 'unknown';
  /** May you change it (putting a vocal on it is a change)? */
  changes: 'yes' | 'no' | 'unknown';
  attribution: boolean;
  shareAlike: boolean;
}
export interface Beat {
  id: string;
  title: string;
  producer: string;
  page: string;
  download: string;
  bpm: number | null;
  tags: string;
  licenseUrl: string;
  licenseName: string;
  retrieved: string;
}

/** What a Creative Commons licence URL allows. Anything else is unknown. */
export function licenseTerms(url: string): Terms {
  const u = url.toLowerCase();
  if (/creativecommons\.org\/publicdomain\/(zero|mark)/.test(u)) return { name: 'Public domain (CC0)', commercial: 'yes', changes: 'yes', attribution: false, shareAlike: false };
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/.exec(u);
  const parts = m ? m[1].split('-') : [];
  if (!m || parts[0] !== 'by' || parts.some((p) => !['by', 'nc', 'nd', 'sa'].includes(p))) return { name: 'Unrecognised licence', commercial: 'unknown', changes: 'unknown', attribution: true, shareAlike: false };
  return { name: `CC ${m[1].toUpperCase()} ${m[2]}`, commercial: parts.includes('nc') ? 'no' : 'yes', changes: parts.includes('nd') ? 'no' : 'yes', attribution: true, shareAlike: parts.includes('sa') };
}
/** Does this licence fit the use? Unknown never passes. */
export const fitsUse = (t: Terms, use: 'commercial' | 'personal'): boolean => t.changes === 'yes' && (use === 'personal' ? t.commercial !== 'unknown' : t.commercial === 'yes');

export const licenceRecord = (b: Beat): string => {
  const t = licenseTerms(b.licenseUrl);
  return [
    `Beat: ${b.title}`, `Producer: ${b.producer}`, `Source page: ${b.page}`, `Downloaded from: ${b.download}`,
    `Licence: ${b.licenseName} (${b.licenseUrl})`, `Licence read from the source's listing on: ${b.retrieved}`,
    `Commercial use: ${t.commercial}`, `Changes (adding vocals, editing): ${t.changes}`, `Attribution required: ${t.attribution ? 'yes' : 'no'}`,
    `Share-alike (your song must carry the same licence): ${t.shareAlike ? 'yes' : 'no'}`,
    'YouTube Content ID registration: unknown (cannot be looked up; a claim is possible even on a licensed beat)',
    'Separate stems: not provided by this source',
    t.attribution ? `Credit line: "${b.title}" by ${b.producer} (${b.page}), licensed under ${t.name} (${b.licenseUrl})` : '',
    'This is a record of what the source stated, not legal advice. Re-check the source page before a release.',
  ].filter(Boolean).join('\n');
};

export function showBeatFinder(): void {
  const app = desktop();
  if (!app?.beatSearch) return void toast('The beat finder needs the desktop app.', 'info');
  let vocal: { buf: AudioBuffer; bpm: number; name: string } | null = null;
  let use: 'commercial' | 'personal' = 'commercial';
  const ctx = new AudioContext();
  let playing: AudioBufferSourceNode[] = [];
  const stop = () => (playing.forEach((s) => { try { s.stop(); } catch { /* ended */ } }), (playing = []));

  const tags = h('input', { class: 'sp-input', value: 'hip_hop', title: 'Style tags, separated by spaces (ccMixter tags, e.g. hip_hop, trap, chill, electronic)' }) as HTMLInputElement;
  const lo = h('input', { class: 'dk-bpm', type: 'number', value: '80' }) as HTMLInputElement;
  const hi = h('input', { class: 'dk-bpm', type: 'number', value: '160' }) as HTMLInputElement;
  const useSel = h('select', { class: 've-select', onchange: () => (use = useSel.value as typeof use) }, h('option', { value: 'commercial' }, 'I may release or monetise it'), h('option', { value: 'personal' }, 'Personal, no money involved')) as HTMLSelectElement;
  const vocalBtn = h('button', { class: 'btn btn-ghost', onclick: async () => {
    const f = await pickFile('audio/*,.wav,.mp3,.flac,.m4a');
    if (!f) return;
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const bpm = Math.round(detectTempo(buf).bpm);
    vocal = { buf, bpm, name: f.name };
    // tempo from a bare vocal is a rough guess: search a band around it, and around half and double
    lo.value = String(Math.round(bpm * 0.92));
    hi.value = String(Math.round(bpm * 1.08));
    vocalBtn.textContent = `Vocal: ${f.name} (about ${bpm} BPM, a rough guess from a bare vocal)`;
  } }, 'Choose your vocal (optional)…');
  const status = h('div', { class: 've-status' });
  const list = h('div', { class: 'sp-list' });
  const offset = h('input', { type: 'range', min: '-2', max: '2', step: '0.01', value: '0', title: 'Slide the vocal earlier or later against the beat (seconds)' }) as HTMLInputElement;
  const offLabel = h('span', { class: 'dk-lbl' }, 'Vocal offset 0.00 s');
  offset.oninput = () => (offLabel.textContent = `Vocal offset ${Number(offset.value).toFixed(2)} s`);

  const audition = async (b: Beat, row: HTMLElement) => {
    stop();
    status.textContent = `Fetching ${b.title}…`;
    const r = await app.beatFetch(b, licenceRecord(b));
    if (r.error || !r.audio) return void (status.textContent = `Couldn't fetch it: ${r.error}`);
    const beat = await ctx.decodeAudioData(r.audio.buffer.slice(r.audio.byteOffset, r.audio.byteOffset + r.audio.byteLength) as ArrayBuffer);
    await ctx.resume();
    const at = ctx.currentTime + 0.1;
    const play = (buf: AudioBuffer, gain: number, when: number, rate = 1) => {
      const s = ctx.createBufferSource();
      const g = new GainNode(ctx, { gain });
      s.buffer = buf;
      s.playbackRate.value = rate;
      s.connect(g).connect(ctx.destination);
      s.start(Math.max(ctx.currentTime, when));
      playing.push(s);
    };
    // the beat is played at the vocal's tempo when both are known (by speed, so its pitch moves a little)
    const rate = vocal && b.bpm ? Math.max(0.85, Math.min(1.18, vocal.bpm / b.bpm)) : 1;
    play(beat, 0.7, at, rate);
    if (vocal) play(vocal.buf, 1, at + Number(offset.value));
    status.textContent = `Playing ${b.title}${vocal ? ` with your vocal${rate !== 1 ? ` (beat at ${Math.round(rate * 100)}% speed to meet ${vocal.bpm} BPM)` : ''}` : ''}. Its licence record is saved in ${r.folder}.`;
    row.classList.add('dk-on');
    window.setTimeout(() => row.classList.remove('dk-on'), 600);
  };
  const search = async () => {
    stop();
    list.replaceChildren();
    status.textContent = 'Searching ccMixter…';
    const r = await app.beatSearch(tags.value.trim().split(/[\s,]+/).filter(Boolean));
    if (r.error || !r.beats) return void (status.textContent = `Search failed: ${r.error}`);
    const [a, z] = [Number(lo.value) || 0, Number(hi.value) || 999];
    const inTempo = (bpm: number | null) => bpm !== null && [1, 0.5, 2].some((k) => bpm * k >= a && bpm * k <= z);
    const fit = r.beats.filter((b) => fitsUse(licenseTerms(b.licenseUrl), use));
    const shown = fit.filter((b) => inTempo(b.bpm));
    status.textContent = `${r.beats.length} instrumentals found; ${fit.length} have a licence that fits "${use === 'commercial' ? 'release or monetise' : 'personal'}"; ${shown.length} of those are in the tempo range (half and double time count). ${r.beats.length - fit.length} hidden: non-commercial, no-changes or unrecognised licences.`;
    for (const b of shown) {
      const t = licenseTerms(b.licenseUrl);
      const row = h('div', { class: 'sp-item' },
        h('span', { onclick: () => void audition(b, row), title: 'Click to hear it (with your vocal, if chosen)' }, `${b.title} · ${b.producer} · ${b.bpm} BPM`),
        h('small', null, `${t.name}${t.attribution ? ' · credit required' : ''}${t.shareAlike ? ' · share-alike' : ''} · Content ID unknown `,
          h('a', { href: '#', onclick: async (e: Event) => {
            e.preventDefault();
            const got = await app.beatFetch(b, licenceRecord(b));
            if (got.error || !got.audio) return void toast(`Couldn't fetch it: ${got.error}`, 'error');
            await downloadBlob(new Blob([got.audio.buffer.slice(got.audio.byteOffset, got.audio.byteOffset + got.audio.byteLength) as ArrayBuffer]), `${b.title} - ${b.producer}.mp3`);
            await downloadBlob(new Blob([licenceRecord(b)], { type: 'text/plain' }), `${b.title} - ${b.producer} LICENCE.txt`);
          } }, 'keep')));
      list.append(row);
    }
  };
  modal('Find a beat', h('div', { class: 'sp' },
    h('p', { class: 'sp-note' }, '"Free download" does not mean free to release. Only beats whose licence allows your use are listed, each with its licence on record. Content ID claims cannot be ruled out for any beat. Nothing is bought.'),
    h('div', { class: 'sp-row' }, vocalBtn),
    h('div', { class: 'sp-row' }, h('span', { class: 'dk-lbl' }, 'Style'), tags, h('span', { class: 'dk-lbl' }, 'BPM'), lo, h('span', { class: 'dk-lbl' }, 'to'), hi, useSel, h('button', { class: 'btn btn-primary', onclick: () => void search() }, 'Search')),
    h('div', { class: 'sp-row' }, offLabel, offset, h('button', { class: 'btn btn-ghost', onclick: stop }, 'Stop')),
    status, list), { wide: true, onClose: () => (stop(), void ctx.close()) });
}
