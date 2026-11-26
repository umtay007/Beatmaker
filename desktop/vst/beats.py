"""Beats and downbeats of a song with Beat This! (CPJKU, MIT code): python beats.py song.wav out.json

Runs in the --sep folder's Python (torch with CUDA). Writes {"beats": [seconds...], "downbeats": [seconds...]}.
"""
import json
import sys

import torch
from beat_this.inference import File2Beats

f2b = File2Beats(checkpoint_path='final0', device='cuda' if torch.cuda.is_available() else 'cpu', dbn=False)
beats, downbeats = f2b(sys.argv[1])
with open(sys.argv[2], 'w') as f:
    json.dump({'beats': [round(float(b), 4) for b in beats], 'downbeats': [round(float(b), 4) for b in downbeats]}, f)
print('RESULT', len(beats), len(downbeats))
