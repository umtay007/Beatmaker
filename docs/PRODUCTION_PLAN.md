# Beatmaker production suite: plan, inventory and checklist

Status legend: `done` (built and verified), `partial`, `todo`, `blocked` (exact blocker named), `unverified`.
Nothing here is marked `done` without a test that produced the evidence listed beside it.

## 0. What already exists (reused, not rebuilt)

| Area | Existing implementation | Notes |
|---|---|---|
| Stem separation | Demucs v4 (ONNX, WebGPU) in `src/audio/separate.ts`; optional BS-Roformer voice removal (`desktop/vst/devocal.py`, `--sep`) | drums/bass stems good; `other` is a mix, not chords |
| Voice-bleed cleaning | `desktop/vst/declean.py` (loop-shared content + vocal-guided mask) | verified by listening on Walk |
| Transcription | Basic Pitch (TF.js), YourMT3+ (Python), drum grid | `src/audio/transcribe.ts`, `desktop/vst/ymt3.py` |
| Tempo / key / sections | `src/audio/tempo.ts`, `key.ts`, `structure.ts` | single-song, no downbeat-correction UI |
| Mixing / mastering / EQ / FX | Web Audio graph `src/audio/graph.ts`, master EQ match, reverb, echo | |
| VST hosting | `desktop/vst/host.py` (Python `pedalboard`, headless): pick sound, bake to samples, render | instruments only, no live effect chains, no state restore of effects |
| Export | WAV/MP3/MIDI/MP4 (`src/visual/exporter.ts`, `src/ui/actions.ts`) | |
| Desktop shell | Electron (`desktop/main.cjs`), IPC, job queue, CLI flags | Windows portable exe via electron-builder |

Environments (reuse, do not duplicate): `E:\beatmaker\tools\sep` (CUDA torch 2.6, audio-separator, PANNs), `E:\beatmaker\tools\yourmt3` (YourMT3+, CLAP), `E:\beatmaker\tools\node` (portable Node 24.19). GPU: RTX 4070 SUPER 12 GB (about 5.6 GB used by other apps). Disk: C 23 GB free (do not install here), E 365 GB free, F 1145 GB free.

## 1. Plugin inventory (`E:\beatmaker\VSTS`)

The folder holds installed product folders, not a standard plugin directory. None of `C:\Program Files\Common Files\VST3`, `C:\Program Files\VSTPlugins`, `Steinberg\VSTPlugins` exist. A folder name or a `.vst3` file existing does not prove a licence or that the plugin loads; every entry below is `unverified` until the isolated scanner (slice 5) loads it.

VST3 binaries found (28): Analog Lab V (Arturia), Bazille, CHEat code, Hive, Icarus, Kontakt 8, Korg Wavestation, Luma, MuseForge Agent, Nexus, Omnisphere and FX-Omnisphere, Pigments, Portal, Rift, Rolling Sampler, Serato Sample, Serum 2, ShaperBox 3, Spire, Synplant, SynthMaster 3, Gladiator, ValhallaVintageVerb, Zenology.
VST2 DLLs found: HalfTime, Icarus, Wavestation, Nexus, Omnisphere and FX-Omnisphere, Portal, ShaperBox 3, ValhallaVintageVerb.
Probably effects (to confirm by scan): ValhallaVintageVerb, ShaperBox 3, HalfTime, Portal, Rift, FX-Omnisphere. Instruments: the rest.
Not plugins: Arturia `resources\*Processor.dll` (engine DLLs of Analog Lab), `unins000.exe`, installers, sample libraries (Kontakt, Omnisphere STEAM, Serum banks, Arturia presets).

## 2. Evidence gathered so far (see `docs/research/source-log.md`)

* **STEM.FM** has a web player and an iOS app; the pages read mention no Windows app, no API, no SDK, no export format, no device protocol. Terms: personal use only; extraction, scraping and bulk analysis of the service prohibited.
* **Stem2** per STEM's own FAQ: "Wireless speaker. 40 hours battery. Local storage. Syncs with StemFM. Touch stem controls. Works with StemFM or standalone." Connectivity (USB / Bluetooth / Wi-Fi), how audio reaches the device, pairing, firmware, formats: **not stated** on any official page. Original Stem Player: USB-C loading and on-device separation (only in an LLM-discovery document, itself self-described as non-authoritative).
* **Spotify**: PKCE OAuth is supported for desktop apps. Development-mode apps: 5 allowlisted users, owner needs Premium. Extended quota: organizations only, 250k+ MAU. Web Playback SDK needs Premium, "must not be used in commercial projects without Spotify's prior written approval". Developer Policy forbids mixing/segueing Spotify content with other audio (III.7), analyzing it (III.13), ML/AI ingestion (III.14), syncing it with visual media (III.6). So Spotify audio can never feed the mixer, separator, mashup renderer or video exporter.

## 3. Decisions made

1. **Architecture**: keep the Electron + Vite/TypeScript app as the single UI and project store. Native work runs in isolated Python sidecars launched by `desktop/main.cjs` (pattern already used for YourMT3+, voice removal, cleaning): one for plugin hosting (pedalboard), one for separation (the `sep` env). No browser-only plugin hosting.
2. **Plugin hosting**: pedalboard (JUCE-based) hosts VST3 headlessly with state save/restore (`raw_state`), isolated scan in a child process with timeout, offline render. Native editors through `show_editor` where it works. This is the smallest suitable host; a custom JUCE host is only warranted if pedalboard cannot satisfy latency compensation or editor requirements (to be measured).
3. **Spotify**: PKCE login, library and playlist browsing, and playback by controlling a Spotify Connect device through the Web API player endpoints. The in-app Web Playback SDK needs Widevine DRM, which stock Electron does not ship, so it is not assumed to work (to be tested). Spotify audio is never captured or routed. Matching a library entry to a local file is done by metadata (title, artist, duration, ISRC where available) and by fingerprinting the local file, not by touching Spotify audio.
4. **Stem2**: without a published protocol, only evidence-based capabilities are implemented: (a) audio out through the Windows audio endpoint if it appears as one, (b) stems and mixes exported as WAV/MP3 for StemFM's own import or the device's documented workflow, (c) passive, read-only discovery of the device (USB descriptors, Bluetooth services) to document what it exposes. No firmware writes, no resets, no overwriting device content without explicit approval.
5. **Licences**: every beat candidate carries a stored licence record; unknown stays `unknown`.

## 4. Feature checklist

### 4.1 Two-deck mixing (STEM.FM-style)
- [ ] Parity matrix against STEM.FM features (todo; the product's public pages describe few concrete player features, so most rows will be `unverified`)
- [ ] Two decks, waveform, editable beat grid, downbeat correction
- [ ] Per-stem mute/solo/gain/EQ, crossfade, beat-quantized swaps
- [ ] Tempo, key, pitch shift with key lock, loops, cues, phrase alignment
- [ ] Automatic transition and mashup engine (tempo, key, phrase, energy, vocal overlap, bass clash), editable plan, low-confidence explanation, half/double-time handling
- [ ] Session recording, project recall, export mix and stems

### 4.2 Separation
- [ ] Model comparison on authorized test audio: Demucs v4 (current), htdemucs_ft (loop-repeat test done: no gain for drums/bass), BS-Roformer 1297 and Kim MelBand (vocal/instrumental), plus a 6-stem model; report bleed, transients, vocal damage, low end, runtime, memory
- [ ] Fast preview versus quality render, cache, progress, cancel, recovery, CPU fallback
- [ ] Alignment, length and sample-rate preservation checks
- [ ] Honest labels: `other` is not "chords"

### 4.3 Stem2
- [ ] Device present and detected (blocked: no Stem device visible on this PC at inventory time)
- [ ] Capability matrix with evidence; supported export/handoff workflow
- [ ] Hardware verification on the physical device (only when connected)

### 4.4 Spotify
- [ ] PKCE login with secure token storage and logout (blocked on a Client ID from the user's Spotify developer dashboard)
- [ ] Library, playlists, playback through Spotify Connect, with an in-app notice of what is and is not allowed
- [ ] Local-recording matching

### 4.5 Plugin hosting
- [ ] Isolated scanner and classification (instrument versus effect, loads or not, licence state)
- [ ] Effect chains on tracks, routing, parameter editing, automation, state save/restore, latency compensation, tails, offline render, crash recovery
- [ ] Reopen-project test that restores the processed sound exactly

### 4.6 Automatic vocal engineer
- [ ] Analysis (clipping, noise, room, plosives, sibilance, pitch, timing, tone, dynamics)
- [ ] Editable chain, directions (clean, melodic, aggressive, distorted, airy), level-matched A/B, before/after renders, explanations

### 4.7 Artist-inspired presets
- [ ] Source log, reference analysis (signal analysis only where audio is accessible), adapted chains, alternatives, saved preset with plugin state

### 4.8 Licensed beat discovery
- [ ] Source adapters with licence capture; filtering; audition against the vocal with alignment

## 5. Verification approach

Automated: exported files checked for duration, alignment (cross-correlation against sources), clipping, non-finite samples, dropped audio; plugin state recall by render-compare before and after reopening a project; latency compensation by impulse test; tails by silence-after-note test. Listening comparisons are done by the user; the app and I only report measurements and say plainly when human listening is required.

## 6. Open items for the owner

1. A Spotify Client ID (create an app at developer.spotify.com/dashboard, redirect URI to be provided by this app) and whether the account is Premium.
2. Power on and connect the Stem2 (by USB and Bluetooth) so it can be detected; say which of its modes you want tested first.
3. Two or three representative vocal takes (raw WAV) and two song pairs for mashup testing, stored locally.

## 7. How STEM.FM does it (public pages only, read 2026-11-09)

Evidence from help.stem.fm (stem2-faqs, uploading-your-own-music, choosing-a-transition-mode, faq-import-music-library) and the App Store listing. Not read: daw.stem.fm (401, login required). No private endpoints, site scripts or network traffic were examined, and none will be: the Terms forbid extraction and scraping beyond the visual interface, and this plan does not depend on it.

* **Stems**: licensed catalogue tracks are located by track information and downloaded as licensed Stem tracks "when available"; uploads are stemmed by the service ("let it stem the track for you"). Where separation runs is not stated. Stems are vocals, drums, bass and melody.
* **Spotify import**: reads the user's public profile and playlists and turns playlists into "sessions". Nothing says Spotify audio is used. This matches the compliant pattern: Spotify supplies metadata, audio comes from a licensed catalogue or the user's own files.
* **Uploads**: audio-fingerprint checked (ACRCloud plus internal); matches to licensed content are blocked and replaced by the official catalogue version. Only tracks you uploaded or created yourself can be exported; licensed catalogue music stays inside Stem devices and StemFM.
* **Transitions**: three modes (Full Tracks, Balanced Mix, Short & Punchy), key matching (Camelot / Match Key / Preserve / Off), tempo and key shown per track, stem switches quantized to the beat, mixes ordered "where each tempo flows into the next". Phrase and downbeat detection: not stated. Mixes are built on the phone, M4A export.
* **Stem2**: pairs over **Bluetooth** (auto-reconnect; falls back to local playback if Bluetooth drops), uses **Wi-Fi** (5 GHz recommended) for the STEM button, catalogue download and account sync, **USB-C** for charging and "future data or audio output", 64 GB storage (about 1,000-2,000 Stem tracks), an AUX input, and a one-time setup at STEM.FM Setup in a **Chromium-based browser** on Windows/Mac/Linux/Android that "connects your device and mirrors audio and controls". The protocol is not documented; the Chromium requirement suggests a browser device API but that is an inference, not evidence.
* **Developer access**: no API, SDK or documented export for device content was found.

### What this means for Beatmaker

1. **Stem2 content**: Beatmaker cannot push content to the device through any documented route. Supported workflow: export your own stems/mixes (WAV/MP3) and use STEM.FM's own upload, which stems and syncs your own audio to the account and device. The official STEM.FM Setup page in Chrome remains the pairing path.
2. **Stem2 audio**: if Windows exposes it as a Bluetooth audio endpoint, Beatmaker can play to it like any speaker (audio output only; this proves nothing about stem control).
3. **Read-only discovery** (planned, needs the device connected): list the Bluetooth/USB services the device advertises, to document what it exposes. No pairing data is replayed, nothing is written to the device, no firmware or content is touched.
4. **Spotify**: follow the same pattern as StemFM: use the Spotify library for metadata and for playback through Spotify, and match entries to local files you own for any processing.
