"""Loop seam analysis with cached, calibrated metrics.

A seam at sample ``s`` loops ``x[:s]`` back to sample 0. The two sides are
different parts of the phrase, so raw amplitude differences are meaningless.
Each metric is instead calibrated against natural interior beat boundaries:

  - waveform: derivative (first-difference) level across the wrap;
  - spectrum: phase discontinuity of the adjacent STFT frames at the wrap;
  - transients: onset-energy break relative to the head of the phrase.

Healthy seams score near the interior baseline; length errors produce large
ratios. ``SeamAnalyzer`` precomputes every expensive transform once so that
sample-exact searches run in milliseconds.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy import signal


@dataclass
class SeamReport:
    seam_sample: int
    sample_diff_rms: float
    sample_diff_peak: float
    phase_jump_rad: float
    phase_coherence: float
    transient_break: float
    left_rms: float
    right_rms: float
    combined_cost: float

    def to_dict(self) -> dict:
        return asdict(self)


def _to_mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=1) if x.ndim == 2 else x


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2) + 1e-20))


def onset_envelope(x: np.ndarray, sr: int, hop: int = 512
                   ) -> tuple[np.ndarray, int]:
    """Half-wave rectified spectral-flux onset envelope."""
    mono = _to_mono(x)
    n_fft = 2048
    frames = np.abs(
        signal.stft(mono, fs=sr, nperseg=n_fft, noverlap=n_fft - hop,
                    boundary="zeros", padded=True)[2]
    )
    flux = np.diff(frames, axis=1, prepend=frames[:, :1])
    flux = np.maximum(flux, 0.0).sum(axis=0)
    flux /= (np.max(flux) + 1e-12)
    return flux, hop


def estimate_beat_period(x: np.ndarray, sr: int) -> tuple[int, float]:
    """Estimate beat period at sample resolution via signal autocorrelation.

    The onset envelope only has hop-size resolution, so its lag is biased by
    up to half a hop. Autocorrelating the onset *signal* (spectral flux placed
    at sample positions) gives a sharp, sub-sample-interpolated peak.
    """
    mono = _to_mono(x).astype(np.float64)
    # Sample-resolution RMS envelope (10 ms windows, 1 ms hop), upsampled
    # back to sample positions so autocorrelation peaks are not hop-quantized.
    win = max(8, int(0.01 * sr))
    squared = mono ** 2
    kernel = np.ones(win) / win
    rms_env = np.sqrt(np.convolve(squared, kernel, mode="same") + 1e-20)
    centered = rms_env - rms_env.mean()
    ac = signal.correlate(centered, centered, mode="full")[centered.size - 1:]
    # Restrict to 67-200 BPM so neither half-beat nor 2-beat octaves win.
    min_lag = int(60.0 / 200.0 * sr)
    max_lag = min(int(60.0 / 67.0 * sr), ac.size - 2)
    search = ac[min_lag:max_lag]
    lag = min_lag + int(np.argmax(search))
    a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
    denom = a - 2 * b + c
    shift = 0.5 * (a - c) / denom if abs(denom) > 1e-15 else 0.0
    period = lag + shift
    bpm = 60.0 * sr / period
    return int(round(period)), float(bpm)


class SeamAnalyzer:
    """Reusable analyzer with all transforms precomputed once."""

    def __init__(self, x: np.ndarray, sr: int, n_fft: int = 2048,
                 hop: int = 512):
        self.mono = _to_mono(x).astype(np.float64)
        self.sr = sr
        self.n_fft = n_fft
        self.hop = hop
        self.n = self.mono.size
        self.beat_samples, self.bpm = estimate_beat_period(self.mono, sr)
        self._precompute()

    def _precompute(self) -> None:
        n_fft, hop = self.n_fft, self.hop
        win = signal.windows.hann(n_fft)
        # One STFT of the whole material; frames are reused at every seam.
        _, _, stft = signal.stft(
            self.mono, fs=self.sr, nperseg=n_fft, noverlap=n_fft - hop,
            boundary=None, padded=False)
        self.spec = stft
        self.frame_centers = (np.arange(stft.shape[1]) * hop).astype(int)
        self.win = win

        self.env, _ = onset_envelope(self.mono, self.sr, hop)
        self.span = max(2, int(0.06 * self.sr / hop))

        self.steps = np.diff(self.mono)
        self.step_rms = float(np.sqrt(np.mean(self.steps ** 2) + 1e-20))
        self._baseline()

    def _phase_at_frames(self, left_frame: int, right_frame: int
                         ) -> tuple[float, float]:
        fl = self.spec[:, max(0, left_frame)]
        fr = self.spec[:, max(0, right_frame)]
        mag = np.abs(fl) * np.abs(fr)
        if mag.sum() < 1e-12:
            return 0.0, 1.0
        dphi = np.angle(fl * np.conj(fr))
        weights = mag / mag.sum()
        jump = float(np.sqrt(np.sum(weights * dphi ** 2)))
        coherence = float(np.abs(np.sum(weights * np.exp(1j * dphi))))
        return jump, coherence

    def _frame_at(self, sample: int) -> int:
        return int(np.argmin(np.abs(self.frame_centers - sample)))

    def _transient_at(self, frame: int) -> float:
        lo, hi = max(0, frame - self.span), min(self.env.size,
                                                 frame + self.span + 1)
        left_energy = float(self.env[lo:frame + 1].sum())
        right_energy = float(self.env[frame:hi].sum())
        return abs(left_energy - right_energy) / (
            left_energy + right_energy + 1e-9)

    def _seam_transient(self, seam: int) -> float:
        """Onset asymmetry between the tail and head windows of a seam.

        A well-formed loop boundary sits between phrases, so the onset energy
        in the final beat window should resemble that of the opening beat
        window. A dropped or duplicated beat makes the two sides unequal.
        """
        frame = max(1, seam // self.hop)
        tail = self.env[max(0, frame - self.span):frame]
        head = self.env[1:1 + tail.size]
        e_tail = float(tail.sum()) + 1e-12
        e_head = float(head.sum()) + 1e-12
        return abs(e_tail - e_head) / (e_tail + e_head)

    def _baseline(self) -> None:
        centers = np.arange(self.beat_samples,
                            self.n - self.n_fft, self.beat_samples)
        jumps, coherences, transients, peaks = [], [], [], []
        head_phase_frame = self._frame_at(self.n_fft // 2)
        for center in centers:
            frame = self._frame_at(center)
            jump, coh = self._phase_at_frames(frame - 1, frame)
            jumps.append(jump)
            coherences.append(coh)
            transients.append(self._transient_at(frame))
            peaks.append(abs(self.mono[center] - self.mono[center - 1])
                         / self.step_rms)
        self.base = {
            "step_rms": self.step_rms,
            "phase_jump": float(np.median(jumps)) + 1e-9,
            "coherence": float(np.median(coherences)) + 1e-9,
            "transient": float(np.median(transients)) + 1e-9,
            "peak": float(np.median(peaks)) + 1e-6,
            "head_phase_frame": head_phase_frame,
        }
        self.head_transient = self._transient_at(0)
        # Interior reference for seam-style tail/head onset asymmetry.
        ref = [self._seam_transient(int(c))
               for c in np.arange(self.beat_samples,
                                  self.n - self.n_fft, self.beat_samples)]
        self.base["seam_transient"] = float(np.median(ref)) + 1e-9

    def evaluate(self, seam: int, window: int | None = None) -> SeamReport:
        """Calibrated wrap-continuity report at ``x[seam-1] -> x[0]``."""
        if not 1 <= seam <= self.n:
            raise ValueError("seam must lie within [1, n]")
        n_fft = min(self.n_fft, seam, self.n // 4)
        window = min(max(n_fft, window or 0), seam, self.n // 4)

        left = self.mono[seam - n_fft:seam]
        right = self.mono[:n_fft]
        left_rms, right_rms = _rms(left), _rms(right)

        wrap_steps = np.concatenate([
            np.diff(self.mono[seam - window:seam]),
            np.array([self.mono[0] - self.mono[seam - 1]]),
            np.diff(self.mono[:window]),
        ])
        sample_rms = float(np.sqrt(np.mean(wrap_steps ** 2) + 1e-20)
                           / self.base["step_rms"])
        sample_peak = float(abs(self.mono[0] - self.mono[seam - 1])
                            / self.base["step_rms"])

        tail_frame = self._frame_at(seam - n_fft // 2)
        head_frame = self.base["head_phase_frame"]
        phase_raw, coherence_raw = self._phase_at_frames(tail_frame, head_frame)
        phase_jump = phase_raw / self.base["phase_jump"]
        coherence_loss = max(0.0, self.base["coherence"] - coherence_raw) / (
            self.base["coherence"])

        transient_break = self._seam_transient(seam) / (
            self.base["seam_transient"])

        # The boundary sample jump is the primary click detector; phase and
        # transient terms capture sub-sample and beat-grid defects.
        cost = float(0.4 * np.clip(sample_rms, 0, 8)
                     + 1.0 * np.clip(sample_peak, 0, 40)
                     + 1.5 * np.clip(phase_jump, 0, 6)
                     + 2.0 * np.clip(coherence_loss, 0, 1)
                     + 1.2 * np.clip(transient_break, 0, 6))
        return SeamReport(seam, sample_rms, sample_peak, phase_jump,
                          1.0 - coherence_loss, transient_break,
                          left_rms, right_rms, cost)

    def scan(self, seams, top_k: int = 10) -> list[SeamReport]:
        reports = [self.evaluate(int(s)) for s in np.atleast_1d(
            np.asarray(list(seams)))]
        reports.sort(key=lambda r: r.combined_cost)
        return reports[:top_k]

    def best_beat_aligned(self, lookback_beats: int = 2
                          ) -> tuple[SeamReport, int, float]:
        """Best seam on the head-referenced quarter-beat grid near the end.

        A looping seam must be in phase with the phrase opening, so candidate
        positions are multiples of the quarter-beat period measured from
        sample 0, not an arbitrary end-anchored grid.
        """
        quarter = max(1, self.beat_samples // 4)
        first = self.n - lookback_beats * self.beat_samples
        k0 = int(np.ceil(max(quarter, first) / quarter))
        k1 = int(self.n // quarter)
        seams = np.arange(k0, k1 + 1) * quarter
        return self.scan(seams, top_k=1)[0], self.beat_samples, self.bpm

    def refine_around(self, center: int, radius: int | None = None
                      ) -> SeamReport:
        """Grid search near ``center``, then zero-jump micro-adjustment.

        Only head-referenced quarter-beat positions are valid musical loop
        lengths. After the best such point is chosen, it may be nudged by a
        handful of samples to land on the exact waveform zero-crossing.
        """
        if radius is None:
            radius = self.beat_samples // 2
        quarter = max(1, self.beat_samples // 4)
        lo = max(self.n_fft + 1, center - radius)
        hi = min(self.n, center + radius)
        k0 = int(np.ceil(lo / quarter))
        k1 = int(hi // quarter)
        grid_reports = self.scan(np.arange(k0, k1 + 1) * quarter, top_k=1)
        grid_best = grid_reports[0]

        # Only nudge when the grid seam itself is already clean; otherwise
        # the nearby zero-crossing is an accidental silence, not a valid
        # loop length, and the caller should crossfade the grid seam.
        if grid_best.sample_diff_peak <= 1.0:
            relax = max(8, self.beat_samples // 256)
            g = grid_best.seam_sample
            micro = [self.evaluate(int(s)) for s in
                     range(max(lo, g - relax), min(hi, g + relax) + 1)]
            zero = [m for m in micro if m.sample_diff_peak <= 1e-6]
            if zero:
                # Anchor to the exact grid point whenever it is itself clean.
                exact = self.evaluate(g)
                if exact.sample_diff_peak <= 1e-6:
                    return exact
                return min(zero, key=lambda m: abs(m.seam_sample - g))
            return grid_best
        return grid_best


_ANALYZERS: dict[int, SeamAnalyzer] = {}


def _analyzer(x: np.ndarray, sr: int) -> SeamAnalyzer:
    key = id(x)
    cached = _ANALYZERS.get(key)
    if cached is None or cached.n != x.shape[0]:
        cached = SeamAnalyzer(x, sr)
        _ANALYZERS[key] = cached
    return cached


def evaluate_seam(x: np.ndarray, sr: int, seam: int,
                  window: int | None = None,
                  beat_samples: int | None = None) -> SeamReport:
    return _analyzer(x, sr).evaluate(seam, window)


def scan_offsets(x: np.ndarray, sr: int, seams, top_k: int = 10,
                 window: int | None = None) -> list[SeamReport]:
    return _analyzer(x, sr).scan(seams, top_k)


def best_beat_aligned(x: np.ndarray, sr: int
                      ) -> tuple[SeamReport, int, float]:
    return _analyzer(x, sr).best_beat_aligned()


def refine_around(x: np.ndarray, sr: int, center: int,
                  radius: int | None = None) -> SeamReport:
    return _analyzer(x, sr).refine_around(center, radius)
