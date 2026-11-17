"""bext (Broadcast Audio Extension, EBU Tech 3285) v0/v1/v2 parsing."""
from __future__ import annotations

import struct
from dataclasses import dataclass

from .riff import Chunk

# field name -> (offset in payload, length) for fixed ASCII fields
ASCII_FIELDS = {
    "description": (0, 256),
    "originator": (256, 32),
    "originator_reference": (288, 32),
    "origination_date": (320, 10),   # YYYY-MM-DD
    "origination_time": (330, 8),    # HH:MM:SS
}
TIME_REFERENCE_OFF = 338   # uint64 LE, samples since midnight
VERSION_OFF = 346          # uint16
UMID_OFF = 348             # 64 bytes
LOUDNESS_OFF = 412         # v2: 5 x uint16
CODING_HISTORY_MIN = 602


@dataclass
class BextInfo:
    chunk: Chunk
    description: str
    originator: str
    originator_reference: str
    origination_date: str
    origination_time: str
    time_reference: int
    version: int
    umid: bytes
    coding_history: str

    def field_offset(self, name: str) -> int:
        if name in ASCII_FIELDS:
            return self.chunk.field_offset(ASCII_FIELDS[name][0])
        if name == "time_reference":
            return self.chunk.field_offset(TIME_REFERENCE_OFF)
        if name == "version":
            return self.chunk.field_offset(VERSION_OFF)
        raise KeyError(name)


def _decode_ascii(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("ascii", errors="replace").strip()


def parse_bext(chunk: Chunk) -> BextInfo:
    p = chunk.payload
    if len(p) < 348:
        raise ValueError(f"bext chunk too small: {len(p)} bytes")
    vals = {name: _decode_ascii(p[off:off + ln])
            for name, (off, ln) in ASCII_FIELDS.items()}
    time_ref = struct.unpack_from("<Q", p, TIME_REFERENCE_OFF)[0]
    version = struct.unpack_from("<H", p, VERSION_OFF)[0]
    umid = p[UMID_OFF:UMID_OFF + 64]
    hist_start = CODING_HISTORY_MIN if len(p) >= CODING_HISTORY_MIN else 348
    coding = p[hist_start:].decode("ascii", errors="replace").rstrip("\x00")
    return BextInfo(chunk, vals["description"], vals["originator"],
                    vals["originator_reference"], vals["origination_date"],
                    vals["origination_time"], time_ref, version, umid, coding)


def encode_ascii(value: str, length: int) -> bytes:
    raw = value.encode("ascii", errors="strict")
    if len(raw) > length:
        raise ValueError(f"value {value!r} exceeds {length} bytes")
    return raw + b"\x00" * (length - len(raw))


def set_bext_ascii(chunk: Chunk, name: str, value: str) -> bytes:
    """Return a new bext payload with one fixed ASCII field replaced."""
    if name not in ASCII_FIELDS:
        raise KeyError(f"not a safe bext ASCII field: {name}")
    off, ln = ASCII_FIELDS[name]
    p = bytearray(chunk.payload)
    if len(p) < off + ln:
        p.extend(b"\x00" * (off + ln - len(p)))
    p[off:off + ln] = encode_ascii(value, ln)
    return bytes(p)
