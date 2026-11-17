"""Media clock, audio hardware clock and speed scheduling."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class SpeedSchedule:
    """Piecewise-constant playback-speed timeline on the output axis."""

    sample_rate: int
    _segments: list[tuple[int, float]] = field(default_factory=list)
    _current: float = 1.0

    @property
    def current_speed(self) -> float:
        return self._current

    def set_speed(self, speed: float, at_output_sample: int) -> None:
        self._segments.append((at_output_sample, self._current))
        self._current = float(speed)

    def media_time_at(self, output_sample: int) -> float:
        """Media (content) seconds corresponding to an output sample."""
        media = 0.0
        prev = 0
        for at, speed in self._segments:
            if output_sample <= at:
                media += (output_sample - prev) * speed / self.sample_rate
                return media
            media += (at - prev) * speed / self.sample_rate
            prev = at
        media += (output_sample - prev) * self._current / self.sample_rate
        return media


class AudioHardwareClock:
    """Sample-counter view of the audio device, in seconds of audio."""

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.samples_consumed = 0

    def advance(self, samples: int) -> None:
        self.samples_consumed += samples

    @property
    def seconds(self) -> float:
        return self.samples_consumed / self.sample_rate


class MediaClock:
    """Content position, derived from the audio clock + speed schedule."""

    def __init__(self, schedule: SpeedSchedule, hw: AudioHardwareClock) -> None:
        self.schedule = schedule
        self.hw = hw

    @property
    def seconds(self) -> float:
        return self.schedule.media_time_at(self.hw.samples_consumed)


class SpeedSwitcher:
    """Changes speed on a fixed wall-clock interval (e.g. every 5 s)."""

    def __init__(self, speeds: list[float], interval: float = 5.0, clock=time.monotonic) -> None:
        if not speeds:
            raise ValueError("need at least one speed")
        if not all(0.5 <= s <= 2.0 for s in speeds):
            raise ValueError("speeds must stay within 0.5x..2.0x")
        self.speeds = list(speeds)
        self.interval = interval
        self._clock = clock
        self._index = 0
        self._next_switch = clock() + interval

    def maybe_switch(self, apply) -> float | None:
        """Call apply(new_speed) when the interval elapsed."""
        now = self._clock()
        if now < self._next_switch:
            return None
        self._index = (self._index + 1) % len(self.speeds)
        speed = self.speeds[self._index]
        apply(speed)
        self._next_switch = now + self.interval
        return speed
