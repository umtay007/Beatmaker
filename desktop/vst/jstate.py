"""The state a JUCE host keeps for a VST3 plugin (what pedalboard's raw_state holds): "VC2!", a length, then XML
whose IComponent is the plugin's own state in JUCE's base64. For u-he synths (Hive, Bazille) that state is the
text of a preset file (.h2p), so writing a preset's text in loads the preset without the plugin's window."""
import re, struct
ALPHA = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
def b64dec(s):
    size, chars = s.split('.', 1); size = int(size); out = bytearray(size)
    for i, c in enumerate(chars):
        v = ALPHA.index(c); pos = i * 6
        for b in range(6):
            if v >> b & 1 and (pos + b) >> 3 < size: out[(pos + b) >> 3] |= 1 << ((pos + b) & 7)
    return bytes(out)
def b64enc(data):
    n = (len(data) * 8 + 5) // 6; chars = []
    for i in range(n):
        v = 0; pos = i * 6
        for b in range(6):
            if (pos + b) >> 3 < len(data) and data[(pos + b) >> 3] >> ((pos + b) & 7) & 1: v |= 1 << b
        chars.append(ALPHA[v])
    return f"{len(data)}." + ''.join(chars)
def component(raw):
    m = re.search(rb'<IComponent>(.*?)</IComponent>', raw, re.S); return b64dec(m.group(1).decode())
def with_component(raw, comp):
    xml = re.sub(rb'<IComponent>.*?</IComponent>', b'<IComponent>' + b64enc(comp).encode() + b'</IComponent>', raw[8:], flags=re.S)
    return raw[:4] + struct.pack('<I', len(xml) - (1 if xml.endswith(bytes([0])) else 0)) + xml
