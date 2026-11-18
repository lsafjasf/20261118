"""WAV 读写：仅依赖标准库 wave/audioop，输出归一化 float 单声道信号。"""

from __future__ import annotations

import math
import wave


def _decode_pcm(raw: bytes, sampwidth: int, channels: int) -> list[int]:
    """PCM 字节 -> 每帧各声道整数列表的扁平化序列。"""
    values: list[int] = []
    frame_width = sampwidth * channels
    for offset in range(0, len(raw) - frame_width + 1, frame_width):
        for channel in range(channels):
            pos = offset + channel * sampwidth
            chunk = raw[pos:pos + sampwidth]
            if sampwidth == 1:
                values.append(chunk[0] - 128)
                continue
            value = int.from_bytes(chunk, "little",
                                   signed=sampwidth in (2, 3, 4))
            if sampwidth == 3:
                value = int.from_bytes(chunk, "little", signed=True)
            values.append(value)
    return values


def _scale(value: int, sampwidth: int) -> float:
    if sampwidth == 1:
        return value / 128.0
    if sampwidth == 2:
        return value / 32768.0
    if sampwidth == 3:
        return value / 8388608.0
    return value / 2147483648.0


def read_wav(path: str) -> tuple[list[float], int]:
    """读取 wav，返回 (单声道浮点样本[-1,1], 采样率)。支持 8/16/24/32 bit PCM。"""
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    decoded = _decode_pcm(frames, sampwidth, channels)
    frame_count = len(decoded) // channels
    samples = [0.0] * frame_count
    for frame in range(frame_count):
        mix = 0.0
        for channel in range(channels):
            mix += _scale(decoded[frame * channels + channel], sampwidth)
        samples[frame] = mix / channels
    return samples, sample_rate


def write_wav(path: str, samples: list[float], sample_rate: int) -> None:
    """把 float 样本写成 16-bit PCM 单声道 wav，含软限幅。"""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        out = bytearray()
        for value in samples:
            if value > 1.0:
                value = 1.0
            elif value < -1.0:
                value = -1.0
            integer = int(round(value * 32767.0))
            out += integer.to_bytes(2, "little", signed=True)
        wf.writeframes(bytes(out))


def rms(samples: list[float], start: int = 0, end: int | None = None) -> float:
    end = len(samples) if end is None else min(end, len(samples))
    if end <= start:
        return 0.0
    total = 0.0
    for value in samples[start:end]:
        total += value * value
    return math.sqrt(total / (end - start))
