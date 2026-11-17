"""Streaming WSOLA time-stretcher (pitch-preserving, phase-continuous).

Speed changes only alter the analysis hop; the analysis cursor and the
output accumulator are never reset, so the output phase stays continuous
across rate switches: no gaps, no repeated words.
"""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


class WsolaStretcher:
    def __init__(
        self,
        sample_rate: int,
        channels: int = 1,
        window: int = 2048,
        hop: int = 512,
        search: int = 256,
    ) -> None:
        if window % hop or (window // hop) < 2:
            raise ValueError("window must be an integer multiple >= 2 of hop")
        self.sample_rate = sample_rate
        self.channels = channels
        self.window = window
        self.hop = hop
        self.search = search
        self.win = np.hanning(window).astype(np.float64)

        self._speed = 1.0
        self._in = np.zeros((0, channels))
        self._in_start = 0            # absolute index of _in[0]
        self._in_final = False
        self._analysis = 0.0          # absolute input cursor (frame start)
        self._acc = np.zeros((0, channels))  # output accumulator
        self._gain = np.zeros(0)             # OLA window-gain accumulator
        self._acc_start = 0           # absolute output index of _acc[0]
        self._write = 0               # absolute output index of next frame
        self._pulled = 0              # absolute output index already returned
        self._last_k = 0              # last chosen input frame start
        # debug trace: (output_frame_start, chosen_input_start) per hop
        self.trace: list[tuple[int, int]] = []

    @property
    def speed(self) -> float:
        return self._speed

    def set_speed(self, speed: float) -> None:
        """Change rate without touching any buffered state."""
        if not 0.25 <= speed <= 4.0:
            raise ValueError("speed out of supported range")
        self._speed = float(speed)

    def feed(self, samples: np.ndarray, final: bool = False) -> None:
        samples = np.asarray(samples, dtype=np.float64)
        if samples.ndim == 1:
            samples = samples[:, None]
        self._in = np.concatenate([self._in, samples])
        self._in_final = self._in_final or final

    def buffered_ahead(self) -> int:
        """Fed-but-unconsumed input samples beyond the analysis cursor."""
        return self._in_start + len(self._in) - int(self._analysis)

    def _input_at(self, start: int, length: int) -> np.ndarray:
        """Absolute-position read, zero-padded past the fed region."""
        out = np.zeros((length, self.channels))
        lo = max(start, self._in_start)
        hi = min(start + length, self._in_start + len(self._in))
        if hi > lo:
            out[lo - start : hi - start] = self._in[
                lo - self._in_start : hi - self._in_start
            ]
        return out

    def _ensure_output(self, target: int) -> None:
        """Run WSOLA hops until `target` absolute samples are finalized."""
        overlap = self.window - self.hop
        while self._write < target:
            if self._write + self.window > self._acc_start + len(self._acc):
                grow = self._write + 2 * self.window - self._acc_start - len(self._acc)
                self._acc = np.concatenate(
                    [self._acc, np.zeros((grow, self.channels))]
                )
                self._gain = np.concatenate([self._gain, np.zeros(grow)])
            center = int(round(self._analysis))
            # never move the input cursor backwards: no repeated words
            lo = max(center - self.search, self._last_k)
            hi = center + self.search
            if not self._in_final and hi + self.window > self._in_start + len(self._in):
                break  # wait for more input
            w0 = self._write - self._acc_start
            ref_mono = self._acc[w0 : w0 + overlap].mean(axis=1)
            ref_energy = float(ref_mono @ ref_mono)
            if ref_energy < 1e-12:
                best = center
            else:
                seg = self._input_at(lo, (hi - lo) + overlap).mean(axis=1)
                cands = sliding_window_view(seg, overlap)  # (n_cand, overlap)
                num = cands @ ref_mono
                den = np.sqrt((cands * cands).sum(axis=1) * ref_energy)
                best = lo + int(np.argmax(num / np.maximum(den, 1e-12)))
            frame = self._input_at(best, self.window) * self.win[:, None]
            self._acc[w0 : w0 + self.window] += frame
            self._gain[w0 : w0 + self.window] += self.win
            self.trace.append((self._write, best))
            self._last_k = best
            self._write += self.hop
            self._analysis += self.hop * self._speed
            # discard input that can no longer be referenced
            keep_from = int(min(self._analysis, self._write) - self.window)
            drop = min(keep_from, self._in_start + len(self._in)) - self._in_start
            if drop > 0:
                self._in = self._in[drop:]
                self._in_start += drop

    def pull(self, n: int) -> np.ndarray:
        """Return exactly n finalized output samples (zeros past EOF)."""
        self._ensure_output(self._pulled + n)
        out = np.zeros((n, self.channels))
        hi = min(self._pulled + n, self._write)
        if hi > self._pulled:
            seg = self._acc[
                self._pulled - self._acc_start : hi - self._acc_start
            ]
            gain = self._gain[
                self._pulled - self._acc_start : hi - self._acc_start
            ]
            out[: hi - self._pulled] = seg / np.maximum(gain, 1e-3)[:, None]
        self._pulled += n
        if self._pulled - self._acc_start > self.window:
            cut = self._pulled - self.window - self._acc_start
            self._acc = self._acc[cut:]
            self._gain = self._gain[cut:]
            self._acc_start += cut
        return out
