"""High-level drift analysis and correction workflow."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

from .dsp import (
    OffsetPoint,
    cents_difference,
    cross_correlation,
    dominant_frequency,
    estimate_offsets,
    fit_drift,
    resample_channels,
)
from .wavio import read_wav, to_mono, write_wav


@dataclass
class DriftResult:
    rate: int
    points: list[OffsetPoint]
    slope: float
    intercept: float
    residual_rms_seconds: float
    confidence_mean: float
    resample_ratio: float
    estimated_actual_rate: float
    relative_rate_ppm: float

    @property
    def slope_ppm_per_second(self) -> float:
        return self.slope * 1_000_000.0


def analyze_signals(
    reference: list[float],
    candidate: list[float],
    rate: int,
    window_seconds: float = 0.5,
    max_lag_seconds: float = 0.05,
    point_count: int = 12,
) -> DriftResult:
    points = estimate_offsets(
        reference,
        candidate,
        rate,
        window_seconds,
        max_lag_seconds,
        point_count,
    )
    slope, intercept, points = fit_drift(points)
    residuals = [
        point.offset - (intercept + slope * point.time)
        for point in points
        if point.inlier
    ]
    residual_rms = math.sqrt(sum(value * value for value in residuals) / len(residuals))
    ratio = 1.0 + slope
    actual_rate = rate / ratio
    return DriftResult(
        rate=rate,
        points=points,
        slope=slope,
        intercept=intercept,
        residual_rms_seconds=residual_rms,
        confidence_mean=sum(point.confidence for point in points) / len(points),
        resample_ratio=ratio,
        estimated_actual_rate=actual_rate,
        relative_rate_ppm=(actual_rate / rate - 1.0) * 1_000_000.0,
    )


def analyze_files(reference_path: str, candidate_path: str, **kwargs) -> DriftResult:
    reference_channels, reference_rate = read_wav(reference_path)
    candidate_channels, candidate_rate = read_wav(candidate_path)
    if reference_rate != candidate_rate:
        raise ValueError("input WAV files must declare the same nominal sample rate")
    reference = to_mono(reference_channels)
    candidate = to_mono(candidate_channels)
    return analyze_signals(reference, candidate, reference_rate, **kwargs)


def correct_result(
    candidate_path: str,
    output_path: str,
    result: DriftResult,
) -> tuple[list[list[float]], int]:
    channels, rate = read_wav(candidate_path)
    if rate != result.rate:
        raise ValueError("candidate sample rate does not match analysis result")
    offset_samples = result.intercept * rate
    ratio = result.resample_ratio
    if not 0.2 < ratio < 5.0:
        raise ValueError("estimated resampling ratio is outside a safe range")
    last_position = offset_samples + (len(channels[0]) - 1) * ratio
    target_length = max(1, int(math.floor(last_position)) + 1)
    corrected = resample_channels(channels, target_length, ratio, offset_samples)
    write_wav(output_path, corrected, rate)
    reference_start = max(0, int(round(offset_samples)))
    return corrected, reference_start


def local_offset(
    reference: list[float],
    candidate: list[float],
    rate: int,
    center_seconds: float,
    window_seconds: float = 0.5,
    max_lag_seconds: float = 0.05,
) -> tuple[float, float]:
    length = min(
        int(window_seconds * rate),
        min(len(reference), len(candidate)),
    )
    half = length // 2
    center = min(
        max(half, int(center_seconds * rate)),
        min(len(reference), len(candidate)) - half - 1,
    )
    start = center - half
    end = start + length
    max_lag = min(int(max_lag_seconds * rate), length // 3)
    lag, score = cross_correlation(
        reference[start:end], candidate[start:end], max_lag
    )
    return lag / rate, score


def aligned_rms_error(reference: list[float], candidate: list[float]) -> float:
    length = min(len(reference), len(candidate))
    return math.sqrt(
        sum(
            (reference[index] - candidate[index]) ** 2
            for index in range(length)
        )
        / length
    )


def make_test_signals(
    rate: int = 24000,
    seconds: float = 8.0,
    drift_factor: float = 1.0005,
) -> tuple[list[float], list[float]]:
    length = int(rate * seconds)
    rng = random.Random(20261118)
    delayed_rng = random.Random(991733)
    warm_noise = [delayed_rng.random() * 2.0 - 1.0 for _ in range(64)]
    reference = []
    fade = min(rate // 10, length // 10)
    for index in range(length):
        time = index / rate
        warm_noise.append(rng.random() * 2.0 - 1.0)
        broadband = 0.82 * sum(warm_noise[-64:]) / 64.0
        chirp = 0.08 * math.sin(
            2.0 * math.pi * (180.0 * time + 35.0 * time * time / seconds)
        )
        tone = (
            0.20 * math.sin(2.0 * math.pi * 220.0 * time)
            + 0.05 * math.sin(2.0 * math.pi * 440.0 * time)
        )
        envelope = min(1.0, index / fade, (length - 1 - index) / fade)
        reference.append((broadband + chirp + tone) * envelope)

    target_length = int(math.floor((length - 1) / drift_factor)) + 1
    from .dsp import resample_channel

    drifted = resample_channel(
        reference, target_length, drift_factor, offset=0.0, half_taps=12
    )
    return reference, drifted


def pitch_metrics(
    reference: list[float],
    candidate: list[float],
    rate: int,
    expected_frequency: float = 220.0,
) -> dict[str, float]:
    reference_pitch = dominant_frequency(reference, rate)
    candidate_pitch = dominant_frequency(candidate, rate)
    return {
        "reference_frequency": reference_pitch,
        "candidate_frequency": candidate_pitch,
        "expected_frequency": expected_frequency,
        "candidate_cents_from_expected": cents_difference(
            candidate_pitch, expected_frequency
        ),
        "corrected_cents_from_reference": cents_difference(
            candidate_pitch, reference_pitch
        ),
    }
