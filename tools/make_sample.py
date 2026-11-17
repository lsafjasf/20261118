#!/usr/bin/env python3
"""Generate a synthetic Ogg Opus file with known packet anomalies.

The payloads are not real Opus frames; only the container, TOC bytes and
granule positions matter for the packet-sequence inspector. The injected
anomalies (0-based audio packet numbers; absolute index = audio + 2):

  audio 20  timestamp rollback (page granule moved backwards)
  audio 40  duplicate packet (identical payload, zero granule advance)
  audio 60  injected 960-sample loss gap
  audio 70-72  TOC declares FB/48kHz while OpusHead declares 16000 Hz
"""
import struct
import sys

SERIAL = 0x12345678
PRE_SKIP = 312
INPUT_RATE = 16000
PACKETS_PER_PAGE = 10
NUM_AUDIO_PACKETS = 100

TOC_NORMAL = 8 << 3  # config 8: SILK WB, 10 ms -> 480 samples @48k
TOC_FULLBAND = 31 << 3  # config 31: CELT FB, 20 ms -> 960 samples @48k

# Ogg CRC-32: polynomial 0x04C11DB7, init 0, no reflection, no final XOR.
CRC_TABLE = []
for i in range(256):
    r = i << 24
    for _ in range(8):
        r = ((r << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if r & 0x80000000 else (r << 1) & 0xFFFFFFFF
    CRC_TABLE.append(r)


def ogg_crc(data: bytes) -> int:
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ CRC_TABLE[((crc >> 24) & 0xFF) ^ b]
    return crc


def build_page(seq: int, granule: int, packets: list, header_type: int = 0) -> bytes:
    segments = []
    payload = b""
    for pkt in packets:
        payload += pkt
        remaining = len(pkt)
        while remaining >= 255:
            segments.append(255)
            remaining -= 255
        segments.append(remaining)
    header = (
        b"OggS"
        + bytes([0, header_type])
        + struct.pack("<q", granule)
        + struct.pack("<II", SERIAL, seq)
        + b"\x00\x00\x00\x00"
        + bytes([len(segments)])
        + bytes(segments)
    )
    page = header + payload
    crc = ogg_crc(page)
    return page[:22] + struct.pack("<I", crc) + page[26:]


def make_payload(seed: int, length: int = 60) -> bytes:
    return bytes(((seed * 31 + i * 7) & 0xFF) for i in range(length))


def main(out_path: str) -> None:
    opus_head = (
        b"OpusHead"
        + bytes([1, 2])
        + struct.pack("<H", PRE_SKIP)
        + struct.pack("<I", INPUT_RATE)
        + struct.pack("<h", 0)
        + bytes([0])
    )
    opus_tags = b"OpusTags" + struct.pack("<I", 0) + struct.pack("<I", 0)

    pages = [build_page(0, 0, [opus_head], header_type=2),
             build_page(1, 0, [opus_tags])]

    # Audio packets; 70-72 use a full-band TOC (rate mismatch).
    audio = []
    for n in range(NUM_AUDIO_PACKETS):
        toc = TOC_FULLBAND if 70 <= n <= 72 else TOC_NORMAL
        audio.append(bytes([toc]) + make_payload(n))
    audio[40] = audio[39]  # duplicate payload

    durations = [960 if 70 <= n <= 72 else 480 for n in range(NUM_AUDIO_PACKETS)]

    # Page granule offsets that inject the timestamp anomalies.
    page_offsets = {2: -2400, 4: -480, 6: 960}

    # Granule positions count pre-skip samples, so the cursor starts at 0.
    cursor = 0
    seq = 2
    for page_idx in range(NUM_AUDIO_PACKETS // PACKETS_PER_PAGE):
        start = page_idx * PACKETS_PER_PAGE
        page_packets = audio[start:start + PACKETS_PER_PAGE]
        page_samples = sum(durations[start:start + PACKETS_PER_PAGE])
        granule = cursor + page_samples + page_offsets.get(page_idx, 0)
        cursor = granule
        header_type = 4 if start + PACKETS_PER_PAGE >= NUM_AUDIO_PACKETS else 0
        pages.append(build_page(seq, granule, page_packets, header_type))
        seq += 1

    with open(out_path, "wb") as fh:
        fh.write(b"".join(pages))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test/fixtures/sample-anomalies.opus")
