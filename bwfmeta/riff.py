"""RIFF/WAVE chunk layer: parse and rebuild without touching payload bytes."""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

KNOWN_CHUNK_IDS = {
    b"fmt ", b"data", b"bext", b"iXML", b"cue ", b"LIST", b"adtl",
    b"fact", b"JUNK", b"PAD ", b"PEAK", b"levl", b"plst", b"smpl",
    b"inst", b"acid", b"DISP", b"INFO", b"minf", b"elm1", b"regn",
    b"umid", b"DGDA", b"chna", b"axml", b"xml ", b"WAVE", b"id3 ",
}


class RiffError(ValueError):
    pass


@dataclass
class Chunk:
    cid: bytes          # 4-byte chunk id
    offset: int         # absolute file offset of the chunk id
    size: int           # payload size (without pad byte)
    payload: bytes

    @property
    def data_offset(self) -> int:
        return self.offset + 8

    @property
    def end_offset(self) -> int:
        return self.data_offset + self.size + (self.size & 1)

    @property
    def known(self) -> bool:
        return self.cid in KNOWN_CHUNK_IDS

    def field_offset(self, rel: int) -> int:
        """Absolute file offset of a field at `rel` bytes into the payload."""
        return self.data_offset + rel


@dataclass
class WaveFile:
    chunks: list[Chunk] = field(default_factory=list)

    def find(self, cid: bytes) -> Chunk | None:
        for c in self.chunks:
            if c.cid == cid:
                return c
        return None

    def find_all(self, cid: bytes) -> list[Chunk]:
        return [c for c in self.chunks if c.cid == cid]

    def replace(self, old: Chunk, payload: bytes) -> None:
        idx = self.chunks.index(old)
        self.chunks[idx] = Chunk(old.cid, old.offset, len(payload), payload)

    def chunk_map(self) -> list[tuple[str, int]]:
        return [(c.cid.decode("latin-1"), c.size) for c in self.chunks]


def parse_wave(data: bytes) -> WaveFile:
    if len(data) < 12:
        raise RiffError("file too small for a RIFF header")
    if data[0:4] != b"RIFF":
        raise RiffError("missing RIFF magic at offset 0")
    if data[8:12] != b"WAVE":
        raise RiffError("missing WAVE form type at offset 8")
    riff_size = struct.unpack_from("<I", data, 4)[0]
    if riff_size + 8 > len(data):
        raise RiffError(
            f"RIFF size field ({riff_size}) exceeds actual file size ({len(data) - 8})"
        )
    chunks: list[Chunk] = []
    pos = 12
    limit = min(len(data), riff_size + 8)
    while pos + 8 <= limit:
        cid = data[pos:pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        payload_start = pos + 8
        payload_end = payload_start + size
        if payload_end > len(data):
            raise RiffError(
                f"chunk {cid!r} at offset {pos} declares size {size} beyond EOF"
            )
        chunks.append(Chunk(cid, pos, size, data[payload_start:payload_end]))
        pos = payload_end + (size & 1)
    return WaveFile(chunks)


def build_wave(wave: WaveFile) -> bytes:
    body = bytearray(b"WAVE")
    for c in wave.chunks:
        body += c.cid
        body += struct.pack("<I", len(c.payload))
        body += c.payload
        if len(c.payload) & 1:
            body += b"\x00"
    return b"RIFF" + struct.pack("<I", len(body)) + bytes(body)


def roundtrip_ok(data: bytes) -> bool:
    return build_wave(parse_wave(data)) == data
