"""Measure how a reference vocal is treated and save it as a preset the vocal engineer can aim for (Beatmaker).

  python vocal_reference.py reference_vocal.wav preset.json "Preset name" [--bpm 71] [--source "where it came from"]

The reference should be a vocal on its own (an acapella, or the vocals stem of a song you have). What is measured is
the sound of the finished vocal: tone, dynamics, how tightly it is tuned, width, how wet it is. Nothing here knows which
plugins were used; the preset stores targets, and vocal_engineer.py moves YOUR take toward them by measured amounts.
A separated stem carries separation artefacts and the song's reverb, so these are estimates, labelled as such.
"""
import argparse
import json
import sys
import time

import numpy as np
import pyworld as pw
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfiltfilt

SR = 44100


def band(x, lo, hi):
    return sosfiltfilt(butter(4, [lo, hi], btype='band', fs=SR, output='sos'), x)


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-9))


def frames_rms(x, n=2205):
    m = len(x) // n
    return np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1) + 1e-12)


def measure(path, bpm=None):
    x, sr = sf.read(path, dtype='float64', always_2d=True)
    if sr != SR:
        from math import gcd
        g = gcd(SR, int(sr))
        x = resample_poly(x, SR // g, int(sr) // g, axis=0)
    left, right = x[:, 0], x[:, -1]
    mono = (left + right) / 2
    side = (left - right) / 2
    r = frames_rms(mono)
    loud = r > np.percentile(r, 60)  # frames where the voice is clearly on
    m = {}
    body = np.mean(band(mono, 450, 2000) ** 2)
    for name, (lo, hi) in {'mud': (200, 450), 'presence': (2000, 5000), 'sibilance': (5500, 9500), 'air': (9500, 16000)}.items():
        m[f'{name}_db_vs_body'] = round(float(10 * np.log10(np.mean(band(mono, lo, hi) ** 2) / body)), 1)
    r_db = db(r)
    m['loudness_range_db'] = round(float(np.percentile(r_db, 95) - np.percentile(r_db, 20)), 1)
    m['crest_db'] = round(float(db(np.abs(mono).max()) - db(np.sqrt(np.mean(mono ** 2)))), 1)
    # width: how much of the voice band sits in the sides (doubles, wideners, stereo reverb)
    m['width_db'] = round(float(10 * np.log10(np.mean(band(side, 300, 6000) ** 2) / (np.mean(band(mono, 300, 6000) ** 2) + 1e-12))), 1)
    # wetness: level in the gaps right after phrases against the phrase level (reverb and delay tails, plus stem bleed)
    on = r_db > np.percentile(r_db, 70) - 12
    tails = [r_db[i + 2:i + 8].mean() - r_db[max(0, i - 6):i].mean() for i in range(6, len(on) - 8) if on[i - 1] and not on[i:i + 8].any()]
    m['tail_db_below_phrase'] = round(float(-np.median(tails)), 1) if len(tails) >= 5 else None
    # tuning: within held notes, how far the pitch wanders (hard tuning holds it within a few cents)
    f0, t = pw.dio(mono, SR, f0_floor=70.0, f0_ceil=900.0, frame_period=5.0)
    f0 = pw.stonemask(mono, f0, t, SR)
    midi = np.where(f0 > 0, 69 + 12 * np.log2(np.maximum(f0, 1.0) / 440.0), np.nan)
    wander, held, i = [], 0, 0
    while i < len(midi):
        if np.isnan(midi[i]):
            i += 1
            continue
        j = i
        while j + 1 < len(midi) and not np.isnan(midi[j + 1]) and abs(midi[j + 1] - np.median(midi[i:j + 1])) < 0.5:
            j += 1
        if j - i + 1 >= 30:
            held += j - i + 1
            seg = midi[i + 4:j - 3]
            wander.append(float(np.std(seg) * 100))
        i = j + 1
    voiced = int(np.sum(~np.isnan(midi)))
    m['sustained_pitch_share'] = round(held / max(1, voiced), 2)
    m['pitch_wander_cents_in_held_notes'] = round(float(np.median(wander)), 1) if len(wander) >= 5 else None
    m['held_notes'] = len(wander)
    cents_off = np.abs((midi[~np.isnan(midi)] % 1.0 + 0.5) % 1.0 - 0.5) * 100  # distance to the nearest semitone
    m['mean_cents_from_nearest_semitone'] = round(float(np.mean(cents_off)), 1) if voiced else None
    # grit: how flat the spectrum is between the harmonics in the presence band while the voice is on (distortion fills it)
    seg = mono[:len(loud) * 2205].reshape(-1, 2205)[loud]
    spec = np.abs(np.fft.rfft(seg * np.hanning(2205), axis=1)) ** 2
    fr = np.fft.rfftfreq(2205, 1 / SR)
    sel = spec[:, (fr > 2000) & (fr < 6000)] + 1e-12
    m['presence_flatness'] = round(float(np.median(np.exp(np.mean(np.log(sel), axis=1)) / np.mean(sel, axis=1))), 3)
    if bpm:
        env = frames_rms(mono, 441)
        env = env - env.mean()
        ac = np.correlate(env[:6000], env[:6000], 'full')[5999:] if len(env) >= 6000 else None
        if ac is not None:
            lag = lambda beats: int(round(beats * 60 / bpm * 100))
            m['echo_hint_eighth_note'] = round(float(ac[lag(0.5)] / ac[0]), 2)
    return m


def to_preset(name, m, source):
    """Targets for the engineer, and the few choices that are not targets (tuning, doubles, wetness)."""
    wander = m['pitch_wander_cents_in_held_notes']
    sung = m['sustained_pitch_share'] >= 0.3
    hard = sung and wander is not None and wander < 12
    tail = m['tail_db_below_phrase']
    return {
        'name': name,
        'kind': 'reference-derived vocal preset',
        'source': source,
        'made': time.strftime('%Y-%m-%d'),
        'measured': m,
        'targets': {'presence_db_vs_body': m['presence_db_vs_body'], 'air_db_vs_body': m['air_db_vs_body'], 'mud_db_vs_body': m['mud_db_vs_body'], 'loudness_range_db': m['loudness_range_db'], 'width_db': m['width_db']},
        'tuning': {'apply': bool(sung), 'strength': 1.0 if hard else 0.6 if sung else 0.0, 'speed_ms': 8 if hard else 35,
                   'why': f"{int(m['sustained_pitch_share'] * 100)}% of the reference's voiced time holds a pitch; held notes wander {wander} cents" + (' (very steady: reads as hard tuning)' if hard else '')},
        'drive_db': round(float(np.interp(m['presence_flatness'], [0.05, 0.15, 0.35], [2, 8, 18])), 1),
        'reverb_send_db': round(float(np.interp(tail, [8, 14, 24], [-12, -17, -26])), 1) if tail is not None else -20,
        'reverb_decay_s': 2.0,
        'delay_send_db': -20 if (m.get('echo_hint_eighth_note') or 0) > 0.35 else -99,
        'confidence': 'estimates from a finished vocal, not the artist\'s settings; a separated stem adds artefacts and the song\'s own reverb',
        'dependencies': 'built-in processors only (no plugins)',
        'format': 1,
    }


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('out')
    ap.add_argument('name')
    ap.add_argument('--bpm', type=float)
    ap.add_argument('--source', default='')
    a = ap.parse_args()
    preset = to_preset(a.name, measure(a.reference, a.bpm), a.source)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(preset, f, indent=2)
    print('RESULT ' + json.dumps(preset['measured']))
