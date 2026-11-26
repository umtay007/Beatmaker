/**
 * Spotify (desktop): connect your account, browse your playlists, and control playback on your own Spotify devices.
 *
 * What it is not, by Spotify's rules and not by choice: Spotify gives apps no audio file, and its developer policy
 * forbids mixing, analyzing or separating its streams. So nothing here feeds the mixer, the stem separation or the
 * video. To work on a song, load your own file of it: "Check a local file" says whether a file is the same song.
 */
import { desktop } from './desktop';
import { h, modal, pickFile, toast } from './dom';

interface SpTrack { name: string; uri: string; duration_ms: number; artists: { name: string }[] }
interface SpPlaylist { id: string; name: string }

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const words = (s: string) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Is this local file the same song? By length (within 3 s) and the title's words in the file name. A guess, shown as one. */
export function matchLocal(track: { name: string; duration_ms: number; artists: { name: string }[] }, fileName: string, seconds: number): { verdict: 'likely' | 'unsure' | 'no'; why: string } {
  const off = Math.abs(seconds - track.duration_ms / 1000);
  const name = words(fileName.replace(/\.[^.]+$/, ''));
  const title = words(track.name);
  const hit = title.filter((w) => name.includes(w)).length / Math.max(1, title.length);
  const artist = track.artists.some((a) => words(a.name).every((w) => name.includes(w)));
  const why = `length differs by ${off.toFixed(1)} s; ${Math.round(hit * 100)}% of the title's words are in the file name${artist ? '; the artist is too' : ''}`;
  if (off <= 3 && hit >= 0.6) return { verdict: 'likely', why };
  if (off <= 3 || (hit >= 0.6 && off <= 15)) return { verdict: 'unsure', why };
  return { verdict: 'no', why };
}

export async function showSpotify(): Promise<void> {
  const sp = desktop()?.spotify;
  if (!sp) return void toast('Spotify needs the desktop app.', 'info');
  const body = h('div', { class: 'sp' });
  modal('Spotify', body, { wide: true });
  const note = h('p', { class: 'sp-note' }, 'This controls Spotify’s own playback on your Spotify devices and reads your playlists. Spotify does not give apps the audio, and its rules forbid mixing, separating or exporting its streams, so the mixer, stems and video only work with files you load yourself. Playback needs Premium.');

  const render = async (): Promise<void> => {
    const st = await sp.status();
    body.replaceChildren(note);
    if (!st.clientId) {
      const input = h('input', { class: 'sp-input', placeholder: 'Client ID from developer.spotify.com/dashboard' }) as HTMLInputElement;
      body.append(
        h('p', { class: 'sp-note' }, `Create an app in your Spotify developer dashboard, add ${st.redirect} to its Redirect URIs, and paste its Client ID here. No client secret is needed or wanted.`),
        h('div', { class: 'sp-row' }, input, h('button', { class: 'btn btn-primary', onclick: async () => {
          const r = await sp.setClient(input.value.trim());
          if (r.error) toast(r.error, 'error');
          void render();
        } }, 'Save')),
      );
      return;
    }
    if (!st.loggedIn) {
      const btn = h('button', { class: 'btn btn-primary', onclick: async () => {
        btn.textContent = 'Waiting for you in the browser…';
        btn.toggleAttribute('disabled', true);
        const r = await sp.login();
        if (r.error) toast(`Spotify: ${r.error}`, 'error', 6000);
        void render();
      } }, 'Connect Spotify (opens your browser)');
      body.append(h('p', { class: 'sp-note' }, `You log in on Spotify's own page; Beatmaker never sees your password. The app's Redirect URIs must include ${st.redirect}.`), h('div', { class: 'sp-row' }, btn));
      return;
    }
    const me = await sp.api<{ display_name: string }>('GET', '/me');
    if (me.status === 401) {
      await sp.logout();
      return render();
    }
    const who = h('div', { class: 'sp-row' },
      h('strong', null, me.data?.display_name ? `Connected as ${me.data.display_name}` : `Connected${me.error ? ` (profile: ${me.error})` : ''}`),
      h('button', { class: 'btn btn-ghost', onclick: async () => (await sp.logout(), void render()) }, 'Log out'),
      h('button', { class: 'btn btn-ghost', onclick: async () => say(await sp.api('PUT', '/me/player/pause')) }, 'Pause'),
      h('button', { class: 'btn btn-ghost', onclick: async () => say(await sp.api('POST', '/me/player/next')) }, 'Next'));
    const say = (r: { error?: string }) => r.error && toast(`Spotify: ${r.error}${/device/i.test(r.error) ? '. Open Spotify on a device first' : ''}`, 'error', 5000);
    const lists = h('div', { class: 'sp-list' });
    const tracks = h('div', { class: 'sp-list' });
    body.append(who, h('div', { class: 'sp-cols' }, lists, tracks));
    const pl = await sp.api<{ items: SpPlaylist[] }>('GET', '/me/playlists?limit=50');
    if (pl.error) lists.append(h('div', { class: 'sp-item' }, `Couldn't read your playlists: ${pl.error}`));
    for (const p of pl.data?.items ?? []) {
      lists.append(h('div', { class: 'sp-item', onclick: async () => {
        tracks.replaceChildren(h('div', { class: 'sp-item' }, 'Loading…'));
        const r = await sp.api<{ items: { item?: SpTrack; track?: SpTrack }[] }>('GET', `/playlists/${p.id}/items?limit=100`);
        tracks.replaceChildren();
        if (r.error) return void tracks.append(h('div', { class: 'sp-item' }, `Couldn't read it: ${r.error}`));
        for (const it of r.data?.items ?? []) {
          const t = it.item ?? it.track;
          if (!t?.uri) continue;
          tracks.append(h('div', { class: 'sp-item', title: 'Click to play on your Spotify device' , onclick: async () => say(await sp.api('PUT', '/me/player/play', { uris: [t.uri] })) },
            h('span', null, `${t.name} · ${t.artists.map((a) => a.name).join(', ')}`),
            h('small', null, mmss(t.duration_ms), ' ', h('a', { href: '#', title: 'Check whether one of your own files is this song', onclick: async (e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              const f = await pickFile('audio/*,.mp3,.wav,.flac,.m4a');
              if (!f) return;
              const ctx = new AudioContext();
              const secs = (await ctx.decodeAudioData(await f.arrayBuffer())).duration;
              void ctx.close();
              const m = matchLocal(t, f.name, secs);
              toast(`${m.verdict === 'likely' ? 'Likely the same song' : m.verdict === 'unsure' ? 'Not sure it is the same song' : 'Probably a different song'}: ${m.why}.`, m.verdict === 'likely' ? 'ok' : 'info', 8000);
            } }, 'check a local file'))));
        }
        if (!tracks.children.length) tracks.append(h('div', { class: 'sp-item' }, 'No playable tracks in it.'));
      } }, p.name));
    }
  };
  await render();
}
