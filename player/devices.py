"""Audio output device abstractions."""

from __future__ import annotations

import time

from .clocks import AudioHardwareClock


class SimulatedDevice:
    """Virtual sound card consuming fixed-size blocks deterministically."""

    def __init__(self, sample_rate: int, block: int = 1024, ppm: float = 0.0):
        self.clock = AudioHardwareClock(sample_rate)
        self.block = block
        self.ppm = ppm
        self.wall_time = 0.0  # virtual wall clock in seconds

    def consume(self, samples: int) -> None:
        self.clock.advance(samples)
        # wall time the hardware took to emit these samples
        self.wall_time += samples / self.clock.sample_rate / (1.0 + self.ppm * 1e-6)


class RealtimeNullDevice:
    """Paces consumption against the wall clock; produces no sound."""

    def __init__(self, sample_rate: int, block: int = 1024):
        self.clock = AudioHardwareClock(sample_rate)
        self.block = block
        self._start: float | None = None

    @property
    def wall_time(self) -> float:
        return time.monotonic()

    def consume(self, samples: int) -> None:
        if self._start is None:
            self._start = time.monotonic()
        self.clock.advance(samples)
        target = self._start + self.clock.seconds
        delay = target - time.monotonic()
        if delay > 0:
            time.sleep(delay)
