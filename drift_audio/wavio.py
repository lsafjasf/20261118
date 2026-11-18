"""Small PCM WAV reader/writer using only the Python standard library."""

from __future__ import annotations

import math
import wave


def _decode_samples(raw: bytes, width: int, count: int) -> list[float]:
    if width == 1:
        return [(byte - 128) / 128.0 for byte in raw[:count]]
    if width == 2:
        scale = 32768.0
        return [
            int.from_bytes(raw[i : i + 2], "little", signed=True) / scale
            for i in range(0, count * 2, 2)
        ]
    if width == 3:
        values = []
        for i in range(0, count * 3, 3):
            value = int.from_bytes(raw[i : i + 3], "little", signed=True)
            values.append(value / 8388608.0)
        return values
    if width == 4:
        return [
            int.from_bytes(raw[i : i + 4], "little", signed=True) / 2147483648.0
            for i in range(0, count * 4, 4)
        ]
    raise ValueError(f"unsupported WAV sample width: {width} bytes")


def _encode_samples(samples: list[float], width: int) -> bytes:
    clamped = [min(1.0, max(-1.0, value)) for value in samples]
    if width == 1:
        return bytes(round(value * 127.0 + 128.0) for value in clamped)
    if width == 2:
        return b"".join(
            int(round(value * 32767.0)).to_bytes(2, "little", signed=True)
            for value in clamped
        )
    if width == 3:
        return b"".join(
            int(round(value * 8388607.0)).to_bytes(3, "little", signed=True)
            for value in clamped
        )
    if width == 4:
        return b"".join(
            int(round(value * 2147483647.0)).to_bytes(4, "little", signed=True)
            for value in clamped
        )
    raise ValueError(f"unsupported WAV sample width: {width} bytes")


def read_wav(path: str) -> tuple[list[list[float]], int]:
    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)

    interleaved = _decode_samples(raw, width, frames * channels)
    planar = [
        interleaved[channel::channels]
        for channel in range(channels)
    ]
    return planar, rate


def write_wav(path: str, channels: list[list[float]], rate: int) -> None:
    if not channels:
        raise ValueError("cannot write an empty WAV file")
    frame_count = len(channels[0])
    if any(len(channel) != frame_count for channel in channels):
        raise ValueError("all channels must have the same length")

    width = 2
    interleaved = [0.0] * (frame_count * len(channels))
    for channel_index, channel in enumerate(channels):
        interleaved[channel_index::len(channels)] = channel

    with wave.open(path, "wb") as wav:
        wav.setnchannels(len(channels))
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(_encode_samples(interleaved, width))


def to_mono(channels: list[list[float]]) -> list[float]:
    if len(channels) == 1:
        return channels[0][:]
    scale = float(len(channels))
    return [sum(frame) / scale for frame in zip(*channels)]


def rms(values: list[float]) -> float:
    return math.sqrt(sum(value * value for value in values) / max(1, len(values)))
