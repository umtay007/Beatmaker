"""
'Ears': how alike recordings sound to music-listening models (CLAP embeddings; no PyTorch hearing is
perfect, but two different models agreeing is the closest thing to a listener a program has).

  python ears.py <ymt3 folder> <job.json>

job.json: { "ref": ["a.wav", ...], "cands": [["c0_a.wav", ...], ...] }  (each wav up to 10 s; a candidate
has one wav per reference wav). Prints RESULT {"general": [...], "music": [...]}: per candidate, the mean
cosine similarity to the reference wavs under each model. Models are cached in <ymt3 folder>/hf.
"""
import json, os, sys
HERE = sys.argv[1]
os.environ['HF_HOME'] = os.path.join(HERE, 'hf')
import numpy as np, soundfile as sf, torch
from scipy.signal import resample_poly
from transformers import ClapModel, ClapProcessor
SR = 48000
MODELS = {'general': 'laion/clap-htsat-unfused', 'music': 'laion/larger_clap_music'}

def load(path):
    x, sr = sf.read(path, dtype='float32', always_2d=True); x = x.mean(1)
    if sr != SR:
        from math import gcd; g = gcd(SR, sr); x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x[: 10 * SR]

@torch.no_grad()
def embed(proc, model, wavs):
    out = []
    for i in range(0, len(wavs), 8):
        inp = proc(audios=wavs[i:i + 8], sampling_rate=SR, return_tensors='pt'); inp = {k: v.to(model.device) for k, v in inp.items()}
        out.append(torch.nn.functional.normalize(model.get_audio_features(**inp), dim=-1).cpu().numpy())
    return np.concatenate(out)

job = json.load(open(sys.argv[2])); dev = 'cuda' if torch.cuda.is_available() else 'cpu'
ref = [load(p) for p in job['ref']]; cands = [[load(p) for p in c] for c in job['cands']]
res = {}
for key, name in MODELS.items():
    proc = ClapProcessor.from_pretrained(name); model = ClapModel.from_pretrained(name).to(dev).eval()
    r = embed(proc, model, ref); flat = [w for c in cands for w in c]; e = embed(proc, model, flat)
    k = len(ref); res[key] = [float(np.mean(np.sum(r * e[i * k:(i + 1) * k], axis=1))) for i in range(len(cands))]
    del model; torch.cuda.empty_cache()
print('RESULT ' + json.dumps(res), flush=True)
