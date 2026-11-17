"""cue chunk + LIST/adtl label parsing."""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

from .riff import Chunk, WaveFile

CUE_ENTRY_SIZE = 24


@dataclass
class CuePoint:
    cue_id: int
    position: int
    sample_offset: int
    entry_offset: int   # absolute file offset of this 24-byte entry
    label: str | None = None
    label_offset: int | None = None


@dataclass
class CueInfo:
    chunk: Chunk
    points: list[CuePoint] = field(default_factory=list)


def parse_cue(chunk: Chunk) -> CueInfo:
    p = chunk.payload
    if len(p) < 4:
        raise ValueError("cue chunk too small")
    num = struct.unpack_from("<I", p, 0)[0]
    points = []
    for i in range(num):
        off = 4 + i * CUE_ENTRY_SIZE
        if off + CUE_ENTRY_SIZE > len(p):
            raise ValueError(f"cue chunk truncated at entry {i}")
        cue_id, position, _fcc, _cs, _bs, sample_off = struct.unpack_from(
            "<II4sIII", p, off)
        points.append(CuePoint(cue_id, position, sample_off,
                               chunk.field_offset(off)))
    return CueInfo(chunk, points)


def attach_labels(wave: WaveFile, info: CueInfo) -> None:
    """Fill in labels from LIST/adtl 'labl' sub-chunks."""
    for lst in wave.find_all(b"LIST"):
        if lst.payload[:4] != b"adtl":
            continue
        pos = 4
        p = lst.payload
        while pos + 8 <= len(p):
            sid = p[pos:pos + 4]
            size = struct.unpack_from("<I", p, pos + 4)[0]
            body = p[pos + 8:pos + 8 + size]
            if sid == b"labl" and len(body) >= 4:
                cue_id = struct.unpack_from("<I", body, 0)[0]
                text = body[4:].split(b"\x00", 1)[0].decode(
                    "utf-8", errors="replace")
                for pt in info.points:
                    if pt.cue_id == cue_id:
                        pt.label = text
                        pt.label_offset = lst.field_offset(pos + 12)
            pos += 8 + size + (size & 1)


def set_cue_label(wave: WaveFile, lst: Chunk, cue_id: int, value: str) -> None:
    """Replace the label text of one cue id inside a LIST/adtl chunk."""
    p = bytearray(lst.payload)
    pos = 4
    while pos + 8 <= len(p):
        sid = bytes(p[pos:pos + 4])
        size = struct.unpack_from("<I", p, pos + 4)[0]
        if sid == b"labl" and size >= 4:
            cid = struct.unpack_from("<I", p, pos + 8)[0]
            if cid == cue_id:
                body = value.encode("utf-8") + b"\x00"
                new_lst = p[:pos + 8] + struct.pack("<I", cue_id) + body
                new_lst += p[pos + 8 + size + (size & 1):]
                struct.pack_into("<I", new_lst, pos + 4, 4 + len(body))
                wave.replace(lst, bytes(new_lst))
                return
        pos += 8 + size + (size & 1)
    raise KeyError(f"no labl entry for cue id {cue_id}")
