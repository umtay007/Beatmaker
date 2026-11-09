"""Clean the bleed of a voice out of a separated stem (Beatmaker, original-stems mode).

  python declean.py stem.wav vocals.wav out.wav <bpm> <offset seconds> [bars per loop] [guide strength]

Stage 1, for songs built from loops: passes of the same loop (8 bars) that repeat each other keep only
what they share, so bleed that changes every pass (a different line of vocal each verse) goes.
Stage 2: bins where the vocals track is loud compared with the stem are turned down, at most 9 dB.
Walk: the stage 1 result still had a slight buzz in the drums and chords; with stage 2 at 0.6 it was gone.
"""
import sys
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import istft, resample_poly, stft

src, voc, dst = sys.argv[1], sys.argv[2], sys.argv[3]
bpm, off = float(sys.argv[4]), float(sys.argv[5])
loop_bars = int(sys.argv[6]) if len(sys.argv) > 6 else 8
beta = float(sys.argv[7]) if len(sys.argv) > 7 else 0.6
NF, HOP = 2048, 512

x, sr = sf.read(src, dtype='float32', always_2d=True)
v, vsr = sf.read(voc, dtype='float32', always_2d=True)
if int(vsr) != int(sr):
    g = gcd(int(sr), int(vsr))
    v = resample_poly(v, int(sr) // g, int(vsr) // g, axis=0).astype('float32')

# Stage 1: what the repeats of a loop share
L = loop_bars * 4 * 60 / bpm
n = int(L * sr)
passes = int((len(x) / sr - off) // L)
starts = [int(round((off + k * L) * sr)) for k in range(passes)]
seg = lambda k: x[starts[k]:starts[k] + n].mean(1)
unit = lambda p: p / (np.linalg.norm(p) + 1e-12)
corr = np.array([[float(unit(seg(a)) @ unit(seg(b))) for b in range(passes)] for a in range(passes)]) if passes else np.zeros((0, 0))
left, clusters = set(range(passes)), []
while left:
    a = min(left)
    members = [b for b in left if corr[a, b] >= 0.8]
    clusters.append(members)
    left -= set(members)
out = x.copy()
for members in clusters:
    if len(members) < 2:
        continue
    for ch in range(x.shape[1]):
        Z = [stft(x[starts[k]:starts[k] + n, ch], sr, nperseg=NF, noverlap=NF - HOP)[2] for k in members]
        mag = np.stack([np.abs(z) for z in Z])
        shared = np.median(mag, axis=0) if len(members) > 2 else mag.min(0)
        for k, z in zip(members, Z):
            y = istft(z * np.minimum(1.0, shared / (np.abs(z) + 1e-9)), sr, nperseg=NF, noverlap=NF - HOP)[1][:n]
            out[starts[k]:starts[k] + len(y), ch] = y
print('loops', [m for m in clusters if len(m) > 1], flush=True)

# Stage 2: turn down where the voice is loud compared with the stem
m = min(len(out), len(v))
x2, v = out[:m], v[:m]
res = np.zeros_like(x2)
for ch in range(x2.shape[1]):
    _, _, X = stft(x2[:, ch], sr, nperseg=NF, noverlap=NF - HOP)
    _, _, V = stft(v[:, min(ch, v.shape[1] - 1)], sr, nperseg=NF, noverlap=NF - HOP)
    gain = np.maximum(np.abs(X) ** 2 / (np.abs(X) ** 2 + beta * np.abs(V) ** 2 + 1e-12), 0.35)
    res[:, ch] = istft(X * gain, sr, nperseg=NF, noverlap=NF - HOP)[1][:m]
final = out.copy()
final[:m] = res
sf.write(dst, final, int(sr), subtype='PCM_16')
print('RESULT ok')
