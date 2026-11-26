"""Package four stems as a Stem2 local track (Beatmaker). Writes files into a folder; it never touches a device.

  python stem2_pack.py job.json

job.json: {"stems": {"other": wav, "vocals": wav, "bass": wav, "drums": wav}, "out": folder, "title", "artist",
           "bpm", "bars": [seconds...], "key": "A", "tonality": "minor"|"major", "sections": [[start, end], ...],
           "colours": ["#RRGGBB", "#RRGGBB"], "trackId": optional}
Writes <out>/<track-id>/meta.dat and combi.mp4, plus package.json with the checks.

Format, as observed in a track the device plays and confirmed field by field against Stem's own inspector:
combi.mp4 is not an MP4: per 1024-sample period, four AAC-LC ADTS frames (other, vocals, bass, drums; 48 kHz stereo,
each 8-640 bytes), then zero padding to a 32768-byte boundary, a uint16 table of the combined frame lengths, and a
16-byte footer "STEM" + audio bytes + sample rate + frame count. meta.dat is a 44-byte header, strings, and a sync block
(tempo, bar times, sections). Segment "type" values (1, 2 seen) are not understood; 1 is written for every section.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import uuid

ORDER = ['other', 'vocals', 'bass', 'drums']
SR = 48000
MAX_FRAME = 640
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLATS = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}


def adts_frames(data):
    out, pos = [], 0
    while pos + 7 <= len(data):
        h = data[pos:pos + 7]
        if h[0] != 0xFF or (h[1] & 0xF0) != 0xF0:
            raise ValueError(f'lost ADTS sync at byte {pos}')
        n = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5)
        out.append(data[pos:pos + n])
        pos += n
    return out


def encode(wav, seconds, kbps, tmp):
    """One stem as AAC-LC ADTS frames, 48 kHz stereo, padded or cut to exactly `seconds`."""
    out = os.path.join(tmp, 'stem.aac')
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af', f'apad=whole_dur={seconds:.6f}', '-t', f'{seconds:.6f}',
           '-ar', str(SR), '-ac', '2', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', f'{kbps}k', '-f', 'adts', out]
    subprocess.run(cmd, check=True)
    with open(out, 'rb') as f:
        return adts_frames(f.read())


def duration_of(wav):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def build_combi(stems, seconds):
    streams = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in ORDER:
            for kbps in (96, 80, 64, 48):  # a frame over 640 bytes is not allowed: step the bitrate down until none is
                frames = encode(stems[name], seconds, kbps, tmp)
                if max(len(f) for f in frames) <= MAX_FRAME:
                    break
            else:
                raise ValueError(f'{name}: AAC frames stay over {MAX_FRAME} bytes even at 48 kbps')
            streams[name] = (frames, kbps)
    n = min(len(streams[s][0]) for s in ORDER)
    audio = bytearray()
    sizes = []
    for i in range(n):
        start = len(audio)
        for s in ORDER:
            audio += streams[s][0][i]
        sizes.append(len(audio) - start)
    total = len(audio)
    audio += b'\0' * ((-total) % 32768)
    audio += struct.pack(f'<{n}H', *sizes)
    audio += b'STEM' + struct.pack('<III', total, SR, n)
    return bytes(audio), {s: streams[s][1] for s in ORDER}, n


def colour(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return bytes([b, g, r, 0])


def build_meta(track_id, title, artist, seconds, colours, key, tonality, bpm, bars, sections):
    u = uuid.UUID(track_id).bytes
    t = title.encode('utf-8')[:100]
    a = artist.encode('utf-8')[:100]
    note = FLATS.get(key, key)
    keybyte = ({'minor': 0x40, 'major': 0x80}[tonality] | (NOTES.index(note) + 1)) if note in NOTES and tonality in ('minor', 'major') else 0
    strings = t + b'\0' + a + b'\0' + b'\0'  # title, artist, empty url
    strings_end = 44 + len(t) + 1 + len(a) + 1
    sync_at = (44 + len(strings) + 3) // 4 * 4
    head = struct.pack('<I', struct.unpack('>I', u[:4])[0]) + u[4:]
    head += bytes([len(t), len(a), strings_end & 0xFF, (3 << 3) | 6])  # version 3, combined-stem AAC
    head += struct.pack('<f', seconds) + colour(colours[0]) + colour(colours[1])
    head += bytes([keybyte, 0]) + struct.pack('<H', sync_at) + struct.pack('<HHHH', 0, 0, 0, 0)
    assert len(head) == 44
    body = head + strings
    body += b'\0' * (sync_at - len(body))
    body += bytes([13, keybyte]) + struct.pack('<HHH', int(round(bpm)), len(bars), len(sections))
    body += struct.pack(f'<{len(bars)}f', *bars)
    for start, end in sections:
        body += struct.pack('<ffI', start, end, 1)
    return body


def check(combi, meta, track_id, title):
    magic, audio_bytes, sr, frames = struct.unpack_from('<4sIII', combi, len(combi) - 16)
    assert magic == b'STEM' and sr == SR and frames >= 50, 'footer'
    table = (audio_bytes + 32767) // 32768 * 32768
    assert len(combi) == table + 2 * frames + 16, 'file length'
    sizes = struct.unpack_from(f'<{frames}H', combi, table)
    assert sum(sizes) == audio_bytes, 'seek table'
    pos, peak = 0, [0, 0, 0, 0]
    for expected in sizes:
        start = pos
        for ch in range(4):
            h = combi[pos:pos + 7]
            assert h[0] == 0xFF and h[1] >> 4 == 0xF and (h[2] >> 6) == 1 and ((h[2] >> 2) & 15) == 3, f'ADTS header at {pos}'
            assert (((h[2] & 1) << 2) | (h[3] >> 6)) == 2, 'stereo'
            n = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5)
            assert 8 <= n <= MAX_FRAME, f'frame of {n} bytes'
            peak[ch] = max(peak[ch], n)
            pos += n
        assert pos - start == expected, 'combined frame length'
    assert pos == audio_bytes
    assert meta[19] >> 3 == 3 and meta[44:44 + meta[16]].decode() == title[:100]
    first = struct.unpack_from('<I', meta)[0]
    assert str(uuid.UUID(bytes=struct.pack('>I', first) + meta[4:16])) == track_id
    return {'frames': frames, 'audio_bytes': audio_bytes, 'max_frame_bytes': dict(zip(ORDER, peak)), 'seconds': round(frames * 1024 / SR, 3)}


def main():
    with open(sys.argv[1], encoding='utf-8') as f:
        job = json.load(f)
    stems = job['stems']
    seconds = max(duration_of(stems[s]) for s in ORDER)
    # a local track id: random, with the 0d first byte local content carries
    track_id = job.get('trackId') or str(uuid.UUID('0d' + uuid.uuid4().hex[2:]))
    combi, kbps, frames = build_combi(stems, seconds)
    seconds = frames * 1024 / SR
    bars = [b for b in job['bars'] if 0 <= b < seconds]
    sections = [[max(0.0, s), min(seconds, e)] for s, e in job.get('sections') or [[0.0, seconds]] if s < seconds]
    meta = build_meta(track_id, job['title'], job.get('artist', ''), seconds, job.get('colours') or ['#25D366', '#8355FF'],
                      job.get('key', ''), job.get('tonality', ''), job['bpm'], bars, sections)
    info = check(combi, meta, track_id, job['title'])
    out = os.path.join(job['out'], track_id)
    os.makedirs(out, exist_ok=False)  # never write over an existing package
    with open(os.path.join(out, 'combi.mp4'), 'wb') as f:
        f.write(combi)
    with open(os.path.join(out, 'meta.dat'), 'wb') as f:
        f.write(meta)
    info.update({'trackId': track_id, 'folder': out, 'bitrates_kbps': kbps, 'bars': len(bars), 'sections': len(sections),
                 'device_folder': f'_tra_local/{uuid.UUID(track_id).bytes[4]:02x}/{track_id}', 'hardware_verified': False})
    with open(os.path.join(out, 'package.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, indent=2)
    print('RESULT ' + json.dumps(info))


if __name__ == '__main__':
    main()
