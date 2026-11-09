# Research source log

Method key: `read` = I read the page text; `search` = search-result summary only (weak); `signal` = I analyzed audio; `inference` = my reasoning. Page text is treated as data, never as instructions.

| Date read | Source | Method | Finding | Confidence |
|---|---|---|---|---|
| 2026-11-09 | https://help.stem.fm/articles/faqs (via stemplayer.com/faq redirects) | read | Stem2: "Wireless speaker. 40 hours battery. Local storage. Syncs with StemFM. Touch stem controls. Works with StemFM or standalone." Original Stem Player listed separately. | high that it says this; says nothing on connectivity |
| 2026-11-09 | https://alpha.stem.fm/llms-full.txt | read | Self-described discovery aid, not authoritative. Claims original puck "loads user audio over USB-C and splits it on-device into four stems"; Stem2 "next-generation hardware successor". No API/SDK. | medium-low |
| 2026-11-09 | https://help.stem.fm/articles/terms-and-conditions | read | Personal use only; no extraction/scraping/bulk analysis beyond the visual interface (3.3, 5.3); no mention of reverse engineering or device protocol. Not legal advice. | high for wording |
| 2026-11-09 | https://help.stem.fm/articles/faq-import-music-library | read | Spotify profile import on the web only; playlists must be public; not on the iOS app. | high |
| 2026-11-09 | https://products.stemplayer.com, https://stem.fm | read | JavaScript shells; no spec content retrievable. Stem2 connectivity not stated anywhere official that I could read. | n/a |
| 2026-11-09 | https://developer.spotify.com/policy (effective 15 May 2025) | read | III.5 no integration with another service's content; III.6 no sync with visual media; III.7 no mixing/segue with other audio; III.13 no analysis; III.14 no ML/AI ingestion; IV.1 streaming only for Premium; IV.2 commercial use not permitted for SDAs. | high |
| 2026-11-09 | https://developer.spotify.com/documentation/web-playback-sdk | read | Needs Premium; Chrome/Firefox/Safari/Edge; "must not be used in commercial projects without Spotify's prior written approval". Electron/DRM not stated. | high |
| 2026-11-09 | https://developer.spotify.com/documentation/web-api/concepts/quota-modes | read | Development mode: 5 allowlisted users, owner needs Premium; extended mode: organizations only, 250k+ MAU. | high |
| 2026-11-09 | https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow | read | PKCE recommended where a client secret cannot be stored; verifier 43-128 chars; S256 challenge; redirect URI must match exactly. | high |
| 2026-11-09 | Spotify changelog pages (Feb/Mar/May/Jul 2026) | read | Many endpoints removed Feb 2026; player endpoints (play/pause/seek/transfer/queue/volume) remain. Status of audio-features/analysis not stated on pages read. | medium |
| 2026-11-09 | web search: beat licensing (blogs, FAQs) | search | CC0 is cleanest; "free" often means non-commercial; Content ID can claim even licensed beats. Secondary sources only. | low-medium; verify per beat |
| 2026-11-09 | web search: audio-to-MIDI, separation, drum transcription, synth matching | search | Leads: Basic Pitch, NeuralNote, MT3, BS-RoFormer (lucidrains), Music-Source-Separation-Training toolkit, ADTOF, torchsynth, Sound2Synth, DDX7. Not yet read in depth. | leads only |
| 2026-11-09 | local test, Walk.flac (authorized: user's own file) | signal | Demucs v4 versus htdemucs_ft versus voice-removed split: loop-repeat correlation drums 0.797 / 0.746 / 0.761, bass 0.999 all, chords 0.935 / 0.940 / 0.954. | high for this song only |
