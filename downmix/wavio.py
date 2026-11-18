"""Minimal multi-channel WAV reader/writer using only the standard library.

Supports PCM (8/16/24/32-bit), IEEE float32 and WAVEFORMATEXTENSIBLE.
All decoded/encoded sample values are floats in the range [-1.0, 1.0].

WAVEFORMATEXTENSIBLE channel mask for a 5.1 file is assumed to be the
standard 0x3F layout: FL, FR, FC, LFE, BL(SL), BR(SR).
"""

from __future__ import annotations

import struct

SPEAKER_MASK_51 = 0x3F

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE
KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = b"\x03\x00\x00\x00\x00\x00\x10\x00"
KSDATAFORMAT_SUBTYPE_PCM = b"\x01\x00\x00\x00\x00\x00\x10\x00"


def _decode_pcm(raw: bytes, sampwidth: int, nframes: int, nch: int):
    total = nframes * nch
    out = [0.0] * total
    if sampwidth == 1:
        maxv = 128.0
        for i, byte in enumerate(raw[:total]):
            out[i] = (byte - 128) / maxv
    elif sampwidth == 2:
        vals = struct.unpack("<%dh" % total, raw[: total * 2])
        for i, v in enumerate(vals):
            out[i] = v / 32768.0
    elif sampwidth == 3:
        for i in range(total):
            off = i * 3
            b0, b1, b2 = raw[off], raw[off + 1], raw[off + 2]
            value = b0 | (b1 << 8) | (b2 << 16)
            if value & 0x800000:
                value -= 0x1000000
            out[i] = value / 8388608.0
    elif sampwidth == 4:
        vals = struct.unpack("<%di" % total, raw[: total * 4])
        for i, v in enumerate(vals):
            out[i] = v / 2147483648.0
    else:
        raise ValueError("unsupported PCM sample width: %d bytes" % sampwidth)
    return out


def _decode_float32(raw: bytes, total: int):
    vals = struct.unpack("<%df" % total, raw[: total * 4])
    return [float(v) for v in vals]


def read_wav(path: str):
    """Read a WAV file.

    Returns ``(samples, sample_rate, n_channels)`` where samples is a
    flat list of de-interleaved floats, frame-major:
    ``samples[frame * nch + ch]``.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("%s is not a RIFF/WAVE file" % path)

    pos = 12
    fmt = None
    audio = b""
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        (chunk_size,) = struct.unpack_from("<I", data, pos + 4)
        body = pos + 8
        if chunk_id == b"fmt ":
            fmt = data[body : body + chunk_size]
        elif chunk_id == b"data":
            audio = data[body : body + chunk_size]
        pos = body + chunk_size + (chunk_size & 1)
    if fmt is None:
        raise ValueError("WAV file missing fmt chunk")

    (tag, nch, rate, _bps, _blockalign, bits) = struct.unpack_from(
        "<HHIIHH", fmt, 0
    )
    valid_bits = bits
    if tag == WAVE_FORMAT_EXTENSIBLE and len(fmt) >= 40:
        (valid_bits, _mask, subtype) = struct.unpack_from(
            "<HI16s", fmt, 18
        )
        # Subtype GUID stores the legacy format tag in its first 2 bytes.
        if subtype[:2] == b"\x03\x00":
            tag = WAVE_FORMAT_IEEE_FLOAT
        elif subtype[:2] == b"\x01\x00":
            tag = WAVE_FORMAT_PCM

    if tag == WAVE_FORMAT_IEEE_FLOAT and bits == 32:
        total = len(audio) // 4
        flat = _decode_float32(audio, total)
    elif tag == WAVE_FORMAT_PCM:
        sampwidth = (valid_bits or bits) // 8
        total = len(audio) // sampwidth
        flat = _decode_pcm(audio, sampwidth, total // nch, nch)
    else:
        raise ValueError(
            "unsupported WAV format tag=0x%04X bits=%d" % (tag, bits)
        )

    nframes = len(flat) // nch
    return flat, rate, nch


def _encode_pcm(flat, sampwidth: int):
    total = len(flat)
    clipped = 0
    if sampwidth == 1:
        out = bytearray(total)
        for i, v in enumerate(flat):
            if v >= 1.0:
                out[i] = 255
                clipped += 1
            elif v <= -1.0:
                out[i] = 0
                clipped += 1
            else:
                out[i] = int(round(v * 128.0)) + 128
        return bytes(out), clipped
    if sampwidth == 2:
        out = bytearray(total * 2)
        for i, v in enumerate(flat):
            iv = int(round(v * 32768.0))
            if iv > 32767:
                iv, clipped = 32767, clipped + 1
            elif iv < -32768:
                iv, clipped = -32768, clipped + 1
            struct.pack_into("<h", out, i * 2, iv)
        return bytes(out), clipped
    if sampwidth == 3:
        out = bytearray(total * 3)
        for i, v in enumerate(flat):
            iv = int(round(v * 8388608.0))
            if iv > 8388607:
                iv, clipped = 8388607, clipped + 1
            elif iv < -8388608:
                iv, clipped = -8388608, clipped + 1
            if iv < 0:
                iv += 0x1000000
            off = i * 3
            out[off] = iv & 0xFF
            out[off + 1] = (iv >> 8) & 0xFF
            out[off + 2] = (iv >> 16) & 0xFF
        return bytes(out), clipped
    if sampwidth == 4:
        out = bytearray(total * 4)
        for i, v in enumerate(flat):
            iv = int(round(v * 2147483648.0))
            if iv > 2147483647:
                iv, clipped = 2147483647, clipped + 1
            elif iv < -2147483648:
                iv, clipped = -2147483648, clipped + 1
            struct.pack_into("<i", out, i * 4, iv)
        return bytes(out), clipped
    raise ValueError("unsupported PCM sample width: %d bytes" % sampwidth)


def _riff_chunk(chunk_id: bytes, body: bytes) -> bytes:
    pad = b"\x00" if len(body) & 1 else b""
    return chunk_id + struct.pack("<I", len(body)) + body + pad


def write_wav(path: str, flat, sample_rate: int, n_channels: int,
              subtype: str = "float32", mask: int | None = None):
    """Write interleaved float samples to a WAV file.

    ``subtype`` is ``"float32"`` (default, WAVEFORMATEXTENSIBLE when
    n_channels > 2) or ``"pcm16"`` / ``"pcm24"``.
    Returns the number of samples hard-clipped during encoding.
    """
    if subtype == "float32":
        body = struct.pack("<%df" % len(flat), *[float(v) for v in flat])
        bits = 32
        block_align = n_channels * 4
        avg_bytes = sample_rate * block_align
        if n_channels > 2:
            fmt = struct.pack(
                "<HHIIHHHIH16s",
                WAVE_FORMAT_EXTENSIBLE, n_channels, sample_rate, avg_bytes,
                block_align, bits, 22, n_channels * 32,
                SPEAKER_MASK_51 if mask is None else mask,
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            )
        else:
            fmt = struct.pack(
                "<HHIIHH",
                WAVE_FORMAT_IEEE_FLOAT, n_channels, sample_rate, avg_bytes,
                block_align, bits,
            )
        clipped = 0
    elif subtype in ("pcm16", "pcm24"):
        sampwidth = 2 if subtype == "pcm16" else 3
        body, clipped = _encode_pcm(flat, sampwidth)
        bits = sampwidth * 8
        block_align = n_channels * sampwidth
        avg_bytes = sample_rate * block_align
        fmt = struct.pack(
            "<HHIIHH",
            WAVE_FORMAT_PCM, n_channels, sample_rate, avg_bytes,
            block_align, bits,
        )
    else:
        raise ValueError("unknown subtype %r" % subtype)

    riff = (
        b"RIFF"
        + struct.pack("<I", 4 + (8 + len(fmt)) + (8 + len(body) + (len(body) & 1)))
        + b"WAVE"
        + _riff_chunk(b"fmt ", fmt)
        + _riff_chunk(b"data", body)
    )
    with open(path, "wb") as handle:
        handle.write(riff)
    return clipped


def read_wav_simple(path: str):
    """Wrapper kept for API symmetry with wave-module based tooling."""
    return read_wav(path)
