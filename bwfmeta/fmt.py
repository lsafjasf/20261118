"""fmt chunk parsing, incl. WAVE_FORMAT_EXTENSIBLE."""
from __future__ import annotations

import struct
from dataclasses import dataclass

from .riff import Chunk

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE

PCM_GUID_TAIL = bytes.fromhex("00001000800000aa00389b71")

SPEAKER_BITS = {
    0: "FRONT_LEFT", 1: "FRONT_RIGHT", 2: "FRONT_CENTER", 3: "LOW_FREQUENCY",
    4: "BACK_LEFT", 5: "BACK_RIGHT", 6: "FRONT_LEFT_OF_CENTER",
    7: "FRONT_RIGHT_OF_CENTER", 8: "BACK_CENTER", 9: "SIDE_LEFT",
    10: "SIDE_RIGHT",
}


@dataclass
class FmtInfo:
    chunk: Chunk
    audio_format: int
    channels: int
    sample_rate: int
    byte_rate: int
    block_align: int
    bits_per_sample: int
    valid_bits: int | None = None
    channel_mask: int | None = None
    sub_format: int | None = None  # first 2 bytes of GUID for PCM/float GUIDs

    def off(self, rel: int) -> int:
        return self.chunk.field_offset(rel)


def parse_fmt(chunk: Chunk) -> FmtInfo:
    p = chunk.payload
    if len(p) < 16:
        raise ValueError(f"fmt chunk too small: {len(p)} bytes")
    (audio_format, channels, sample_rate, byte_rate,
     block_align, bits) = struct.unpack_from("<HHIIHH", p, 0)
    info = FmtInfo(chunk, audio_format, channels, sample_rate,
                   byte_rate, block_align, bits)
    if audio_format == WAVE_FORMAT_EXTENSIBLE:
        if len(p) < 40:
            raise ValueError("extensible fmt chunk shorter than 40 bytes")
        cb_size = struct.unpack_from("<H", p, 16)[0]
        if cb_size < 22:
            raise ValueError(f"extensible fmt cbSize={cb_size} < 22")
        info.valid_bits = struct.unpack_from("<H", p, 18)[0]
        info.channel_mask = struct.unpack_from("<I", p, 20)[0]
        guid = p[24:40]
        if guid[4:] == PCM_GUID_TAIL:
            info.sub_format = struct.unpack_from("<H", guid, 0)[0]
    return info


def mask_speakers(mask: int) -> list[str]:
    names = []
    for bit, name in SPEAKER_BITS.items():
        if mask & (1 << bit):
            names.append(name)
    known = sum(1 << b for b in SPEAKER_BITS)
    if mask & ~known:
        names.append(f"UNKNOWN_BITS(0x{mask & ~known:x})")
    return names
