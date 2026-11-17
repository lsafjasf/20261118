"""Playback engine: WSOLA audio path + video frame scheduling."""
from __future__ import annotations
from dataclasses import dataclass

import numpy as np

from .clocks import MediaClock, SpeedSchedule, SpeedSwitcher
from .media import VideoTrack
from .wsola import WsolaStretcher


@dataclass
class FrameEvent:
    frame_id: int
    hw_seconds: float
    media_seconds: float


@dataclass
class Status:
    media_clock: float
    audio_clock: float
    delta: float
    speed: float
    frame_id: int


class Player:
    def __init__(
        self,
        audio: np.ndarray,
        video: VideoTrack,
        device,
        sample_rate: int = 44100,
        speeds=(0.5, 0.75, 1.0, 1.25, 1.5, 2.0),
        switch_interval: float = 5.0,
        switch_clock=None,
    ) -> None:
        self.audio = np.asarray(audio, dtype=np.float64)
        self.video = video
        self.device = device
        self.sample_rate = sample_rate
        self.block = device.block

        self.stretcher = WsolaStretcher(sample_rate)
        self.schedule = SpeedSchedule(sample_rate)
        self.media_clock = MediaClock(self.schedule, device.clock)
        self.switcher = SpeedSwitcher(
            list(speeds), switch_interval,
            clock=switch_clock or (lambda: device.wall_time),
        )
        self._feed_pos = 0
        self._feed_final = False
        self._frame_id = -1
        self.frame_events: list[FrameEvent] = []
        self.rendered: list[np.ndarray] = []
        self.keep_audio = False  # tests opt in to storing rendered audio

    def set_speed(self, speed: float) -> None:
        """Anchor the rate change at the current output sample."""
        self.stretcher.set_speed(speed)
        self.schedule.set_speed(speed, self.device.clock.samples_consumed)

    def status(self) -> Status:
        media = self.media_clock.seconds
        hw = self.device.clock.seconds
        return Status(media, hw, media - hw,
                      self.schedule.current_speed, self._frame_id)

    def _feed(self) -> None:
        lead = int(2.0 * self.sample_rate)
        while (not self._feed_final
               and self.stretcher.buffered_ahead() < lead
               and self._feed_pos < len(self.audio)):
            end = min(self._feed_pos + self.sample_rate, len(self.audio))
            self._feed_final = end >= len(self.audio)
            self.stretcher.feed(self.audio[self._feed_pos:end],
                                final=self._feed_final)
            self._feed_pos = end
        if not self._feed_final and self._feed_pos >= len(self.audio):
            self._feed_final = True
            self.stretcher.feed(np.zeros(0), final=True)

    def step(self) -> bool:
        """Render one audio block and schedule video. False when done."""
        self.switcher.maybe_switch(self.set_speed)
        self._feed()
        out = self.stretcher.pull(self.block)
        self.device.consume(len(out))
        if self.keep_audio:
            self.rendered.append(out.copy())
        media_t = self.media_clock.seconds
        frame = self.video.frame_at(media_t)
        if frame != self._frame_id:
            self._frame_id = frame
            self.frame_events.append(
                FrameEvent(frame, self.device.clock.seconds, media_t))
        duration = self.video.frame_count / self.video.fps
        return media_t < duration

    def run(self, on_status=None, status_every: int = 50) -> None:
        n = 0
        while self.step():
            n += 1
            if on_status and n % status_every == 0:
                on_status(self.status())
