"""Minimal ISO-BMFF patcher used only by the test suite.

It can (1) rewrite a video track's tkhd matrix back to identity and
(2) inject the legacy freeform ``rotate`` metadata item that pre-2017
ffmpeg wrote, letting the tests reproduce both the single legacy tag and
the "display matrix + rotate tag" duplicate-marker cases.
"""

from __future__ import annotations

import struct

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"ilst",
              b"meta", b"edts"}
IDENTITY_3X3 = struct.pack(
    ">9I", 1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 1 << 30
)


def parse_boxes(blob: bytes, start: int = 0, end: int | None = None):
    end = len(blob) if end is None else end
    boxes = []
    pos = start
    while pos + 8 <= end:
        size = struct.unpack(">I", blob[pos:pos + 4])[0]
        kind = blob[pos + 4:pos + 8]
        header = 8
        if size == 1:
            size = struct.unpack(">Q", blob[pos + 8:pos + 16])[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            break
        boxes.append({"kind": kind, "start": pos, "size": size,
                      "header": header, "raw": blob[pos:pos + size]})
        pos += size
    return boxes


def children(blob: bytes, box: dict):
    body_start = box["start"] + box["header"]
    if box["kind"] == b"meta":
        body_start += 4  # meta uses a full-box header (version/flags)
    return parse_boxes(blob, body_start, box["start"] + box["size"])


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", 8 + len(body)) + kind + body


def legacy_rotate_item(degrees: int) -> bytes:
    # mov_read_custom() requires each child atom to carry a 4-byte
    # version/flags field after its header.
    mean = box(b"mean", b"\x00\x00\x00\x00" + b"com.apple.ffmpeg")
    name = box(b"name", b"\x00\x00\x00\x00" + b"rotate")
    # For data, that 4-byte field doubles as the type indicator (1 = UTF-8).
    value = str(degrees).encode()
    # Parser reads flags(4) + type(4), then the remaining bytes as the value.
    data_payload = b"\x00\x00\x00\x00\x00\x00\x00\x01" + value
    data = box(b"data", data_payload)
    dashed = box(b"----", mean + name + data)
    ilst = box(b"ilst", dashed)
    hdlr = box(b"hdlr", b"\x00" * 8 + b"mdir" + b"\x00" * 12)
    meta_body = b"\x00\x00\x00\x00" + hdlr + ilst
    meta = box(b"meta", meta_body)
    return box(b"udta", meta)


def find_trak_with_tkhd(blob: bytes, trak: dict):
    for mdia in children(blob, trak):
        if mdia["kind"] != b"mdia":
            continue
        for minf in children(blob, mdia):
            if minf["kind"] != b"minf":
                continue
            for stbl in children(blob, minf):
                if stbl["kind"] != b"stbl":
                    continue
                for stsd in children(blob, stbl):
                    if stsd["kind"] == b"stsd":
                        return True
    return False


def patch_tkhd_identity(blob: bytearray, trak_box: dict) -> bool:
    for child in parse_boxes(bytes(blob), trak_box["start"] + trak_box["header"],
                             trak_box["start"] + trak_box["size"]):
        if child["kind"] == b"tkhd":
            version = blob[child["start"] + child["header"]]
            # Body layout: version/flags(4), timestamps, track_id(4),
            # reserved(4), duration, reserved(8), layer/altgroup/volume(6),
            # reserved(2), then the 36-byte matrix.
            if version == 1:
                body_prefix = 4 + 8 + 8 + 4 + 4 + 8 + 8 + 6 + 2
            else:
                body_prefix = 4 + 4 + 4 + 4 + 4 + 4 + 8 + 6 + 2
            matrix_offset = child["start"] + child["header"] + body_prefix
            blob[matrix_offset:matrix_offset + 36] = IDENTITY_3X3
            return True
    return False


def inject_legacy_rotate(src: str, dst: str, degrees: int,
                         reset_matrix: bool) -> None:
    blob = bytearray(open(src, "rb").read())
    moov = next(b for b in parse_boxes(bytes(blob)) if b["kind"] == b"moov")
    target_trak = None
    for trak in children(bytes(blob), moov):
        if trak["kind"] == b"trak" and find_trak_with_tkhd(bytes(blob), trak):
            target_trak = trak
            break
    if target_trak is None:
        raise RuntimeError("video trak not found")
    if reset_matrix and not patch_tkhd_identity(blob, target_trak):
        raise RuntimeError("tkhd not found")
    result = _insert_into_trak(bytes(blob), target_trak,
                               legacy_rotate_item(degrees))
    with open(dst, "wb") as handle:
        handle.write(result)


def _insert_into_trak(blob: bytes, trak: dict, payload: bytes) -> bytes:
    new_trak_body = blob[trak["start"] + 8:trak["start"] + trak["size"]] + payload
    new_trak = box(b"trak", new_trak_body)
    return blob[:trak["start"]] + new_trak + blob[trak["start"] + trak["size"]:]
