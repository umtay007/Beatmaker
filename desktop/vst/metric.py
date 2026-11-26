"""The app's match score (src/audio/compare.ts, scoreAudio) in numpy: two mono recordings at 22050 Hz, lined up."""
import numpy as np
SR, N, HOP, F_LO, PER_OCT, NB = 22050, 2048, 512, 40.0, 24, 192
WIN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / (N - 1))
PARTS = {'drums': (40, 10000, False, (0.45, 0, 0.25, 0.3)), 'bass': (40, 500, True, (0.2, 0.35, 0.2, 0.25)), 'other': (150, 6000, True, (0.1, 0.45, 0.2, 0.25))}
_f = F_LO * 2 ** (np.arange(NB) / PER_OCT) * N / SR; _k = np.floor(_f).astype(int); _w = _f - _k
PC = (np.round(69 + 12 * np.log2(F_LO * 2 ** (np.arange(NB) / PER_OCT) / 440)).astype(int) % 12 + 12) % 12
def spec_db(x):
    n = 1 + (len(x) - N) // HOP
    out = np.empty((n, NB), np.float32)
    for a in range(0, n, 2000):
        idx = np.arange(N)[None, :] + HOP * np.arange(a, min(n, a + 2000))[:, None]
        p = np.abs(np.fft.rfft(x[idx].astype(np.float64) * WIN, axis=1)) ** 2
        lo, hi = p[:, _k], p[:, np.minimum(_k + 1, N // 2)]
        out[a:a + len(idx)] = 10 * np.log10(np.maximum(lo, hi) * 0.5 + (lo * (1 - _w) + hi * _w) * 0.5 + 1e-12)
    out = np.maximum(out, out.max() - 60)
    return out
def band_at(f): return int(max(0, min(NB - 1, round(PER_OCT * np.log2(f / F_LO)))))
def features(db, lo, hi):
    b0, b1 = band_at(lo), band_at(hi); pw = 10 ** (db.astype(np.float64) / 10)
    e = 10 * np.log10(pw.sum(1) + 1e-12)
    chroma = np.zeros((len(db), 12))
    for pc in range(12): chroma[:, pc] = pw[:, b0:b1 + 1][:, PC[b0:b1 + 1] == pc].sum(1)
    flux = np.zeros(len(db)); flux[1:] = np.maximum(0, np.diff(db[:, b0:b1 + 1].astype(np.float64), axis=0)).sum(1)
    peak = e.max(); n = len(db); W = 43
    pre = np.concatenate([[0], np.cumsum(flux)]); a = np.maximum(0, np.arange(n) - W); z = np.minimum(n - 1, np.arange(n) + W)
    mean = (pre[z + 1] - pre[a]) / (z - a + 1)
    pad = np.concatenate([[-1, -1], flux, [-1, -1]])
    top = (flux > pad[0:n]) & (flux > pad[1:n + 1]) & (flux >= pad[3:n + 3]) & (flux >= pad[4:n + 4])
    onsets = np.flatnonzero(top & (flux > 1.6 * mean + 8) & (e > peak - 40))
    return e, peak, chroma, onsets
def score(part, stem, render, detail=False):
    lo, hi, pitched, w = PARTS[part]
    S, R = spec_db(stem), spec_db(render); n = min(len(S), len(R)); S, R = S[:n], R[:n]
    es, ps, cs, os_ = features(S, lo, hi); er, pr, cr, or_ = features(R, lo, hi)
    b0, b1 = band_at(lo), band_at(hi)
    loud = es >= ps - 35
    off = (S[loud] - R[loud]).mean(0) if loud.any() else np.zeros(NB)
    used = set(); hit = 0
    for x in os_:
        best = -1
        for y in or_[(or_ >= x - 3) & (or_ <= x + 3)]:
            if y not in used and (best < 0 or abs(y - x) < abs(best - x)): best = y
        if best >= 0: used.add(best); hit += 1
    hits = min(100, 200 * hit / (len(os_) + len(or_))) if len(os_) + len(or_) else None
    pitch = None
    if pitched:
        m = loud & (er >= pr - 45); a, b = cs[m], cr[m]
        den = np.sqrt((a * a).sum(1) * (b * b).sum(1)); ok = den > 0
        if ok.sum() >= 4: pitch = float(np.clip((((a * b).sum(1)[ok] / den[ok]).mean() - 0.6) / 0.4 * 100, 0, 100))
    x, y = np.maximum(es, ps - 50), np.maximum(er, pr - 50); x = x - x.mean(); y = y - y.mean()
    loudness = float(np.clip((x * y).sum() / np.sqrt((x * x).sum() * (y * y).sum()) * 100, 0, 100)) if (x * x).sum() > 1e-9 and (y * y).sum() > 1e-9 else None
    d = np.minimum(25, np.abs(S[loud][:, b0:b1 + 1] - R[loud][:, b0:b1 + 1] - off[b0:b1 + 1]))
    tone = float(np.clip(100 * (1 - d.mean() / 12), 0, 100)) if d.size >= 50 else None
    vals = [hits, pitch, loudness, tone]; k = sum(wi for v, wi in zip(vals, w) if v is not None and wi)
    total = sum(v * wi for v, wi in zip(vals, w) if v is not None and wi) / k if k else 0
    return (total, hits, pitch, loudness, tone) if detail else total
if __name__ == '__main__':
    import sys
    stem = np.fromfile(sys.argv[2], dtype=np.float32)
    for f in sys.argv[3:]: print(f, [None if v is None else round(v, 1) for v in score(sys.argv[1], stem, np.fromfile(f, dtype=np.float32), True)])
