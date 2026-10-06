"""
Plays the remake's notes through a sound from your own VST3 instruments.

  python host.py pick <role> <plugin.vst3> <sounds-dir> [--no-window]
      Open the plugin's window, choose a sound, close it: the sound is then played at every pitch
      (and a few strengths) and saved as a set of samples in <sounds-dir>/<role>/. (Plugins don't
      remember a sound chosen in their window, so it is captured as audio right away.)
  python host.py render <job.json>
      Play a part's notes with its saved samples (numpy only) and write <out>/<role>.wav
      (44.1 kHz stereo from song time 0).

Needs `pip install pedalboard numpy` (pedalboard only for `pick`).
"""
import json
import os
import sys
import wave

import numpy as np

SR = 44100
# Pitched sounds: every third semitone at three strengths. Drum kits: every key at two.
PITCHED = {"pitches": list(range(36, 97, 3)), "vels": [105, 75, 45], "hold": 3.0, "length": 5.0}
DRUMS = {"pitches": list(range(24, 85)), "vels": [105, 55], "hold": 0.4, "length": 2.5}


def midi(status, a, b=0):
    return bytes([status, a & 0x7F, b & 0x7F])


def read_wav(path):
    with wave.open(path, "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        return data.reshape(-1, w.getnchannels()).T


def write_wav(path, audio):
    pcm = (np.clip(audio, -1, 1).T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------------------------
# pick: choose a sound, then capture it


def bake(role, plugin, out_dir):
    spec = DRUMS if role == "drums" else PITCHED
    os.makedirs(out_dir, exist_ok=True)
    layers = []
    total = len(spec["pitches"]) * len(spec["vels"])
    done = 0
    for pitch in spec["pitches"]:
        for vel in spec["vels"]:
            ev = [
                (midi(0xB0, 120, 0), 0.0),  # all sound off
                (midi(0x90, pitch, vel), 0.05),
                (midi(0x80, pitch, 0), 0.05 + spec["hold"]),
            ]
            # A quiet stretch first so the last note's tail can't leak into this one.
            plugin([(midi(0xB0, 123, 0), 0.0)], duration=0.4, sample_rate=SR, num_channels=2, buffer_size=512, reset=False)
            a = plugin(ev, duration=spec["length"], sample_rate=SR, num_channels=2, buffer_size=512, reset=False)
            # Trim the silence at the end and fade out the last moments.
            loud = np.where(np.abs(a).max(0) > 3e-4)[0]
            if not len(loud):
                done += 1
                continue
            a = a[:, : loud[-1] + 1]
            fade = min(a.shape[1], int(0.05 * SR))
            a[:, -fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
            name = f"n{pitch}_v{vel}.wav"
            write_wav(os.path.join(out_dir, name), a)
            layers.append({"pitch": pitch, "vel": vel, "file": name})
            done += 1
        print(f"Capturing the {role}: {done} of {total}", flush=True)
    with open(os.path.join(out_dir, "sound.json"), "w") as f:
        json.dump({"role": role, "kind": "drums" if role == "drums" else "pitched", "layers": layers}, f)
    return len(layers)


def pick(role, plugin_path, sounds_dir, window=True):
    from pedalboard import load_plugin

    plugin = load_plugin(plugin_path)
    if window:
        print(f"Opening {plugin.name}: choose a sound for the {role}, then close the window.", flush=True)
        plugin.show_editor()  # returns when the window is closed
    out = os.path.join(sounds_dir, role)
    n = bake(role, plugin, out)
    if not n:
        sys.exit(f"{plugin.name} played nothing: choose a sound that plays when a key is pressed.")
    cfg_path = os.path.join(sounds_dir, "sounds.json")
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    cfg[role] = {"plugin": os.path.abspath(plugin_path), "name": plugin.name, "dir": role}
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Saved the {role} sound ({plugin.name}, {n} samples).", flush=True)


# ---------------------------------------------------------------------------------------------
# render: play notes with the captured samples


class Sound:
    def __init__(self, folder):
        meta = json.load(open(os.path.join(folder, "sound.json")))
        self.drums = meta["kind"] == "drums"
        self.layers = [dict(l, audio=read_wav(os.path.join(folder, l["file"]))) for l in meta["layers"]]
        self.pitches = sorted({l["pitch"] for l in self.layers})

    def layer(self, pitch, vel):
        near = min(self.pitches, key=lambda p: abs(p - pitch))
        cands = [l for l in self.layers if l["pitch"] == near]
        return min(cands, key=lambda l: abs(l["vel"] - vel))


def shifted(audio, ratio):
    if abs(ratio - 1) < 1e-4:
        return audio
    n = int((audio.shape[1] - 1) / ratio)
    x = np.arange(n) * ratio
    i = x.astype(np.int64)
    f = (x - i).astype(np.float32)
    return audio[:, i] * (1 - f) + audio[:, np.minimum(i + 1, audio.shape[1] - 1)] * f


def render(job_path):
    job = json.load(open(job_path))
    out = job["outDir"]
    total = int(job["duration"] * SR)
    results = {}
    for part in job["parts"]:
        role = part["role"]
        sound = Sound(part["soundDir"])
        print(f"Playing the {role} with its captured sound…", flush=True)
        mix = np.zeros((2, total + SR * 6), dtype=np.float32)
        for n in part["notes"]:
            vel = max(1, min(127, round(n["v"] * 127)))
            layer = sound.layer(n["p"], vel)
            audio = shifted(layer["audio"], 2 ** ((n["p"] - layer["pitch"]) / 12))
            # Louder or softer than the layer it came from, in proportion to the strength.
            audio = audio * (vel / layer["vel"]) if vel != layer["vel"] else audio
            start = int(n["s"] * SR)
            if not sound.drums:
                # Key released: a short release instead of the natural tail.
                held = int(max(0.05, n["e"] - n["s"]) * SR)
                if held < audio.shape[1]:
                    rel = min(int(0.25 * SR), audio.shape[1] - held)
                    audio = audio[:, : held + rel].copy()
                    audio[:, held:] *= np.linspace(1, 0, rel, dtype=np.float32)
            if start >= total:
                continue
            end = min(mix.shape[1], start + audio.shape[1])
            mix[:, start:end] += audio[:, : end - start]
        mix = mix[:, :total]
        write_wav(os.path.join(out, f"{role}.wav"), mix)
        results[role] = {"peak": float(np.abs(mix).max())}
    print("RESULT " + json.dumps(results), flush=True)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "pick":
        pick(sys.argv[2], sys.argv[3], sys.argv[4], window="--no-window" not in sys.argv)
    elif mode == "render":
        render(sys.argv[2])
    else:
        sys.exit(f"Unknown mode {mode}")
