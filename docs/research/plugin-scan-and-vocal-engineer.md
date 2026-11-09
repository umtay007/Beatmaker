# Plugin scan results (isolated host, pedalboard 0.9.26, 2026-11-09)

Method: `desktop/vst/scan_plugins.py` loads each VST3 in its own process (90 s limit). An effect "processes" only if
white noise through it comes out measurably different; an instrument "makes audio" only if a held note produces audio.
This proves a plugin works in a headless host on this PC today. It says nothing about licensing terms.

| Result | Plugins |
|---|---|
| Instrument, makes audio from a note | Bazille, Hive, Synplant, Zenology |
| Effect, processes audio | CHEat code, Portal, ShaperBox 3 |
| Loads, parameters listed, **passes audio through unchanged** | ValhallaVintageVerb, Rolling Sampler (typical of an unlicensed or unactivated plugin; mix 0-100 and tail were tested) |
| Loads, silent with default state | Kontakt 8 (no library loaded) |
| Does not load in a headless host ("unsupported plugin format or scan failure") | Serum 2, Omnisphere and FX-Omnisphere, Pigments (2 copies), Nexus, Rift, Luma, MuseForge Agent, Serato Sample, Analog Lab V (2 copies) |
| Timed out (90 s) | Icarus, SynthMaster 3, Gladiator |
| Loads but "does not produce audio output" | Wavestation |
| Crashed the scan process (contained) | Spire |

Open questions, not yet tested: whether the non-loading plugins load with their GUI (native editor) or need their own
installer's registry/license files; whether the timeouts are first-run sample or license dialogs. Native Windows
installs (not run from the VSTS folder) were not tried, and nothing was installed or changed.

# Vocal engineer, first working slice

`desktop/vst/vocal_engineer.py` analyzes a vocal, builds a chain from what it finds, and renders five directions
(clean, melodic, aggressive, distorted, airy) as level-matched before/after mixes. Verified on a 45 s verse of the owner's
own Walk vocals (separated by BS-Roformer, so a rapped, partly clipped test source, not a raw studio take):
- Detects clipping in the source (101 samples over full scale) and reports it; does not repair it.
- Detects rapped/spoken delivery (14% sustained pitch) and skips pitch correction rather than snapping it to a scale.
- Skips the gate on a clean 31 dB SNR take; applies a conditional de-esser after compression, tightened until the
  measured sibilance is no worse than the raw take (checked, after fixing a phase bug found by this very measurement).
- Measured: sibilance peaks 16.5 -> 9.2 dB over median; loudness range 21.5 -> 12.7-15.4 dB; presence -8.9 -> -4.0..-5.3 dB vs body.
- Exports finite audio, no clipping, peaks <= -1 dBFS, vocal alignment lag 0 samples, before/after matched at the same LUFS.
- ValhallaVintageVerb is detected as non-processing and the built-in reverb is used, and the report says so.
Not yet done: timing correction, harmonies/ad-lib routing, noise reduction, saving the chain as an app preset with plugin
state, a UI. Human listening of the renders is still required.
