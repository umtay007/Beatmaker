"""A plugin preset playing notes read from a recording (resynth.py's), each with its own level curve.

  python vstfit.py render <plugin.vst3> <preset> <fit.json> <out.wav>
      The preset is sampled once at every pitch the notes use (one held note each); each note is then that
      sample shaped by the note's own curve. 44.1 kHz stereo from time 0, peaks at -1 dB.
  python vstfit.py search <plugin.vst3> <presets-dir> <stem.wav> <fit.json> <out.jsonl> [shard/of]
      Rank every preset under a folder against the stem the notes were read from, by the app's own score for
      the part (metric.py), over two 10 s stretches. Slow (a few seconds a preset); resumable; several can run
      side by side as shards (0/4, 1/4, ...).

Presets are .h2p files (u-he synths: written straight into the plugin's state, see jstate.py) or .vstpreset.
Runs in the --sep folder's Python (pedalboard, numpy, scipy, soundfile, librosa).
"""
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf
from pedalboard import load_plugin
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jstate  # noqa: E402
import metric  # noqa: E402

SR = 44100
SKIP = ('Drums', 'Loops', 'FX', 'Bass')  # preset folders that are not chords or melody sounds


def midi(status, a, b=0):
    return bytes([status, a & 0x7F, b & 0x7F])


def set_preset(plugin, raw0, path):
    if path.lower().endswith('.h2p'):
        plugin.raw_state = jstate.with_component(raw0, open(path, 'rb').read())
    else:
        plugin.load_preset(path)


def play(plugin, fit, notes, total, longest_hold):
    """The notes through the plugin as it is set now: (2, total) at SR."""
    step = fit['step']
    longest = {}
    for n in notes:
        longest[n[0]] = max(longest.get(n[0], 0), n[2] - n[1])
    samples = {}
    for q, held in longest.items():
        hold = min(longest_hold, held + 0.1)
        samples[q] = plugin([(midi(0x90, q, 100), 0.0), (midi(0x80, q, 0), hold)], duration=hold + 0.1, sample_rate=SR, num_channels=2, buffer_size=1024, reset=True)
    y = np.zeros((2, total))
    for q, s, _e, lev, _k, shape in notes:
        a0 = int(s * SR)
        n = min(samples[q].shape[1], int((step * len(shape) + 0.06) * SR), total - a0)
        if a0 < 0 or n <= 0:
            continue
        # the note's curve: up from nothing over the first step, then its own levels, then 60 ms down
        c = np.concatenate([[0], shape])
        env = np.interp(np.arange(n) / SR, np.concatenate([step * np.arange(len(c)), [step * (len(c) - 1) + 0.06]]), np.concatenate([c, [0]]))
        y[:, a0:a0 + n] += samples[q][:, :n] * env * lev
    return y


def render(plugin_path, preset, fit_path, out):
    fit = json.load(open(fit_path))
    plugin = load_plugin(plugin_path)
    set_preset(plugin, plugin.raw_state, preset)
    y = play(plugin, fit, fit['notes'], int((max(n[2] for n in fit['notes']) + 1.0) * SR), 8.0)
    peak = float(np.abs(y).max())
    if peak < 1e-5:
        sys.exit('The preset played nothing.')
    sf.write(out, (y / peak * 0.89).T.astype(np.float32), SR, subtype='PCM_16')
    print('RESULT', os.path.basename(preset))


def search(plugin_path, presets, stem_path, fit_path, out, shard=None):
    import librosa
    fit = json.load(open(fit_path))
    stem, _ = librosa.load(stem_path, sr=metric.SR, mono=True)
    # two 10 s stretches, where the notes are densest in each half of the song
    starts = np.array([n[1] for n in fit['notes']])
    end = float(starts.max())
    wins = []
    for a, b in ((0, end / 2), (end / 2, end)):
        grid = np.arange(a, max(a + 1, b - 10), 2.0)
        w0 = float(grid[np.argmax([((starts >= g) & (starts < g + 10)).sum() for g in grid])])
        wins.append((w0, w0 + 10))
    notes = [n for n in fit['notes'] if any(a <= n[1] < b - 0.3 for a, b in wins)]
    files = [f for f in sorted(glob.glob(os.path.join(presets, '**', '*.h2p'), recursive=True) + glob.glob(os.path.join(presets, '**', '*.vstpreset'), recursive=True))
             if not any(s in os.path.relpath(f, presets) for s in SKIP)]
    if shard:
        files = files[int(shard.split('/')[0])::int(shard.split('/')[1])]
    done = {json.loads(line)['preset'] for line in open(out, encoding='utf-8')} if os.path.exists(out) else set()
    plugin = load_plugin(plugin_path)
    raw0 = plugin.raw_state
    total = int((max(b for _, b in wins) + 1) * SR)
    for f in files:
        rel = os.path.relpath(f, presets).replace(os.sep, '/')
        if rel in done:
            continue
        try:
            set_preset(plugin, raw0, f)
            y = resample_poly(play(plugin, fit, notes, total, 3.0).mean(0), 1, 2).astype(np.float32)
            parts = [metric.score('other', stem[int(a * metric.SR):int(b * metric.SR)], y[int(a * metric.SR):int(b * metric.SR)], True) for a, b in wins]
            row = {'preset': rel, 'score': round(float(np.mean([p[0] for p in parts])), 1)}
        except Exception as ex:  # one preset failing is not the search failing
            row = {'preset': rel, 'error': str(ex)[:160]}
        with open(out, 'a', encoding='utf-8') as o:
            o.write(json.dumps(row) + '\n')
        print(row, flush=True)
    print('RESULT done')


if __name__ == '__main__':
    if sys.argv[1] == 'render':
        render(*sys.argv[2:6])
    elif sys.argv[1] == 'search':
        search(*sys.argv[2:8])
    else:
        sys.exit(__doc__)
