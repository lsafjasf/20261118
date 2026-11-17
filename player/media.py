"""Synthetic test media: continuous speech, beat track, video frames."""

from __future__ import annotations

import numpy as np


def speech_track(sample_rate: int, duration: float, seed: int = 7) -> np.ndarray:
    """Continuous speech-like signal: chained syllables and words."""
    rng = np.random.default_rng(seed)
    total = int(duration * sample_rate)
    out = np.zeros(total)
    pos = 0
    while pos < total:
        n_syll = int(rng.integers(2, 6))
        for _ in range(n_syll):
            syll_len = int(rng.uniform(0.09, 0.22) * sample_rate)
            syll_len = min(syll_len, total - pos)
            if syll_len <= 0:
                break
            t = np.arange(syll_len) / sample_rate
            f0 = rng.uniform(95, 180)
            phase = 2 * np.pi * (f0 * t + 3 * np.sin(2 * np.pi * 5 * t))
            sig = np.zeros(syll_len)
            for h, amp in ((1, 1.0), (2, 0.55), (3, 0.35), (4, 0.2), (5, 0.12)):
                sig += amp * np.sin(h * phase)
            sig *= 0.6 + 0.4 * np.sin(2 * np.pi * rng.uniform(1, 3) * t)
            env = np.sin(np.pi * np.arange(syll_len) / syll_len) ** 1.5
            out[pos : pos + syll_len] += 0.35 * sig * env
            pos += syll_len + int(rng.uniform(0.02, 0.07) * sample_rate)
        pos += int(rng.uniform(0.08, 0.25) * sample_rate)
    return out


def beat_track(sample_rate: int, duration: float, bpm: float = 120.0) -> np.ndarray:
    """Metronome: short clicks on every beat, accented downbeats."""
    total = int(duration * sample_rate)
    out = np.zeros(total)
    period = 60.0 / bpm
    click_len = int(0.02 * sample_rate)
    t = np.arange(click_len) / sample_rate
    beat = 0
    while True:
        start = int(beat * period * sample_rate)
        if start + click_len >= total:
            break
        freq = 2000.0 if beat % 4 == 0 else 1000.0
        amp = 0.9 if beat % 4 == 0 else 0.6
        click = amp * np.sin(2 * np.pi * freq * t) * np.exp(-t * 250)
        out[start : start + click_len] += click
        beat += 1
    return out


class VideoTrack:
    """Equally spaced frames identified by index."""

    def __init__(self, fps: float, duration: float):
        self.fps = fps
        self.frame_count = int(duration * fps)

    def frame_at(self, media_time: float) -> int:
        idx = int(media_time * self.fps)
        return min(max(idx, 0), self.frame_count - 1)
