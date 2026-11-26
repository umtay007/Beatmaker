"""An MCP server that hosts VST3 plugins itself: load one, pick a preset, set its knobs, play notes through it and
render the result to a WAV, or run audio through an effect. No DAW involved (FL Studio's scripting can neither
load a plugin nor render, so a server built on it cannot either).

Run with a Python that has `mcp`, `pedalboard` and `numpy`:
    python pluginhost_mcp.py
and register it with an MCP client over stdio (see .mcp.json at the repository root).

Only what is installed and licensed on this computer loads: a plugin that needs its library or an activation
fails here as it would in any host. Plugins are loaded only from .vst3 files.
"""
import os
import sys

# Plugins print to the console when they load (u-he ones name their log file). The MCP conversation is on
# stdout, so the process's stdout goes to stderr and the server keeps the real one for itself.
_real = os.dup(1)
os.dup2(2, 1)
sys.stdout = os.fdopen(_real, 'w', encoding='utf-8', buffering=1)

import glob  # noqa: E402

import numpy as np  # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402
from pedalboard import load_plugin as _load  # noqa: E402
from pedalboard.io import AudioFile  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jstate  # noqa: E402

server = MCPServer('pluginhost', instructions='Hosts VST3 plugins: load_plugin first, then presets, parameters and rendering by the id it returns.')
PLUGINS = {}  # id -> plugin


def _get(plugin: str):
    if plugin not in PLUGINS:
        raise ValueError(f'No plugin loaded as "{plugin}" (loaded: {", ".join(PLUGINS) or "none"}). Call load_plugin first.')
    return PLUGINS[plugin]


def _midi(status, a, b=0):
    return bytes([status, int(a) & 0x7F, int(b) & 0x7F])


def _levels(audio):
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    rms = float(np.sqrt((audio ** 2).mean())) if audio.size else 0.0
    return {'peak_db': round(20 * np.log10(peak + 1e-12), 1), 'rms_db': round(20 * np.log10(rms + 1e-12), 1), 'silent': peak < 1e-4}


@server.tool()
def find_plugins(folder: str) -> list[str]:
    """The .vst3 plugins under a folder (paths only: nothing is loaded)."""
    found = glob.glob(os.path.join(folder, '**', '*.vst3'), recursive=True)
    # a .vst3 bundle is a folder holding the real file of the same name: list the bundle once
    return sorted(p for p in found if not any(p != q and p.startswith(q + os.sep) for q in found))


@server.tool()
def load_plugin(path: str, name: str = '') -> dict:
    """Load a VST3 plugin and keep it open. Returns the id to use with the other tools."""
    if not path.lower().endswith('.vst3'):
        raise ValueError('Only .vst3 plugins are loaded.')
    p = _load(path)
    pid = name or p.name
    PLUGINS[pid] = p
    return {'id': pid, 'name': p.name, 'instrument': bool(p.is_instrument), 'effect': bool(p.is_effect), 'parameters': len(p.parameters)}


@server.tool()
def unload_plugin(plugin: str) -> str:
    """Close a loaded plugin."""
    _get(plugin)
    del PLUGINS[plugin]
    return 'closed'


@server.tool()
def list_parameters(plugin: str, search: str = '', limit: int = 200) -> list[dict]:
    """A plugin's parameters with their current values (filter by part of a name: plugins can have thousands)."""
    out = []
    for key, prm in _get(plugin).parameters.items():
        if search.lower() in key.lower() or search.lower() in str(prm.name).lower():
            out.append({'key': key, 'name': str(prm.name), 'value': str(getattr(_get(plugin), key)), 'range': str(getattr(prm, 'range', ''))})
            if len(out) >= limit:
                break
    return out


@server.tool()
def set_parameters(plugin: str, values: dict) -> dict:
    """Set parameters by key (from list_parameters). Returns the values the plugin then reports."""
    p = _get(plugin)
    for key, v in values.items():
        if key not in p.parameters:
            raise ValueError(f'No parameter "{key}".')
        setattr(p, key, v)
    return {key: str(getattr(p, key)) for key in values}


@server.tool()
def find_presets(folder: str, search: str = '', limit: int = 300) -> list[str]:
    """Preset files under a folder: .vstpreset (any VST3) and .h2p (u-he synths such as Hive)."""
    found = [f for ext in ('vstpreset', 'h2p') for f in glob.glob(os.path.join(folder, '**', f'*.{ext}'), recursive=True)]
    return sorted(f for f in found if search.lower() in f.lower())[:limit]


@server.tool()
def load_preset(plugin: str, path: str) -> str:
    """Load a preset into a plugin: a .vstpreset, or a u-he .h2p (written straight into the plugin's state)."""
    p = _get(plugin)
    if path.lower().endswith('.h2p'):
        p.raw_state = jstate.with_component(p.raw_state, open(path, 'rb').read())
    elif path.lower().endswith('.vstpreset'):
        p.load_preset(path)
    else:
        raise ValueError('Presets are .vstpreset or .h2p files.')
    return 'loaded ' + os.path.basename(path)


@server.tool()
def open_editor(plugin: str) -> str:
    """Open the plugin's own window on this computer (to pick a sound by hand or sign in). Returns when it is closed."""
    _get(plugin).show_editor()
    return 'window closed'


@server.tool()
def save_state(plugin: str, file: str) -> str:
    """Save everything about the plugin's current sound to a file (load_state brings it back exactly)."""
    with open(file, 'wb') as f:
        f.write(_get(plugin).raw_state)
    return file


@server.tool()
def load_state(plugin: str, file: str) -> str:
    """Restore a sound saved with save_state."""
    _get(plugin).raw_state = open(file, 'rb').read()
    return 'restored'


@server.tool()
def render_notes(plugin: str, notes: list[list[float]], out_wav: str, tail: float = 2.0, sample_rate: int = 44100) -> dict:
    """Play notes through an instrument and write the audio to a WAV. Each note is [pitch (MIDI), start s, end s,
    velocity 0..1]. `tail` seconds are kept after the last note ends."""
    p = _get(plugin)
    if not p.is_instrument:
        raise ValueError(f'{plugin} is an effect: use process_audio.')
    ev = []
    for pitch, start, end, *rest in notes:
        vel = max(1, min(127, round(127 * (rest[0] if rest else 0.8))))
        ev.append((_midi(0x90, pitch, vel), max(0.0, start)))
        ev.append((_midi(0x80, pitch), max(start + 0.01, end)))
    ev.sort(key=lambda e: e[1])
    duration = (max(e[1] for e in ev) if ev else 0) + tail
    audio = p(ev, duration=duration, sample_rate=sample_rate, num_channels=2, buffer_size=1024, reset=True)
    with AudioFile(out_wav, 'w', sample_rate, audio.shape[0]) as f:
        f.write(audio)
    return {'file': out_wav, 'seconds': round(duration, 2), **_levels(audio)}


@server.tool()
def process_audio(plugin: str, in_file: str, out_wav: str) -> dict:
    """Run an audio file through an effect and write the result to a WAV."""
    p = _get(plugin)
    with AudioFile(in_file) as f:
        audio, sr = f.read(f.frames), f.samplerate
    out = p(audio, sr, reset=True)
    with AudioFile(out_wav, 'w', sr, out.shape[0]) as f:
        f.write(out)
    return {'file': out_wav, 'seconds': round(out.shape[1] / sr, 2), **_levels(out), 'changed': bool(out.shape != audio.shape or float(np.abs(out - audio).max()) > 1e-5)}


if __name__ == '__main__':
    server.run('stdio')
