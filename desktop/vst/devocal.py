"""Take the voice out of a song first (Beatmaker, `--sep <folder>`): BS-Roformer through audio-separator.

  python devocal.py <sep folder> song.wav out_dir

<sep folder> has venv/ (torch with CUDA, audio-separator) and models/ (the model downloads there on first use).
Writes out_dir/instrumental.wav and out_dir/vocals.wav. The instrumental then goes to the Demucs split into
drums, bass and melody: with no voice left in it there is none to leak into those stems.
"""
import glob
import os
import shutil
import sys

root, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
from audio_separator.separator import Separator  # noqa: E402

os.makedirs(out, exist_ok=True)
sep = Separator(output_dir=out, model_file_dir=os.path.join(root, 'models'), output_format='WAV', log_level=30)
sep.load_model('model_bs_roformer_ep_317_sdr_12.9755.ckpt')
sep.separate(src)
for key, name in (('(Instrumental)', 'instrumental.wav'), ('(Vocals)', 'vocals.wav')):
    found = [f for f in glob.glob(os.path.join(out, '*.wav')) if key in os.path.basename(f)]
    if not found:
        sys.exit(f'no {key} output in {out}')
    shutil.move(found[0], os.path.join(out, name))
print('RESULT ok')
