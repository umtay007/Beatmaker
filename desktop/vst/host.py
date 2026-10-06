"""
Plays the remake's notes through your own VST3 instruments.

  python host.py pick <role> <plugin.vst3> <sounds-dir>   open the plugin, choose a sound, close it
  python host.py render <job.json>                         render the notes of each part to a WAV

`pick` saves the plugin's state (the sound you chose) in <sounds-dir>/<role>.state and notes it in
sounds.json; `render` plays a part's notes through that state, offline, and writes <out>/<role>.wav
(44.1 kHz stereo, starting at song time 0). Needs `pip install pedalboard numpy`.
"""
import json
import os
import struct
import sys
import wave

import numpy as np
from pedalboard import load_plugin

SR = 44100


def midi(status, a, b=0):
    return bytes([status, a & 0x7F, b & 0x7F])


def events(notes, channel, shift):
    ev = []
    for n in notes:
        pitch = int(n["p"]) + shift
        if not 0 <= pitch <= 127:
            continue
        vel = int(max(1, min(127, round(n["v"] * 127))))
        ev.append((midi(0x90 | channel, pitch, vel), float(n["s"])))
        ev.append((midi(0x80 | channel, pitch, 0), float(n["e"])))
    # Offs before ons at the same instant, so a repeated note retriggers.
    ev.sort(key=lambda e: (e[1], e[0][0] & 0xF0))
    return ev


def write_wav(path, audio):
    pcm = (np.clip(audio, -1, 1).T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def pick(role, plugin_path, sounds_dir):
    os.makedirs(sounds_dir, exist_ok=True)
    plugin = load_plugin(plugin_path)
    print(f"Opening {plugin.name}: choose a sound for the {role}, then close the window.", flush=True)
    plugin.show_editor()  # returns when the window is closed
    state = f"{role}.state"
    with open(os.path.join(sounds_dir, state), "wb") as f:
        f.write(bytes(plugin.raw_state))
    cfg_path = os.path.join(sounds_dir, "sounds.json")
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    cfg[role] = {"plugin": os.path.abspath(plugin_path), "state": state, "name": plugin.name}
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Saved the {role} sound ({plugin.name}).", flush=True)


def render(job_path):
    job = json.load(open(job_path))
    out = job["outDir"]
    results = {}
    loaded = {}
    for part in job["parts"]:
        role = part["role"]
        key = (part["plugin"], part["state"])
        if key not in loaded:
            plugin = load_plugin(part["plugin"])
            plugin.raw_state = open(part["state"], "rb").read()
            loaded[key] = plugin
        plugin = loaded[key]
        print(f"Playing the {role} through {plugin.name}…", flush=True)
        ev = events(part["notes"], part.get("channel", 0), part.get("shift", 0))
        # One quiet render first: plugins that load their sound in the background are silent at first.
        plugin([], duration=0.5, sample_rate=SR, num_channels=2, buffer_size=512, reset=False)
        audio = plugin(ev, duration=float(job["duration"]), sample_rate=SR, num_channels=2, buffer_size=512, reset=False)
        peak = float(np.abs(audio).max())
        write_wav(os.path.join(out, f"{role}.wav"), audio)
        results[role] = {"peak": peak, "plugin": plugin.name}
    print("RESULT " + json.dumps(results), flush=True)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "pick":
        pick(sys.argv[2], sys.argv[3], sys.argv[4])
    elif mode == "render":
        render(sys.argv[2])
    else:
        sys.exit(f"Unknown mode {mode}")
