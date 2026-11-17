"""Dependency-free PCM WAV input and output."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import struct
import wave


_LIMITS = {
    1: (-128, 127, 128.0),
    2: (-32768, 32767, 32768.0),
    3: (-8388608, 8388607, 8388608.0),
    4: (-2147483648, 2147483647, 2147483648.0),
}


@dataclass
class Audio:
    """Interleaved-by-channel normalized PCM samples.

    ``samples[channel][frame]`` is in [-1, 1]. The original integer
    representation is retained through ``sample_width`` so a file can be
    written back at its native bit depth.
    """

    sample_rate: int
    sample_width: int
    samples: list[list[float]]

    def __post_init__(self) -> None:
        if self.sample_width not in _LIMITS:
            raise ValueError("sample_width must be 1, 2, 3, or 4 bytes")
        if not self.samples or not self.samples[0]:
            raise ValueError("audio must contain at least one frame")
        frame_count = len(self.samples[0])
        if any(len(channel) != frame_count for channel in self.samples):
            raise ValueError("all channels must have the same frame count")

    @property
    def channels(self) -> int:
        return len(self.samples)

    @property
    def frames(self) -> int:
        return len(self.samples[0])

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate

    def copy(self) -> "Audio":
        return Audio(self.sample_rate, self.sample_width, [ch[:] for ch in self.samples])

    def with_samples(self, samples: list[list[float]]) -> "Audio":
        return Audio(self.sample_rate, self.sample_width, samples)


def _decode_8bit(raw: bytes, channels: int) -> list[list[float]]:
    output = [[] for _ in range(channels)]
    for index, value in enumerate(raw):
        output[index % channels].append((value - 128) / 128.0)
    return output


def _decode_16bit(raw: bytes, channels: int) -> list[list[float]]:
    values = struct.unpack(f"<{len(raw) // 2}h", raw)
    output = [[] for _ in range(channels)]
    for index, value in enumerate(values):
        output[index % channels].append(value / 32768.0)
    return output


def _decode_24bit(raw: bytes, channels: int) -> list[list[float]]:
    output = [[] for _ in range(channels)]
    for index in range(0, len(raw), 3):
        value = int.from_bytes(raw[index : index + 3], "little", signed=True)
        output[(index // 3) % channels].append(value / 8388608.0)
    return output


def _decode_32bit(raw: bytes, channels: int) -> list[list[float]]:
    values = struct.unpack(f"<{len(raw) // 4}i", raw)
    output = [[] for _ in range(channels)]
    for index, value in enumerate(values):
        output[index % channels].append(value / 2147483648.0)
    return output


def read_wav(path: str | Path) -> Audio:
    """Read integer PCM WAV data into normalized channel arrays."""

    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError("compressed WAV data is not supported")
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frame_count = source.getnframes()
        if width not in _LIMITS:
            raise ValueError(f"unsupported PCM sample width: {width} bytes")
        raw = source.readframes(frame_count)

    decoders = {
        1: _decode_8bit,
        2: _decode_16bit,
        3: _decode_24bit,
        4: _decode_32bit,
    }
    samples = decoders[width](raw, channels)
    expected = frame_count
    if len(samples[0]) != expected:
        raise ValueError("WAV frame count does not match decoded sample count")
    return Audio(rate, width, samples)


def _clamp(value: float, low: int, high: int) -> int:
    if value <= low:
        return low
    if value >= high:
        return high
    return int(round(value))


def _encode_channel_samples(audio: Audio) -> bytes:
    low, high, scale = _LIMITS[audio.sample_width]
    quantized: list[list[int]] = []
    for channel in audio.samples:
        quantized.append([_clamp(sample * scale, low, high) for sample in channel])

    output = bytearray()
    for frame in range(audio.frames):
        for channel in range(audio.channels):
            value = quantized[channel][frame]
            if audio.sample_width == 1:
                output.append(value + 128)
            elif audio.sample_width == 2:
                output.extend(struct.pack("<h", value))
            elif audio.sample_width == 3:
                output.extend(value.to_bytes(3, "little", signed=True))
            else:
                output.extend(struct.pack("<i", value))
    return bytes(output)


def write_wav(path: str | Path, audio: Audio) -> None:
    """Write normalized samples as integer PCM with the original bit depth."""

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    raw = _encode_channel_samples(audio)
    with wave.open(str(path), "wb") as destination:
        destination.setnchannels(audio.channels)
        destination.setsampwidth(audio.sample_width)
        destination.setframerate(audio.sample_rate)
        destination.writeframes(raw)
