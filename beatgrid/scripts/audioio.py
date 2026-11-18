"""Minimal WAV reader (PCM 16/24/32-bit and float) using stdlib + numpy."""

import wave

import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        width = wf.getsampwidth()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        i32 = (
            b[:, 0].astype(np.int32)
            | (b[:, 1].astype(np.int32) << 8)
            | (b[:, 2].astype(np.int32) << 16)
        )
        i32 = np.where(i32 & 0x800000, i32 - 0x1000000, i32)
        x = i32.astype(np.float64) / 8388608.0
    else:
        raise ValueError(f"unsupported sample width {width}")
    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)
    return x, sr


def downmix_peaks(x, sr, target_sr=11025):
    """Return low-rate mono signal plus block peak envelope for waveform view."""
    step = max(1, sr // target_sr)
    trimmed = x[: len(x) - len(x) % step] if len(x) % step else x
    blocks = trimmed.reshape(-1, step)
    low = blocks.mean(axis=1)
    return low, sr // step, blocks
