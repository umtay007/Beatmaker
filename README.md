# Beatmaker Studio

Make any beat from scratch in your browser, then turn it into a synced music video.

Beatmaker is a beat maker and a MIDI music-video visualizer (in the spirit of
[VIDI Studio](https://app.dozingwhale.net/vidi-studio/)) in one app. Drums and most instruments are
synthesized in real time with the Web Audio API; 20 real, recorded instruments stream in on demand
when you use them. The visualizer draws each note of your beat as it plays, and you can export the
result as an MP4 or WebM video.

## Features

**Make the beat**

- **Generate a beat in one click** in 9 styles: Trap, Boom Bap, Lo-Fi, House, UK Drill,
  Reggaeton, Afrobeats, Drum & Bass and Synthwave. Each one writes drums, bass or 808 (with
  slides), voiced chord progressions and a melody built from a motif. You can edit every note
  afterwards.
- **Start blank and program your own.** Melodic tracks use a piano roll with scale highlighting,
  and drum tracks use a step grid. Both have a velocity lane, box selection, copy/paste, duplicate,
  transpose, nudge, quantize, humanize and undo/redo.
- **66 instruments** in families (Keys, Guitar, Strings, Brass, Woodwind, Bass, Pluck, Mallet, Bell,
  Pad, Lead, Vocal):
  - **20 real, sampled instruments**: grand piano, pipe organ, harmonium, acoustic, nylon and clean
    electric guitar, electric and upright bass, violin, cello, harp, trumpet, trombone, French horn,
    tuba, saxophone, flute, clarinet, bassoon and xylophone. Only the notes a song uses are
    downloaded; offline, a matching synth stands in.
  - **Physically modelled plucked strings**: koto, sitar (with its buzzing bridge), pizzicato strings.
  - **Mallets and bells**: kalimba, marimba, vibraphone, steel drum, music box, celesta, tubular
    bells, bell and glockenspiel.
  - **Keys**: electric piano, Wurlitzer, clavinet, piano, organ, accordion.
  - **Basses**: 808, 808 Smooth, 808 Punch (with the kick built in), 808 Distorted, sub, deep, reese,
    FM, acid 303, wobble and log-drum.
  - **Synths, pads and voices**: pad, strings, wide dark strings, choir, vocal ooh, vocal chop,
    supersaw, chord stab, synth lead, sine lead, chiptune, plus flute, whistle, harmonica, pan flute
    and brass.
- **9 synthesized drum kits** (Trap 808, Florida Trap, Boom Bap, Lo-Fi Dusty, House 909, Breaks,
  Retro 80s, Acoustic Kit, Afro Percussion) with 20 voices each, including snap, tambourine, congas,
  bongo, woodblock, triangle, shaker, cowbell, toms, crash and ride.
- **Recorded drum machines**: a real **TR-808** (plus a long-kick variant for trap), **TR-909** and
  **TR-707**, streamed on demand. Voices a machine never had fall back to synthesized ones.
- A **sampler** for your own sounds (Instrument → Sampler…): play a one-shot or vocal chop across
  the keyboard, **chop** a phrase or loop at its hits (one chop per key from C3, each cutting off
  the last, and a button that writes the chops back into the track), or play a **loop** stretched to
  the song tempo. With trim, level, attack, release and reverse. Sounds stay in your browser.
- **Load your own drum packs**: pick (or drop) the folder of any sample pack you have. Files are
  matched to drum voices by name ("Kick 01.wav", "Hats/Open Hat 3.wav", "BD0025.WAV"…), you can
  change any pick with a preview, and the pack is saved in your browser as a kit. Nothing is
  uploaded.
- Swing, tempo, key and scale, a loop range, a metronome, and live input from your computer
  keyboard with recording.
- A song-wide **tuning** control (in cents) and a per-track **fine tune**, for matching recordings
  that aren't at A = 440 Hz or an 808 that sits a little sharp.
- A **"New part" button** that rewrites a single track in any style.
- A mixer with volume, pan, reverb send, a tempo-synced **echo** send (1/8, dotted 1/8, 1/4
  triplet…), mute and solo for each track.
- Per-track **FX** in the editor bar: echo, fine tune, **sidechain ducking** (the track dips on
  every kick and swells back, like a sidechained compressor, with depth and release), a 3-band
  **EQ** with a sweepable mid, and a **low-cut / high-cut filter** with resonance.

**Remake an existing beat**

- **Load the original track as a reference.** *Detect tempo, key & align grid* finds its BPM,
  first beat (to the millisecond), key and tuning. The waveform then appears behind the editor, so you can program the drums and
  notes by ear while it plays. The *Shift grid* buttons (−1, −½, +½, +1 beat) fix any leftover
  offset, and *Starter beat* writes a first draft in any style on that tempo, key and length.
- **Analyze sound & match mix** measures what the original's mix engineer did: the EQ curve,
  loudness and compression, stereo width, reverb length, tempo-locked echo, bass saturation and
  sidechain pumping. It can't name plugins, only what they did. *Match my mix to it* renders your
  song, compares it with the same stretch of the original (use the loop to pick an instrumental
  part) and sets the new **Master** section: a 10-band EQ, stereo width, output level, reverb length
  and echo timing. If the original pumps, it also ducks your melodic tracks on the kick, adjusting
  the depth until your render dips as far as the original.
- Files are recognized by their content, so downloads without an extension still open.
- **Import MIDI** of any song or beat. Channel 10 and tracks named like drums ("kick", "hat", …)
  become drum tracks, and GM programs are mapped to the closest instrument (the real, sampled ones
  where they exist). Imports keep tempo changes and key signatures.
- **Visualize a real recording:** import the song's MIDI and load its audio. You hear the
  recording and the video follows the MIDI notes, which is the VIDI workflow.

**Make the video**

- The notes can flow right to left or fall top to bottom. You can set the hit-line position, the
  time on screen, and "compact" or "true interval" pitch spacing. Drums get their own lane.
- Note styles: solid, outline, gradient tail, neon or thin line. Head markers: circle, diamond,
  star, heart, square or any emoji.
- Hit effects: ripple, spark burst, lens flare, pluck (a vibrating string) and pulse.
- Background particles (sparkles, dust, comets, snow, twinkle, bubbles) that react to the bass.
- A camera that punches in and shakes on the kick (or on any track).
- A WebGL post-processing pass: bloom, fisheye or pincushion lens, chromatic aberration, color
  grade, vignette, film grain and scanlines.
- Overlays: an animated title and subtitle (20 Google Fonts), live **chord detection**, an audio
  spectrum (bars, wave or ring) and a progress bar.
- Intro and outro transitions: iris, fade, wipe and zoom.
- 9 look presets: Neon Pulse, Aurora Flow, Candy Pop, Lo-Fi Tape, Minimal Mono, Morning Sky,
  Mystic Violet, Falling Keys and Club Spectrum. There are also 8 track-color palettes.
- **Export video** as MP4 or WebM in 16:9, 9:16, 1:1 or 4:5, at 720p up to 4K and 30 or 60 fps.
  You can export the whole song or just the loop, with lead-in and tail.
- **Export WAV** (rendered offline, sample-aligned to the grid), **export stems** (a WAV per track
  plus the full mix, in a ZIP; stems skip the master compressor so they add up to the mix), **export MIDI**, and save or open
  projects as `.json`. A project that uses your own sounds (drum packs, sampler sounds) saves as a
  `.zip` with those sounds inside, so it opens with them in any browser.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build          # static site in dist/ (deploy anywhere: GitHub Pages, Netlify, Vercel…)
npm run build:single   # one self-contained HTML file in dist-single/index.html
npm run typecheck
```

There are no runtime dependencies. The only dev dependencies are Vite and TypeScript, plus
`vite-plugin-singlefile` for the single-file build. The sampled instruments need an internet
connection the first time a song uses them.

## How to…

**Make a beat from scratch.** Open the **Beat** tab, pick a style, then click **Generate beat**.
To start empty, click **Blank beat**. Click a track on the left to edit it below. Click the grid
to add notes or drum hits, and drag to paint. Drag a note to move it, drag its right edge to
resize it, and right-click to erase.

**Remake a song by ear.** Choose **File → Load reference audio…**, then **Detect tempo, key & align
grid** under *Backing audio*. Add tracks with **+ Drums** or **+ Instrument** and program along with the
waveform. Turn *Audio volume* down to 0 before exporting if you want only your remake in the file.

**Visualize any song.** Drag its `.mid` file and its audio file onto the window together. You can
fine-tune the sync with *Audio offset*.

**Style and export.** In the **Visual** tab, pick a preset and tweak any section. Then use the
**Export** tab or the **Export video** button in the top bar. Video is recorded in real time, so
keep the tab visible while it records.

## Credits

The sampled instruments are the [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments)
sample set by Nicholaus Brosowsky (CC BY 3.0), loaded from the jsDelivr CDN.

The recorded drum machines come from the [fluid-music/open-drums](https://github.com/fluid-music/open-drums)
packages, also loaded from jsDelivr: the TR-808 set by Michael Fischer (free, no restrictions), the
TR-909 set by Jason Baker / Rob Roy Recordings (free to use and share, not to be sold) and the
TR-707 set by Francois Dion (public domain).

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Space / Enter | Play–pause / stop |
| L · M · F | Loop · metronome · maximize the preview |
| K | Computer-keyboard input (Z…M and Q…U play notes, `[` `]` change octave, Esc exits) |
| R | Arm recording (notes you play while the song runs are recorded, quantized to the grid) |
| Ctrl/⌘ Z, Ctrl/⌘ Shift Z | Undo, redo |
| Ctrl/⌘ C · V · D · A | Copy · paste at the playhead · duplicate · select all |
| ↑ ↓ (Shift = octave) · ← → | Transpose · nudge the selection |
| Delete | Delete the selection |
| Shift-drag on the grid · on the ruler | Box-select · set the loop range |
| Alt-drag · Alt-click on a drum step | Duplicate notes · add a ghost note |
| Ctrl/⌘ + wheel | Zoom the editor |

## Browser support

The app runs in current Chrome, Edge, Firefox and Safari. Video export uses `MediaRecorder` and
records the canvas and the master audio bus in real time. It writes MP4 where the browser can
record it (Chrome/Edge 126+, Safari) and WebM otherwise (Firefox). WebGL is optional: without it,
the preview falls back to 2D rendering with no post effects.

## Project layout

```
src/
  core/      song model, tempo map + swing timeline, music theory & chord detection, store/undo
  audio/     drum kits (synthesized, recorded, user packs), synthesized and sampled instruments, mixer graph, lookahead
             scheduler, offline render, tempo / key / tuning detection
  beats/     genre-aware beat generator, blank/demo templates
  midi/      Standard MIDI File parser/writer and GM mapping
  visual/    Canvas2D scene, WebGL post-processing, presets/settings, preview player, video export
  ui/        top bar, track list, piano roll / step grid, inspector, keyboard, file actions
```

The visualizer is **stateless with respect to time**. Every frame is computed from the song
position, including the hit effects and the camera. Preview, scrubbing and export therefore stay
frame-for-frame consistent with the audio.
