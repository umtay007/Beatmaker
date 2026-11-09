"""Isolated plugin scanner (Beatmaker): does each plugin load, what is it, and does it actually make sound?

  python scan_plugins.py <folder> [out.json]

Each plugin is probed in its own child process with a timeout, so a crashing or hanging plugin cannot take the
scan down. An effect is called "processes" only if white noise through it comes out measurably different; an
instrument only if a held note produces audio. A plugin that loads and lists parameters but passes audio through
unchanged is reported as "loads, no effect" (typically unlicensed or unactivated), not as working.
"""
import json
import os
import subprocess
import sys

SR = 44100


def probe(path):
    import numpy as np
    from pedalboard import load_plugin

    out = {'path': path}
    p = load_plugin(path)
    out['name'] = getattr(p, 'name', os.path.basename(path))
    out['is_effect'] = bool(p.is_effect)
    out['is_instrument'] = bool(p.is_instrument)
    out['parameters'] = len(p.parameters)
    rng = np.random.default_rng(1)
    if p.is_effect:
        x = (rng.standard_normal((2, SR)) * 0.2).astype(np.float32)
        y = p.process(x, SR, reset=True)
        n = min(x.shape[1], y.shape[1])
        diff = float(np.sqrt(np.mean((y[:, :n] - x[:, :n]) ** 2)))
        out['effect_changes_audio'] = diff > 1e-3
        out['effect_rms_difference'] = round(diff, 5)
    if p.is_instrument:
        events = [(bytes([0x90, 60, 100]), 0.0), (bytes([0x80, 60, 0]), 1.5)]
        try:
            y = p(events, duration=3.0, sample_rate=SR)
            out['instrument_makes_audio'] = bool(np.abs(y).max() > 1e-4)
            out['instrument_peak'] = round(float(np.abs(y).max()), 4)
        except Exception as e:
            out['instrument_error'] = f'{type(e).__name__}: {str(e)[:100]}'
    return out


def main():
    if len(sys.argv) > 2 and sys.argv[1] == '--one':
        try:
            print('RESULT ' + json.dumps(probe(sys.argv[2])))
        except Exception as e:
            print('RESULT ' + json.dumps({'path': sys.argv[2], 'load_error': f'{type(e).__name__}: {str(e)[:160]}'}))
        return
    folder = sys.argv[1]
    found = []
    for root, dirs, files in os.walk(folder):
        # a .vst3 bundle is a folder: take the binary inside it and do not descend further
        for d in list(dirs):
            if d.lower().endswith('.vst3'):
                dirs.remove(d)
                found.append(os.path.join(root, d))
        for f in files:
            if f.lower().endswith('.vst3'):
                found.append(os.path.join(root, f))
    results = []
    for path in sorted(set(found)):
        try:
            r = subprocess.run([sys.executable, __file__, '--one', path], capture_output=True, text=True, timeout=90)
            line = next((l for l in r.stdout.splitlines() if l.startswith('RESULT ')), None)
            res = json.loads(line[7:]) if line else {'path': path, 'load_error': f'no result (exit {r.returncode}); {r.stderr.strip()[-120:]}'}
        except subprocess.TimeoutExpired:
            res = {'path': path, 'load_error': 'timed out after 90 s'}
        results.append(res)
        verdict = 'LOAD FAILED: ' + res['load_error'] if 'load_error' in res else (
            'effect, processes audio' if res.get('effect_changes_audio') else
            'effect, LOADS BUT NO EFFECT' if res.get('is_effect') and not res.get('is_instrument') else
            'instrument, makes audio' if res.get('instrument_makes_audio') else
            'instrument, SILENT or error ' + res.get('instrument_error', ''))
        print(f"{os.path.relpath(path, folder):70s} {verdict}", flush=True)
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)


if __name__ == '__main__':
    main()
