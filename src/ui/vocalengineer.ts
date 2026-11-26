/**
 * Vocal engineer (desktop): a raw vocal and the beat it goes over → analysis, a processing chain built from
 * what the analysis found, and a before/after at the same loudness. The work is done by vst/vocal_engineer.py;
 * this is its screen: pick the files and a direction, read what it found and did, listen to both, keep the result.
 */
import { encodeWav } from '../audio/render';
import type { Store } from '../core/store';
import { desktop } from './desktop';
import { askText, downloadBlob, h, modal, pickFile, toast } from './dom';
import { vocalTrack } from './vocaltrack';

const DIRECTIONS: [string, string][] = [
  ['clean', 'Clean: natural, light reverb'],
  ['melodic', 'Melodic: tuned, doubled, wetter'],
  ['aggressive', 'Aggressive: forward, compressed, gritty'],
  ['distorted', 'Distorted: heavy drive'],
  ['airy', 'Airy: bright, wide, long reverb'],
];

export function showVocalEngineer(store: Store, colors: string[]): void {
  const app = desktop();
  const files: { vocal: File | null; beat: File | null } = { vocal: null, beat: null };
  let direction = 'clean';
  let retune = false;
  let result: { processed: AudioBuffer; after: Blob; name: string } | null = null;
  const urls: string[] = [];

  const vocalBtn = h('button', { class: 'btn btn-ghost', onclick: async () => ((files.vocal = (await pickFile('audio/*,.wav,.mp3,.flac,.m4a')) ?? files.vocal), show()) });
  const beatBtn = h('button', { class: 'btn btn-ghost', onclick: async () => ((files.beat = (await pickFile('audio/*,.wav,.mp3,.flac,.m4a')) ?? files.beat), show()) });
  const dirSel = h('select', { class: 've-select', onchange: () => (direction = dirSel.value) }, ...DIRECTIONS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  // Presets: targets measured from a reference vocal (yours to supply). "None" uses the direction above.
  let preset = '';
  const presetSel = h('select', { class: 've-select', onchange: () => (preset = presetSel.value) }) as HTMLSelectElement;
  const loadPresets = async () => {
    const list = (await app?.vocalPresets?.()) ?? [];
    presetSel.replaceChildren(h('option', { value: '' }, 'No preset (use the direction)'), ...list.map((p) => h('option', { value: p.name, title: `${p.source} · made ${p.made}` }, p.name)));
    presetSel.value = preset;
  };
  const refBtn = h('button', { class: 'btn btn-ghost', title: 'Measure a finished vocal you have (an acapella or a separated vocals stem) and aim your take at it', onclick: async () => {
    if (!app?.vocalPresetMake) return;
    const f = await pickFile('audio/*,.wav,.mp3,.flac,.m4a');
    if (!f) return;
    const name = await askText('Name this preset (e.g. the artist and song)', f.name.replace(/\.[^.]+$/, ''));
    if (!name) return;
    status.textContent = 'Measuring the reference vocal…';
    const r = await app.vocalPresetMake({ reference: await wavOf(f), name, source: `measured from the file "${f.name}"` });
    status.textContent = r.error ? `Couldn't make the preset: ${r.error}` : `Preset "${r.preset!.name}" saved. It holds what that vocal measures as (tone, dynamics, tuning, width), not the settings used to make it.`;
    if (r.preset) preset = r.preset.name;
    await loadPresets();
  } }, 'Make a preset from a reference vocal…');
  const tune = h('input', { type: 'checkbox', onchange: () => (retune = tune.checked) }) as HTMLInputElement;
  const status = h('div', { class: 've-status' });
  const report = h('div', { class: 've-report' });
  const players = h('div', { class: 've-players' });
  const runBtn = h('button', { class: 'btn btn-primary', onclick: () => void run() }, 'Engineer it');
  const keep = h('div', { class: 've-keep' });

  // The script works at 44.1 kHz: decode there, and send plain WAVs.
  const wavOf = async (f: File): Promise<Uint8Array> => {
    const tmp = new AudioContext();
    const buf = await tmp.decodeAudioData(await f.arrayBuffer());
    void tmp.close();
    const off = new OfflineAudioContext(2, Math.ceil(buf.duration * 44100), 44100);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return new Uint8Array(await encodeWav(await off.startRendering()).arrayBuffer());
  };
  const run = async () => {
    if (!app?.vocalEngineer) return void toast('The vocal engineer needs the desktop app.', 'info');
    if (!files.vocal || !files.beat) return void toast('Choose the vocal and the beat first.', 'info');
    runBtn.toggleAttribute('disabled', true);
    status.textContent = 'Listening to the take and building the chain…';
    report.replaceChildren();
    players.replaceChildren();
    keep.replaceChildren();
    try {
      const r = await app.vocalEngineer({ vocal: await wavOf(files.vocal), beat: await wavOf(files.beat), direction, retune, preset: preset || undefined });
      if (r.error || !r.report) throw new Error(r.error ?? 'nothing came back');
      status.textContent = '';
      const a = r.report.analysis;
      report.append(
        h('h4', null, 'What it found'),
        h('p', null, `${a.duration_s} s · loudness ${a.lufs} LUFS · peak ${a.peak_dbfs} dBFS${a.clipped_samples ? ` · ${a.clipped_samples} clipped samples` : ''} · noise floor ${a.noise_floor_dbfs} dBFS (SNR ${a.snr_db} dB) · key ${a.key} · ${Math.round(a.sustained_pitch_share * 100)}% of the voiced time holds a pitch · sibilance peaks ${a.sibilance_peak_over_median_db} dB over its median`),
        h('h4', null, 'What it did, and why'),
        h('ol', null, ...r.report.chain.map((line) => h('li', null, line))),
        h('h4', null, 'Checks on the result'),
        h('p', null, `No bad samples: ${r.report.checks.finite ? 'yes' : 'NO'} · clipped samples: ${r.report.checks.clipped_after} · peak ${r.report.checks.peak_after_dbfs} dBFS · vocal still in time: ${r.report.checks.vocal_alignment_ok ? 'yes' : 'NO'} · before and after both at ${r.report.checks.matched_lufs} LUFS`),
      );
      const blob = (b: Uint8Array) => new Blob([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer], { type: 'audio/wav' });
      const player = (label: string, bytes: Uint8Array) => {
        const url = URL.createObjectURL(blob(bytes));
        urls.push(url);
        return h('label', null, label, h('audio', { controls: true, src: url }));
      };
      players.append(player('Before (raw vocal over the beat)', r.before!), player(`After (${preset || direction}), same loudness`, r.after!));
      const ctx = new AudioContext();
      const pb = r.processed!;
      const processed = await ctx.decodeAudioData(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer);
      void ctx.close();
      const name = files.vocal.name.replace(/\.[^.]+$/, '');
      result = { processed, after: blob(r.after!), name };
      keep.append(
        h('button', { class: 'btn btn-ghost', onclick: () => void downloadBlob(encodeWav(result!.processed), `${name} (${direction}).wav`) }, 'Save the processed vocal'),
        h('button', { class: 'btn btn-ghost', onclick: () => void downloadBlob(result!.after, `${name} (${direction}) mix.wav`) }, 'Save the mix'),
        h('button', { class: 'btn btn-ghost', onclick: async () => {
          const t = await vocalTrack(result!.processed, store.song, colors[store.song.tracks.length % colors.length], { name: `${name} (${direction})`, withOriginal: false });
          store.update((s) => s.tracks.push(t));
          toast('Added to the project as a track.', 'ok');
        } }, 'Add the processed vocal to the project'),
      );
    } catch (e) {
      status.textContent = `It didn't work: ${(e as Error).message}`;
    }
    runBtn.toggleAttribute('disabled', false);
  };
  function show(): void {
    vocalBtn.textContent = files.vocal ? `Vocal: ${files.vocal.name}` : 'Choose the raw vocal…';
    beatBtn.textContent = files.beat ? `Beat: ${files.beat.name}` : 'Choose the beat it goes over…';
  }
  show();
  void loadPresets();
  modal('Vocal engineer', h('div', { class: 've' },
    h('p', { class: 've-note' }, 'It measures the take first and only uses what the take needs. The before and after play at the same loudness, so what you hear is the processing, not the volume.'),
    h('div', { class: 've-row' }, vocalBtn, beatBtn),
    h('div', { class: 've-row' }, h('label', null, 'Direction ', dirSel), h('label', { title: 'Rapped or spoken takes are left untuned unless you tick this' }, tune, ' Tune even if it reads as rapped'), runBtn),
    h('div', { class: 've-row' }, h('label', null, 'Preset ', presetSel), refBtn),
    status, players, keep, report), { wide: true, onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)) });
}
