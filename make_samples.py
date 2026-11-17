"""Generate the three requested BWF sample files into samples/.

  sample1_missing_bext.wav      - valid file but no bext chunk
  sample2_timeref_mismatch.wav  - bext.TimeReference disagrees with iXML
  sample3_unknown_chunk.wav     - consistent file plus an unknown chunk
"""
from __future__ import annotations

import math
import os
import struct

RATE = 48000
CHANNELS = 2
BITS = 24
TIMREF_0800 = 8 * 3600 * RATE   # 08:00:00 in samples
TIMREF_0900 = 9 * 3600 * RATE   # 09:00:00 in samples (the inconsistent one)


def chunk(cid: bytes, payload: bytes) -> bytes:
    pad = b"\x00" if len(payload) & 1 else b""
    return cid + struct.pack("<I", len(payload)) + payload + pad


def fmt_chunk() -> bytes:
    guid = struct.pack("<IHH", 1, 0, 0x10) + bytes.fromhex("800000aa00389b71")
    payload = struct.pack("<HHIIHH", 0xFFFE, CHANNELS, RATE,
                          RATE * CHANNELS * BITS // 8,
                          CHANNELS * BITS // 8, BITS)
    payload += struct.pack("<HHI", 22, BITS, 0x3) + guid
    return chunk(b"fmt ", payload)


def bext_chunk(time_ref: int, date="2026-11-18", time="08:00:00") -> bytes:
    def fld(text: str, ln: int) -> bytes:
        return text.encode("ascii") + b"\x00" * (ln - len(text))

    payload = fld("Scene 12A take 3, boom+lav", 256)
    payload += fld("bwfmeta-demo", 32)
    payload += fld("UID4-0019-DEMO-0001", 32)
    payload += fld(date, 10) + fld(time, 8)
    payload += struct.pack("<QH", time_ref, 1)
    payload += b"\x00" * 64            # UMID absent
    payload += b"\x00" * 190           # v1 reserved
    payload += b"A=PCM,F=48000,W=24,M=stereo,T=bwfmeta-demo\r\n"
    return chunk(b"bext", payload)


def ixml_chunk(time_ref: int, scene="12A", take="3",
               date="2026-11-18", time="08:00:00") -> bytes:
    lo = time_ref & 0xFFFFFFFF
    hi = (time_ref >> 32) & 0xFFFFFFFF
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<BWFXML>
  <IXML_VERSION>1.5</IXML_VERSION>
  <PROJECT>uid4-demo</PROJECT>
  <SCENE>{scene}</SCENE>
  <TAKE>{take}</TAKE>
  <TAPE>001</TAPE>
  <NOTE>demo file</NOTE>
  <BEXT>
    <BWF_DESCRIPTION>Scene {scene} take {take}, boom+lav</BWF_DESCRIPTION>
    <BWF_ORIGINATOR>bwfmeta-demo</BWF_ORIGINATOR>
    <BWF_ORIGINATOR_REFERENCE>UID4-0019-DEMO-0001</BWF_ORIGINATOR_REFERENCE>
    <BWF_ORIGINATION_DATE>{date}</BWF_ORIGINATION_DATE>
    <BWF_ORIGINATION_TIME>{time}</BWF_ORIGINATION_TIME>
    <BWF_TIME_REFERENCE_LOW>{lo}</BWF_TIME_REFERENCE_LOW>
    <BWF_TIME_REFERENCE_HIGH>{hi}</BWF_TIME_REFERENCE_HIGH>
    <BWF_VERSION>1</BWF_VERSION>
  </BEXT>
  <FILE_SET>
    <TOTAL_FILES>1</TOTAL_FILES>
    <FAMILY_UID>UID4-0019-DEMO-0001</FAMILY_UID>
    <FILE_SET_INDEX>1</FILE_SET_INDEX>
  </FILE_SET>
</BWFXML>
"""
    return chunk(b"iXML", xml.encode("utf-8"))


def cue_chunks(scene="12A") -> bytes:
    entry = struct.pack("<II4sIII", 1, 2400, b"data", 0, 0, 2400)
    cue = chunk(b"cue ", struct.pack("<I", 1) + entry)
    label = f"Scene {scene} slate".encode("utf-8") + b"\x00"
    labl = b"labl" + struct.pack("<I", 4 + len(label)) \
        + struct.pack("<I", 1) + label
    if len(label) & 1:
        labl += b"\x00"
    lst = chunk(b"LIST", b"adtl" + labl)
    return cue + lst


def data_chunk() -> bytes:
    frames = 4800
    pcm = bytearray()
    for n in range(frames):
        v = int(0.1 * 8388607 * math.sin(2 * math.pi * 440 * n / RATE))
        pcm += v.to_bytes(3, "little", signed=True) * CHANNELS
    return chunk(b"data", bytes(pcm))


def wave(*parts: bytes) -> bytes:
    body = b"WAVE" + b"".join(parts)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def main() -> None:
    os.makedirs("samples", exist_ok=True)
    s1 = wave(fmt_chunk(), ixml_chunk(TIMREF_0800), cue_chunks(), data_chunk())
    s2 = wave(fmt_chunk(), bext_chunk(TIMREF_0800), ixml_chunk(TIMREF_0900),
              cue_chunks(), data_chunk())
    s3 = wave(fmt_chunk(), bext_chunk(TIMREF_0800), ixml_chunk(TIMREF_0800),
              chunk(b"zzZ1", b"proprietary-payload\x00\x01\x02"),
              cue_chunks(), data_chunk())
    for name, blob in [("sample1_missing_bext.wav", s1),
                       ("sample2_timeref_mismatch.wav", s2),
                       ("sample3_unknown_chunk.wav", s3)]:
        path = os.path.join("samples", name)
        with open(path, "wb") as fh:
            fh.write(blob)
        print(f"wrote {path} ({len(blob)} bytes)")


if __name__ == "__main__":
    main()
