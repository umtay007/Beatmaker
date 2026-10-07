"""YourMT3+ (github.com/mimbres/YourMT3, Space mimbres/YourMT3) on a stretch of a wav, as notes in a JSON list.

  python ymt3.py <ymt3 folder> in.wav start_s dur_s bsz out.json

<ymt3 folder> has code/ (the Space, with its YPTF.MoE+Multi (noPS) checkpoint) and venv/ (torch, lightning,
transformers==4.45.1, numpy==1.26.4, librosa, einops, mido). Notes: {p, s, e, v, prog}; prog is the GM program.
"""
import sys, os, json, time
HERE = sys.argv[1]; CODE = os.path.join(HERE, 'code')
sys.path.insert(0, os.path.join(CODE, 'amt', 'src')); sys.path.insert(0, CODE); os.chdir(CODE)
import torch, torchaudio, mido, numpy as np
from collections import Counter
from model_helper import load_model_checkpoint
from utils.audio import slice_padded_array
from utils.note2event import mix_notes
from utils.event2note import merge_zipped_note_events_and_ties_to_notes
from utils.utils import write_model_output_as_midi
src, start, dur, bsz, out_json = sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
ckpt = "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt"
args = [ckpt, '-p', '2024', '-tk', 'mc13_full_plus_256', '-dec', 'multi-t5', '-nl', '26', '-enc', 'perceiver-tf', '-sqr', '1', '-ff', 'moe', '-wf', '4', '-nmoe', '8', '-kmoe', '2', '-act', 'silu', '-epe', 'rope', '-rp', '1', '-ac', 'spec', '-hop', '300', '-atc', '1', '-pr', '16']
model = load_model_checkpoint(args=args, device='cpu'); dev = 'cuda' if torch.cuda.is_available() else 'cpu'; model.to(dev)
audio, sr = torchaudio.load(src); audio = audio.mean(0, keepdim=True)
audio = torchaudio.functional.resample(audio, sr, model.audio_cfg['sample_rate'])
a0 = int(start * model.audio_cfg['sample_rate']); audio = audio[:, a0: a0 + int(dur * model.audio_cfg['sample_rate'])]
segs = slice_padded_array(audio, model.audio_cfg['input_frames'], model.audio_cfg['input_frames'])
segs = torch.from_numpy(segs.astype('float32')).to(dev).unsqueeze(1)
print('segments', segs.shape[0], 'segment length %.2fs' % (model.audio_cfg['input_frames'] / model.audio_cfg['sample_rate']), 'bsz', bsz, 'device', dev, flush=True)
pred = []
for i in range(0, segs.shape[0], bsz):
    t = time.time(); p, _ = model.inference_file(bsz=bsz, audio_segments=segs[i:i + bsz]); pred += p
    print('batch %d-%d  %.1fs  (%.1f GB gpu)' % (i, min(i + bsz, segs.shape[0]), time.time() - t, torch.cuda.max_memory_allocated() / 1e9 if dev == 'cuda' else 0), flush=True)
nch = model.task_manager.num_decoding_channels; starts = [start + model.audio_cfg['input_frames'] * i / model.audio_cfg['sample_rate'] for i in range(segs.shape[0])]
chans = []
for ch in range(nch):
    arr = [a[:, ch, :] for a in pred]
    z, _, _ = model.task_manager.detokenize_list_batches(arr, starts, return_events=True)
    notes_ch, _ = merge_zipped_note_events_and_ties_to_notes(z); chans.append(notes_ch)
notes = mix_notes(chans)
os.makedirs('./model_output', exist_ok=True)
write_model_output_as_midi(notes, './', 'tmp_' + os.path.basename(out_json).replace('.json', ''), model.midi_output_inverse_vocab)
mid = mido.MidiFile('./model_output/tmp_' + os.path.basename(out_json).replace('.json', '') + '.mid')
res = []; open_ = {}; prog = {}; now = 0.0
for msg in mid:
    now += msg.time
    if msg.type == 'program_change': prog[msg.channel] = msg.program
    elif msg.type == 'note_on' and msg.velocity > 0: open_[(msg.channel, msg.note)] = (now, msg.velocity)
    elif msg.type in ('note_off', 'note_on') and (msg.channel, msg.note) in open_:
        s, v = open_.pop((msg.channel, msg.note)); res.append(dict(p=msg.note, s=round(s, 4), e=round(now, 4), v=round(v / 127, 3), prog=prog.get(msg.channel, -1), ch=msg.channel))
res.sort(key=lambda n: (n['s'], n['p'])); json.dump(res, open(out_json, 'w'))
print('notes', len(res), Counter(n['prog'] for n in res).most_common(6), flush=True)
