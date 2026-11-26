"""Read a melodic stem as notes on instruments fitted to it: python resynth.py other.wav out.json

Runs in the --sep folder's Python (torch; CUDA when there is one). The stem's spectrogram is modelled as notes of
one harmonic sound: V[band, t] ~ sum over pitches p and harmonics h of a[h] * H[p, t] * B[p, h, band], where B is
what a steady sine at harmonic h of pitch p looks like in the spectrogram. Fitting learns the overtone recipe a
and how loud each pitch is over time, H. H is then cut into notes (on where a pitch clearly sounds, off once it
has clearly gone, split where it is struck again), and the notes are grouped by how they swell and fade into a
few kinds: each kind becomes one instrument with that envelope. Nothing of the stem's audio is kept: the result
is pitches, times, velocities, an overtone recipe and envelope curves.

The spectrogram is the one the app scores remakes with (audio/finder.ts: 22050 Hz, 2048-sample Hann windows, 512
hop, quarter-tone bands from 40 Hz), so what fits here is what scores there.

Writes {"step": seconds per envelope point, "harmonics": [amplitude of each harmonic, the first is 1],
"kinds": [{"envelope": [...], "notes": n}], "notes": [[pitch, start s, end s, level 0..1, kind, [its own level
curve against its top, one value per step]]]}. A kind's envelope is what a note of that kind does typically (for
notes added by hand); each note read here carries its own.
"""
import json
import sys

import numpy as np
import torch
from scipy.ndimage import median_filter

SR, N, HOP, F_LO, PER_OCT, NB = 22050, 2048, 512, 40.0, 24, 192
LOW, HIGH = 36, 96  # pitches considered (C2..C7)
NHARM = 16
KINDS = 2
# a note is on where it reaches this much of the frame's loudest pitch and of the song's loudest, and stays on
# until it falls to a third of that; shorter notes and gaps (frames of 23 ms) are dropped and closed
REL, GLOB, HYST, MINLEN, GAP = 0.2, 0.06, 3.0, 6, 5
WIN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / (N - 1))


def bands_of(power):
    f = F_LO * 2 ** (np.arange(NB) / PER_OCT) * N / SR
    k = np.floor(f).astype(int)
    w = f - k
    a, b = power[..., k], power[..., np.minimum(k + 1, N // 2)]
    return np.maximum(a, b) * 0.5 + (a * (1 - w) + b * w) * 0.5


def spectrogram(x):
    n = 1 + (len(x) - N) // HOP
    idx = np.arange(N)[None, :] + HOP * np.arange(n)[:, None]
    return bands_of(np.abs(np.fft.rfft(x[idx] * WIN, axis=1)) ** 2)


def basis(pitches):
    """What each harmonic of each pitch looks like: a sine a little spread in pitch (chorus, vibrato)."""
    out = np.zeros((len(pitches), NHARM, NB), np.float32)
    t = np.arange(N) / SR
    for i, p in enumerate(pitches):
        f0 = 440 * 2 ** ((p - 69) / 12)
        for h in range(NHARM):
            f = f0 * (h + 1)
            if f > SR / 2 * 0.95:
                break
            acc = 0
            for k, cents in enumerate((-20, -10, 0, 10, 20)):
                acc = acc + bands_of(np.abs(np.fft.rfft(np.cos(2 * np.pi * f * 2 ** (cents / 1200) * t + 1.3 * k) * WIN)) ** 2)
            out[i, h] = acc / 5
    return out


def fit(V, device, iters=800):
    """The overtone recipe (power per harmonic, the first 1) and each pitch's power over time."""
    pitches = np.arange(LOW, HIGH + 1)
    ref = V.max()
    B = torch.tensor(basis(pitches), device=device) / ref
    Vt = torch.tensor((V / ref).T.astype(np.float32), device=device)
    scale = float(Vt.max() / B[:, 0].max())
    a_raw = torch.zeros(NHARM, device=device, requires_grad=True)
    h_raw = torch.full((len(pitches), V.shape[0]), -4.0, device=device, requires_grad=True)
    opt = torch.optim.Adam([{'params': [h_raw], 'lr': 0.08}, {'params': [a_raw], 'lr': 0.03}])
    for _ in range(iters):
        a = torch.exp(a_raw - a_raw[0])
        H = torch.nn.functional.softplus(h_raw)
        Vh = torch.einsum('h,phb->pb', a, B).T @ (H * scale)
        root = (H + 1e-6) ** 0.5
        # the spectra compared compressed (quiet partials count), few pitches at once, and steady from frame to frame
        loss = ((Vt + 1e-7) ** 0.3 - (Vh + 1e-7) ** 0.3).pow(2).mean() + 0.2 * root.mean() + 0.05 * (root[:, 1:] - root[:, :-1]).abs().mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
    return torch.exp(a_raw - a_raw[0]).detach().cpu().numpy(), (torch.nn.functional.softplus(h_raw) * scale).detach().cpu().numpy() * ref, pitches


def cut_notes(A):
    """(pitch index, first frame, end frame) of every note in the amplitudes A[pitch, frame]."""
    T = A.shape[1]
    As = median_filter(A, size=(1, 5))  # a chorused sound shimmers from frame to frame
    loud = np.percentile(As.max(0), 99)
    thr = np.maximum(As.max(0)[None, :] * REL, loud * GLOB)
    strong, weak = As > thr, As > thr / HYST
    notes = []
    for i in range(A.shape[0]):
        row = np.zeros(T, bool)
        t = 0
        while t < T:
            if not strong[i, t]:
                t += 1
                continue
            s = t
            while s > 0 and weak[i, s - 1] and not row[s - 1]:
                s -= 1
            e = t
            while e + 1 < T and weak[i, e + 1]:
                e += 1
            row[s:e + 1] = True
            t = e + 1
        on = np.flatnonzero(row)
        for x, y in zip(on[:-1], on[1:]):
            if 1 < y - x <= GAP:
                row[x:y] = True
        edges = np.flatnonzero(np.diff(np.concatenate([[0], row.astype(int), [0]])))
        for s, e in zip(edges[::2], edges[1::2]):
            # struck again: up 6 dB within 3 frames after falling 6 dB from its top
            cut, top = s, As[i, s]
            for t in range(s + 2, e - 2):
                top = max(top, As[i, t])
                if As[i, t] < top * 0.5 and As[i, t + 2] > As[i, t] * 2 and t - cut >= MINLEN:
                    notes.append((i, cut, t + 1))
                    cut, top = t + 1, As[i, t + 2]
            if e - cut >= MINLEN:
                notes.append((i, cut, e))
    return notes, As, loud


def kinds_of(notes, A, As):
    """Group the notes by envelope shape; each group's curve is the median of its notes', each against its top."""
    at = np.array([0, 1, 2, 4, 8, 16, 32, 64])  # frames after the start where shapes are compared
    def shape(i, s, e):
        seg = As[i, s:e] / (As[i, s:e].max() + 1e-12)
        return np.array([seg[k] if k < len(seg) else np.nan for k in at])
    F = np.array([shape(*n) for n in notes])
    k = min(KINDS, len(notes))
    rng = np.random.default_rng(0)
    cent = np.nan_to_num(F[rng.choice(len(F), k, replace=False)], nan=0.5)
    lab = np.zeros(len(F), int)
    for _ in range(30):
        lab = np.stack([np.nanmean((F - c) ** 2, 1) for c in cent], 1).argmin(1)
        for j in range(k):
            if (lab == j).any():
                cent[j] = np.nan_to_num(np.nanmean(F[lab == j], 0), nan=cent[j])
    longest = max(e - s for _, s, e in notes) + 1
    curves = []
    for j in range(k):
        idx = np.flatnonzero(lab == j)
        M = np.full((len(idx), longest), np.nan)
        for r, n in enumerate(idx):
            i, s, e = notes[n]
            M[r, :e - s] = A[i, s:e] / (A[i, s:e].max() + 1e-12)
        enough = np.flatnonzero((~np.isnan(M)).sum(0) >= max(3, len(idx) // 50))
        last = enough[-1] if len(enough) else 0
        med = np.nanmedian(M[:, :last + 1], 0) if len(idx) else np.ones(1)
        curves.append(np.concatenate([med, np.full(longest - len(med), med[-1])]))  # held where few notes last that long
    return lab, curves


def main():
    import librosa
    x, _ = librosa.load(sys.argv[1], sr=SR, mono=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    a, H, pitches = fit(spectrogram(x), device, 800 if device == 'cuda' else 300)
    A = np.sqrt(H)
    notes, As, loud = cut_notes(A)
    if len(notes) < 8:
        print('RESULT too few notes')
        json.dump({'notes': []}, open(sys.argv[2], 'w'))
        return
    lab, curves = kinds_of(notes, A, As)
    dt = HOP / SR
    frame_time = lambda f: (f * HOP + N / 2) / SR
    out = []
    for n, (i, s, e) in enumerate(notes):
        # a note sounds from one step before its first frame (the rise into it) to its last frame
        # ...and its own curve: its level frame by frame against its top, which is then its level
        top = float(A[i, s:e].max())
        out.append([int(pitches[i]), round(frame_time(s) - dt, 4), round(frame_time(e - 1) + dt / 2, 4), round(min(1.0, top / loud), 4), int(lab[n]), [round(float(v), 2) for v in A[i, s:e] / (top + 1e-12)]])
    out.sort(key=lambda n: (n[1], n[0]))
    json.dump({
        'step': dt,
        'harmonics': [round(float(v), 5) for v in np.sqrt(a)],
        'kinds': [{'envelope': [round(float(v), 4) for v in c[:int(8 / dt)]], 'notes': int((lab == j).sum())} for j, c in enumerate(curves)],
        'notes': out,
    }, open(sys.argv[2], 'w'))
    print('RESULT', len(out), 'notes,', len(curves), 'kinds')


if __name__ == '__main__':
    main()
