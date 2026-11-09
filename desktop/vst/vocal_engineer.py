"""Automatic vocal engineer (Beatmaker): analyze a raw vocal, build a chain from what it finds, render before/after.

  python vocal_engineer.py vocal.wav beat.wav out_dir [direction] [--key C:minor] [--verb PATH.vst3]

Directions: clean, melodic, aggressive, distorted, airy. Writes in out_dir: analysis.json, report.md, the dry and
processed vocal, and mix_before.wav / mix_after.wav at the SAME integrated loudness (level-matched A/B).
Only what the analysis calls for is applied: a clean take gets no noise gate, no de-esser unless it is sibilant.
"""
import argparse
import json
import os
import sys

import numpy as np
import pyloudnorm as pyln
import pyworld as pw
import soundfile as sf
from pedalboard import Compressor, Delay, Distortion, Gain, HighpassFilter, HighShelfFilter, Limiter, LowpassFilter, NoiseGate, Pedalboard, PeakFilter, PitchShift, load_plugin
from scipy.signal import butter, sosfiltfilt

SR = 44100
FORCE_RETUNE = False
KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
DIRECTIONS = {
    #            presence air  comp  sat  double verb_s verb_decay delay_s retune_strength
    'clean':      dict(presence=1.5, air=1.5, ratio=3.0, drive=2.0, double=0.0, verb=-20, decay=1.6, delay=-99, retune=0.35, vocal_over_beat=4.0),
    'melodic':    dict(presence=1.0, air=2.0, ratio=3.5, drive=3.0, double=0.5, verb=-16, decay=2.4, delay=-22, retune=0.7, vocal_over_beat=3.5),
    'aggressive': dict(presence=3.0, air=0.5, ratio=5.0, drive=9.0, double=0.4, verb=-24, decay=1.0, delay=-26, retune=0.3, vocal_over_beat=5.0),
    'distorted':  dict(presence=2.0, air=0.0, ratio=6.0, drive=18.0, double=0.3, verb=-24, decay=1.2, delay=-99, retune=0.2, vocal_over_beat=5.0),
    'airy':       dict(presence=0.5, air=4.0, ratio=2.5, drive=1.5, double=0.6, verb=-14, decay=2.8, delay=-20, retune=0.5, vocal_over_beat=3.0),
}


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-9))


def band(x, lo, hi):
    # zero phase: the de-esser subtracts this band from the signal, which only cancels if it is not phase-shifted
    return sosfiltfilt(butter(4, [lo, hi], btype='band', fs=SR, output='sos'), x)


def frames_rms(x, n=2205):
    m = len(x) // n
    return np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1) + 1e-12)


def load_mono(path, n=None):
    x, sr = sf.read(path, dtype='float64', always_2d=True)
    assert sr == SR, f'{path}: expected {SR} Hz, got {sr}'
    x = x.mean(1)
    return x[:n] if n else x


def estimate_key(f0, forced=None):
    if forced:
        tonic, mode = forced.split(':')
        return KEYS.index(tonic), mode
    voiced = f0[f0 > 0]
    pc = np.round(12 * np.log2(voiced / 440.0) + 69).astype(int) % 12
    hist = np.bincount(pc, minlength=12).astype(float)
    best = max(((np.corrcoef(hist, np.roll(prof, k))[0, 1], k, m) for m, prof in (('major', MAJOR), ('minor', MINOR)) for k in range(12)))
    return best[1], best[2]


def scale_notes(tonic, mode):
    steps = [0, 2, 4, 5, 7, 9, 11] if mode == 'major' else [0, 2, 3, 5, 7, 8, 10]
    return sorted({(tonic + s) % 12 for s in steps})


def analyze(x, beat):
    a = {}
    a['duration_s'] = round(len(x) / SR, 2)
    a['peak_dbfs'] = round(float(db(np.abs(x).max())), 2)
    a['clipped_samples'] = int(np.sum(np.abs(x) >= 0.999))
    meter = pyln.Meter(SR)
    a['lufs'] = round(float(meter.integrated_loudness(x)), 2)
    r = frames_rms(x)
    r_db = db(r)
    a['noise_floor_dbfs'] = round(float(np.percentile(r_db, 10)), 1)
    voiced_level = float(np.percentile(r_db, 80))
    a['snr_db'] = round(voiced_level - a['noise_floor_dbfs'], 1)
    a['loudness_range_db'] = round(float(np.percentile(r_db, 95) - np.percentile(r_db, 20)), 1)
    a['crest_db'] = round(float(db(np.abs(x).max()) - db(np.sqrt(np.mean(x ** 2)))), 1)
    f0, t = pw.harvest(x, SR, f0_floor=70.0, f0_ceil=900.0, frame_period=5.0)
    voiced = f0 > 0
    a['voiced_fraction'] = round(float(voiced.mean()), 2)
    a['median_f0_hz'] = round(float(np.median(f0[voiced])), 1) if voiced.any() else 0
    # sung or rapped/spoken: the share of voiced time spent holding one pitch (within half a semitone) for 150 ms or more
    midi_all = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1.0) / 440.0), np.nan)
    held, i = 0, 0
    while i < len(midi_all):
        if np.isnan(midi_all[i]):
            i += 1
            continue
        j = i
        while j + 1 < len(midi_all) and not np.isnan(midi_all[j + 1]) and abs(midi_all[j + 1] - np.median(midi_all[i:j + 1])) < 0.5:
            j += 1
        if j - i + 1 >= 30:
            held += j - i + 1
        i = j + 1
    a['sustained_pitch_share'] = round(held / max(1, int(voiced.sum())), 2)
    tonic, mode = estimate_key(f0)
    a['key'] = f'{KEYS[tonic]}:{mode}'
    notes = scale_notes(tonic, mode)
    midi = 69 + 12 * np.log2(f0[voiced] / 440.0)
    near = np.array([min((m for m in range(int(m0) - 2, int(m0) + 3) if m % 12 in notes), key=lambda m: abs(m - m0)) for m0 in midi])
    a['pitch_deviation_cents_mean_abs'] = round(float(np.mean(np.abs(midi - near)) * 100), 1)
    low, mud, pres, sib, air = (np.mean(band(x, lo, hi) ** 2) for lo, hi in ((60, 200), (200, 450), (2000, 5000), (5500, 9500), (9500, 16000)))
    body = np.mean(band(x, 450, 2000) ** 2)
    a['mud_db_vs_body'] = round(float(10 * np.log10(mud / body)), 1)
    a['presence_db_vs_body'] = round(float(10 * np.log10(pres / body)), 1)
    a['sibilance_db_vs_body'] = round(float(10 * np.log10(sib / body)), 1)
    a['air_db_vs_body'] = round(float(10 * np.log10(air / body)), 1)
    a['low_rumble_db_vs_body'] = round(float(10 * np.log10(low / body)), 1)
    sib_env = frames_rms(band(x, 5500, 9500), 441)
    a['sibilance_peak_over_median_db'] = round(float(db(np.percentile(sib_env, 99)) - db(np.median(sib_env[sib_env > 0]))), 1)
    a['vocal_lufs'] = a['lufs']
    a['beat_lufs'] = round(float(meter.integrated_loudness(beat)), 2)
    return a, f0, t, (tonic, mode)


def retune(x, f0, t, tonic, mode, strength, speed_ms):
    """Pull the pitch toward the nearest scale note, keeping vibrato (the correction follows the smoothed pitch)."""
    notes = scale_notes(tonic, mode)
    x = np.ascontiguousarray(x, dtype=np.float64)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    voiced = f0 > 0
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1.0) / 440.0), 0.0)
    k = max(1, int(speed_ms / 5.0))
    smooth = np.convolve(midi, np.ones(2 * k + 1) / (2 * k + 1), mode='same')
    target = np.array([min((m for m in range(int(s) - 2, int(s) + 3) if m % 12 in notes), key=lambda m: abs(m - s)) if v else 0 for s, v in zip(smooth, voiced)])
    shift = np.where(voiced, (target - smooth) * strength, 0.0)
    f0n = np.where(voiced, f0 * 2 ** (shift / 12.0), 0.0)
    y = pw.synthesize(f0n, sp, ap, SR, 5.0)
    out = np.zeros_like(x)
    m = min(len(x), len(y))
    out[:m] = y[:m]
    return out


def deess(x, amount_db, thr_db):
    s = band(x, 5500, 9500)
    env = np.sqrt(np.convolve(s ** 2, np.ones(220) / 220, mode='same') + 1e-12)
    over = np.maximum(db(env) - thr_db, 0.0)
    gain = 10 ** (-(over * (1 - 1 / 3.0)) / 20)
    gain = np.maximum(gain, 10 ** (-amount_db / 20))
    return x - s + s * gain


def run(vocal_path, beat_path, out_dir, direction, forced_key, verb_path):
    os.makedirs(out_dir, exist_ok=True)
    d = DIRECTIONS[direction]
    x = load_mono(vocal_path)
    beat = load_mono(beat_path, len(x))
    n = min(len(x), len(beat))
    x, beat = x[:n], beat[:n]
    a, f0, t, (tonic, mode) = analyze(x, beat)
    if forced_key:
        tonic, mode = estimate_key(f0, forced_key)
        a['key'] = f'{KEYS[tonic]}:{mode} (set by you)'
    why = []
    if a['clipped_samples'] or a['peak_dbfs'] > 0:
        why.append(f"Source is clipped or over full scale ({a['clipped_samples']} samples at/over 0 dBFS, peak {a['peak_dbfs']} dBFS): this tool does not repair that, it only reports it.")
    y = x.copy()

    # 1. clip gain: bring the loudest phrases to a sane working level (the dry vocal stays the reference)
    g = -18.0 - a['lufs']
    y = y * 10 ** (g / 20)
    why.append(f"Clip gain {g:+.1f} dB (take was {a['lufs']} LUFS; working level -18 LUFS, so the plugins see a normal signal).")

    # 2. cleanup: highpass always; gate only if the take is noisy
    hp = 100 if a['median_f0_hz'] > 200 else 75
    chain = [HighpassFilter(hp)]
    why.append(f"High-pass at {hp} Hz (voice median {a['median_f0_hz']} Hz).")
    if a['snr_db'] < 24:
        chain.append(NoiseGate(threshold_db=a['noise_floor_dbfs'] + g + 8, ratio=2.0, attack_ms=3, release_ms=150))
        why.append(f"Gentle gate (ratio 2:1): noise floor {a['noise_floor_dbfs']} dBFS and SNR {a['snr_db']} dB are poor enough to matter.")
    else:
        why.append(f"No gate: SNR {a['snr_db']} dB, noise floor {a['noise_floor_dbfs']} dBFS is already clean.")
    y = Pedalboard(chain)(y, SR)

    # 3. pitch correction, only when the take is audibly off the scale
    retune_used = a['pitch_deviation_cents_mean_abs'] > 18 and d['retune'] > 0 and (a['sustained_pitch_share'] >= 0.35 or FORCE_RETUNE)
    if retune_used:
        y = retune(y, f0, t, tonic, mode, d['retune'], 40)
        why.append(f"Pitch correction toward {KEYS[tonic]} {mode}, strength {d['retune']:.2f}, vibrato kept: mean deviation was {a['pitch_deviation_cents_mean_abs']} cents.")
    elif a['sustained_pitch_share'] < 0.35:
        why.append(f"No pitch correction: only {a['sustained_pitch_share']:.0%} of the voiced time holds a pitch, so this reads as rapped or spoken, and snapping it to a scale would damage the delivery (mean deviation {a['pitch_deviation_cents_mean_abs']} cents is expected). Pass --retune to force it anyway.")
    else:
        why.append(f"No pitch correction: mean deviation {a['pitch_deviation_cents_mean_abs']} cents (limit 18).")

    # 5. corrective + direction EQ
    eq = []
    if a['mud_db_vs_body'] > -2:
        cut = -min(4.0, 1.5 + (a['mud_db_vs_body'] + 2) * 0.5)
        eq.append(PeakFilter(320, cut, 1.1))
        why.append(f"Mud cut {cut:.1f} dB at 320 Hz: 200-450 Hz is {a['mud_db_vs_body']} dB vs the body.")
    if a['presence_db_vs_body'] < -8 or d['presence'] > 2:
        eq.append(PeakFilter(3500, d['presence'] + (1.5 if a['presence_db_vs_body'] < -8 else 0), 0.9))
        why.append(f"Presence {d['presence']:+.1f} dB at 3.5 kHz (+1.5 more because presence is low) for the '{direction}' direction.")
    if a['air_db_vs_body'] < -18 or d['air'] >= 2:
        eq.append(HighShelfFilter(10000, d['air'], 0.7))
        why.append(f"Air shelf {d['air']:+.1f} dB above 10 kHz ({direction}; air is {a['air_db_vs_body']} dB vs body).")
    if eq:
        y = Pedalboard(eq)(y, SR)

    # 6. compression + saturation
    r_db = db(frames_rms(y))
    thr = float(np.percentile(r_db, 70))
    y = Pedalboard([Compressor(threshold_db=thr, ratio=d['ratio'], attack_ms=8, release_ms=90)])(y, SR)
    why.append(f"Compressor {d['ratio']}:1 with threshold at the 70th percentile level ({thr:.1f} dBFS): loudness range was {a['loudness_range_db']} dB.")
    if d['drive'] > 0:
        y = Pedalboard([Distortion(drive_db=d['drive']), Gain(-d['drive'] * 0.35)])(y, SR)
        why.append(f"Saturation drive {d['drive']} dB ({direction}).")
    # de-esser last, after the compressor and saturation (they lift the "s" sounds back up), tightened until the
    # measured sibilance is no worse than the raw take's: this is checked, not assumed
    def sib_ratio(sig):
        return 10 * np.log10(np.mean(band(sig, 5500, 9500) ** 2) / np.mean(band(sig, 450, 2000) ** 2))

    if a['sibilance_peak_over_median_db'] > 9 or a['sibilance_db_vs_body'] > -14:
        target = a['sibilance_db_vs_body'] + 0.5
        before_ratio = sib_ratio(y)
        used = None
        for pct in (75, 60, 45, 30):
            thr_db = float(np.percentile(db(frames_rms(band(y, 5500, 9500), 441)), pct))
            cand = deess(y, amount_db=10.0, thr_db=thr_db)
            used = (pct, sib_ratio(cand))
            y = cand if used[1] <= target else y
            if used[1] <= target:
                break
        else:
            y = deess(y, amount_db=10.0, thr_db=thr_db)
            used = (30, sib_ratio(y))
        why.append(f"De-esser (up to 10 dB, 5.5-9.5 kHz only) after the compressor: sibilance was {before_ratio:.1f} dB vs body after compression and saturation, target {target:.1f} dB (the raw take plus 0.5), reached {used[1]:.1f} dB (threshold at the {used[0]}th percentile of the band level).")
    else:
        why.append(f"No de-esser: sibilance {a['sibilance_db_vs_body']} dB vs body, peaks {a['sibilance_peak_over_median_db']} dB over median.")
    dry_processed = y.copy()

    # 7. doubles (stereo) and sends
    L = R = y.copy()
    if d['double'] > 0:
        up = Pedalboard([PitchShift(0.09)])(y, SR)
        dn = Pedalboard([PitchShift(-0.09)])(y, SR)
        dl = int(0.017 * SR)
        up = np.concatenate([np.zeros(dl), up[:-dl]])
        dn = np.concatenate([np.zeros(int(0.011 * SR)), dn[:-int(0.011 * SR)]])
        gdub = 10 ** (-9 / 20) * d['double']
        L = y + gdub * dn
        R = y + gdub * up
        why.append(f"Doubles: +/-9 cents, 11 and 17 ms late, at {20 * np.log10(gdub):.1f} dB, panned L/R ({direction}).")
    send_in = Pedalboard([HighpassFilter(300), LowpassFilter(8000)])(y, SR)
    wet = np.zeros_like(y)
    verb_note = 'built-in reverb'
    try:
        v = load_plugin(verb_path)
        probe = (np.random.default_rng(1).standard_normal((2, SR // 2)) * 0.2).astype(np.float32)
        if np.sqrt(np.mean((v.process(probe, SR, reset=True)[:, :probe.shape[1]] - probe) ** 2)) < 1e-3:
            raise RuntimeError('loads but passes audio through unchanged (not licensed or not activated on this PC)')
        v.mix = 100.0  # percent wet: this is a send
        vals = v.parameters['decay'].valid_values
        v.decay = min(vals, key=lambda s: abs(float(s.split()[0]) - d['decay']))
        wet = v(np.stack([send_in, send_in]).astype(np.float32), SR)
        wetL, wetR = wet[0].astype(np.float64), wet[1].astype(np.float64)
        verb_note = f"{os.path.basename(verb_path)} (your plugin), decay {d['decay']} s"
    except Exception as e:  # plugin missing or failing: say so, fall back
        from pedalboard import Reverb
        wr = Pedalboard([Reverb(room_size=0.5, wet_level=1.0, dry_level=0.0)])(send_in, SR)
        wetL = wetR = wr
        verb_note = f'built-in reverb (plugin not used: {type(e).__name__}: {str(e)[:80]})'
    gv = 10 ** (d['verb'] / 20)
    L, R = L + gv * wetL[:len(L)], R + gv * wetR[:len(R)]
    why.append(f"Reverb send {d['verb']} dB through {verb_note}.")
    if d['delay'] > -90:
        eighth = 60.0 / 130.0 / 2  # tempo from the project would go here
        de = Pedalboard([Delay(delay_seconds=eighth, feedback=0.25, mix=1.0), LowpassFilter(5000)])(send_in, SR)
        gd = 10 ** (d['delay'] / 20)
        L, R = L + gd * de[:len(L)], R + gd * de[:len(R)]
        why.append(f"Delay send {d['delay']} dB, one 1/8 note at 130 BPM, feedback 25%.")

    # 8. balance against the beat (band-limited to where a voice lives), then a gentle bus and a limiter
    vm = np.sqrt(np.mean(band(dry_processed, 200, 5000) ** 2))
    bm = np.sqrt(np.mean(band(beat, 200, 5000) ** 2))
    gb = 10 ** ((db(bm) + d['vocal_over_beat'] - db(vm)) / 20)
    voc = np.stack([L, R]) * gb
    why.append(f"Vocal set {d['vocal_over_beat']:+.1f} dB over the beat in the 200-5000 Hz band (gain {20 * np.log10(gb):+.1f} dB).")
    bus = lambda s: Pedalboard([Compressor(threshold_db=-18, ratio=1.5, attack_ms=30, release_ms=150), Limiter(threshold_db=-1.5)])(s.astype(np.float32), SR)
    after = bus(voc + np.stack([beat, beat]))
    # before: the raw vocal as it came, mono in both channels, against the same beat
    bv = x * 10 ** ((db(bm) + 0 - db(np.sqrt(np.mean(band(x, 200, 5000) ** 2)))) / 20) if False else x
    before = bus(np.stack([bv, bv]) + np.stack([beat, beat]))

    # 9. level-match A/B at the lower of the two loudnesses
    meter = pyln.Meter(SR)
    lb, la = meter.integrated_loudness(before.T), meter.integrated_loudness(after.T)
    target = min(lb, la)
    before_m = before * 10 ** ((target - lb) / 20)
    after_m = after * 10 ** ((target - la) / 20)
    ceiling = max(np.abs(before_m).max(), np.abs(after_m).max())
    if db(ceiling) > -1.0:  # both come down together so the A/B stays level-matched
        k = 10 ** ((-1.0 - db(ceiling)) / 20)
        before_m, after_m, target = before_m * k, after_m * k, target + 20 * np.log10(k)

    # 10. checks
    checks = {}
    checks['finite'] = bool(np.isfinite(after_m).all() and np.isfinite(before_m).all())
    checks['peak_after_dbfs'] = round(float(db(np.abs(after_m).max())), 2)
    checks['peak_before_dbfs'] = round(float(db(np.abs(before_m).max())), 2)
    checks['clipped_after'] = int(np.sum(np.abs(after_m) >= 0.999))
    checks['length_equal'] = bool(before_m.shape == after_m.shape == (2, n))
    seg = slice(0, min(n, 20 * SR))
    xc = np.correlate(dry_processed[seg] - dry_processed[seg].mean(), x[seg] - x[seg].mean(), 'full')
    lag = int(np.argmax(np.abs(xc)) - (len(x[seg]) - 1))
    checks['vocal_alignment_lag_samples'] = lag
    checks['vocal_alignment_ok'] = abs(lag) <= 64
    checks['matched_lufs'] = round(float(target), 2)
    checks['lufs_before_after_matched'] = bool(abs(meter.integrated_loudness(before_m.T) - meter.integrated_loudness(after_m.T)) < 0.1)

    sf.write(os.path.join(out_dir, 'mix_before.wav'), before_m.T, SR, subtype='PCM_24')
    sf.write(os.path.join(out_dir, f'mix_after_{direction}.wav'), after_m.T, SR, subtype='PCM_24')
    sf.write(os.path.join(out_dir, 'vocal_dry.wav'), x, SR, subtype='PCM_24')
    sf.write(os.path.join(out_dir, f'vocal_processed_{direction}.wav'), np.stack([L, R]).T * gb * 10 ** ((target - la) / 20), SR, subtype='PCM_24')
    with open(os.path.join(out_dir, f'analysis_{direction}.json'), 'w') as f:
        json.dump({'analysis': a, 'direction': direction, 'checks': checks, 'chain': why}, f, indent=2)
    with open(os.path.join(out_dir, f'report_{direction}.md'), 'w', encoding='utf-8') as f:
        f.write(f"# Vocal engineer report: {direction}\n\n## What it found\n" + ''.join(f'- {k}: {v}\n' for k, v in a.items()) + '\n## What it did and why\n' + ''.join(f'{i + 1}. {w}\n' for i, w in enumerate(why)) + '\n## Checks\n' + ''.join(f'- {k}: {v}\n' for k, v in checks.items()))
    print(json.dumps(checks))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('vocal')
    ap.add_argument('beat')
    ap.add_argument('out')
    ap.add_argument('direction', nargs='?', default='clean', choices=list(DIRECTIONS))
    ap.add_argument('--key')
    ap.add_argument('--retune', action='store_true', help='apply pitch correction even to rapped or spoken material')
    ap.add_argument('--verb', default=r'E:\beatmaker\VSTS\Valhalla_VintageVerb\ValhallaVintageVerb.vst3')
    args = ap.parse_args()
    FORCE_RETUNE = args.retune
    run(args.vocal, args.beat, args.out, args.direction, args.key, args.verb)
