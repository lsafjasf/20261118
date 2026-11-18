"""FFT-based delay estimation, drift fitting, and resampling."""

from __future__ import annotations

import math
from dataclasses import dataclass


def next_power_of_two(value: int) -> int:
    size = 1
    while size < value:
        size <<= 1
    return size


def fft(values: list[complex], invert: bool = False) -> None:
    count = len(values)
    if count & (count - 1):
        raise ValueError("FFT requires a power-of-two length")

    bit_reversed = 0
    for index in range(1, count):
        bit = count >> 1
        while bit_reversed & bit:
            bit_reversed ^= bit
            bit >>= 1
        bit_reversed ^= bit
        if index < bit_reversed:
            values[index], values[bit_reversed] = values[bit_reversed], values[index]

    length = 2
    sign = -2.0 if invert else 2.0
    while length <= count:
        angle = sign * math.pi / length
        root = math.cos(angle) + 1j * math.sin(angle)
        half = length // 2
        for start in range(0, count, length):
            twiddle = 1.0 + 0.0j
            for offset in range(half):
                left = values[start + offset]
                right = values[start + offset + half] * twiddle
                values[start + offset] = left + right
                values[start + offset + half] = left - right
                twiddle *= root
        length <<= 1

    if invert:
        inverse = 1.0 / count
        for index in range(count):
            values[index] *= inverse


def _hann(length: int) -> list[float]:
    if length == 1:
        return [1.0]
    return [
        0.5 - 0.5 * math.cos(2.0 * math.pi * index / (length - 1))
        for index in range(length)
    ]


def _prefix_energy(values: list[float]) -> list[float]:
    prefix = [0.0]
    total = 0.0
    for value in values:
        total += value * value
        prefix.append(total)
    return prefix


def cross_correlation(
    left: list[float],
    right: list[float],
    max_lag: int,
    use_window: bool = True,
) -> tuple[float, float]:
    """Return (lag in right relative to left, normalized peak score)."""
    if len(left) != len(right):
        raise ValueError("cross-correlation inputs must have equal lengths")
    length = len(left)
    if max_lag >= length:
        raise ValueError("max_lag must be smaller than the analysis length")

    window = _hann(length) if use_window else [1.0] * length
    x = [left[i] * window[i] for i in range(length)]
    y = [right[i] * window[i] for i in range(length)]
    fft_size = next_power_of_two(2 * length - 1)
    spectrum_x = [complex(value, 0.0) for value in x] + [0.0j] * (fft_size - length)
    spectrum_y = [complex(value, 0.0) for value in y] + [0.0j] * (fft_size - length)
    fft(spectrum_x)
    fft(spectrum_y)
    correlated = [spectrum_x[i].conjugate() * spectrum_y[i] for i in range(fft_size)]
    fft(correlated, invert=True)

    energy_x = _prefix_energy(x)
    energy_y = _prefix_energy(y)
    lags = list(range(-max_lag, max_lag + 1))
    scores = []
    for lag in lags:
        if lag >= 0:
            start, end = 0, length - lag
        else:
            start, end = -lag, length
        overlap = end - start
        if overlap <= 0:
            scores.append(0.0)
            continue
        y_start = start + lag
        y_end = end + lag
        norm = math.sqrt(
            (energy_x[end] - energy_x[start])
            * (energy_y[y_end] - energy_y[y_start])
        )
        index = lag % fft_size
        scores.append(correlated[index].real / norm if norm > 0.0 else 0.0)

    peak_index = max(range(len(scores)), key=scores.__getitem__)
    peak_score = scores[peak_index]
    peak_lag = float(lags[peak_index])
    if 0 < peak_index < len(scores) - 1:
        before, after = scores[peak_index - 1], scores[peak_index + 1]
        denominator = before - 2.0 * peak_score + after
        if abs(denominator) > 1e-12:
            peak_lag += 0.5 * (before - after) / denominator
    return peak_lag, peak_score


@dataclass
class OffsetPoint:
    time: float
    offset: float
    confidence: float
    inlier: bool = True


def estimate_offsets(
    reference: list[float],
    candidate: list[float],
    rate: int,
    window_seconds: float = 0.5,
    max_lag_seconds: float = 0.05,
    point_count: int = 12,
) -> list[OffsetPoint]:
    minimum_length = min(len(reference), len(candidate))
    requested = min(int(window_seconds * rate), minimum_length)
    window = 1 << (max(64, requested) - 1).bit_length()
    while window > minimum_length and window > 64:
        window >>= 1
    if window < 64:
        raise ValueError("audio is too short for short-time correlation")
    max_lag = min(int(max_lag_seconds * rate), window // 3)
    if max_lag < 1:
        raise ValueError("audio is too short for the configured maximum lag")

    half = window // 2
    first_center = half + max_lag
    last_center = minimum_length - half - max_lag - 1
    if last_center <= first_center:
        first_center = half
        last_center = minimum_length - half - 1
    if last_center <= first_center:
        raise ValueError("audio is too short for short-time correlation")

    points = []
    count = max(2, point_count)
    for index in range(count):
        center = round(
            first_center + (last_center - first_center) * index / (count - 1)
        )
        start = center - half
        end = start + window
        lag, score = cross_correlation(
            reference[start:end], candidate[start:end], max_lag
        )
        points.append(OffsetPoint(center / rate, lag / rate, score))
    return points


def linear_fit(times: list[float], values: list[float]) -> tuple[float, float]:
    count = len(times)
    mean_t = sum(times) / count
    mean_v = sum(values) / count
    numerator = sum((t - mean_t) * (v - mean_v) for t, v in zip(times, values))
    denominator = sum((t - mean_t) ** 2 for t in times)
    slope = numerator / denominator
    intercept = mean_v - slope * mean_t
    return slope, intercept


def fit_drift(points: list[OffsetPoint]) -> tuple[float, float, list[OffsetPoint]]:
    times = [point.time for point in points]
    offsets = [point.offset for point in points]
    slope, intercept = linear_fit(times, offsets)
    residuals = [offset - (intercept + slope * time) for time, offset in zip(times, offsets)]
    median_residual = sorted(residuals)[len(residuals) // 2]
    mad = sorted(abs(value - median_residual) for value in residuals)
    mad_value = mad[len(mad) // 2] or 1e-6
    threshold = max(2.0e-5, 3.0 * 1.4826 * mad_value)

    inliers = [
        OffsetPoint(point.time, point.offset, point.confidence, abs(residual) <= threshold)
        for point, residual in zip(points, residuals)
    ]
    kept = [point for point in inliers if point.inlier]
    if len(kept) >= max(3, int(0.6 * len(points))):
        slope, intercept = linear_fit(
            [point.time for point in kept], [point.offset for point in kept]
        )
    return slope, intercept, inliers


def resample_channel(
    signal: list[float],
    target_length: int,
    ratio: float,
    offset: float = 0.0,
    half_taps: int = 16,
) -> list[float]:
    cutoff = min(0.92, 0.92 / ratio)
    support = half_taps / cutoff
    output = [0.0] * target_length
    for output_index in range(target_length):
        position = offset + output_index * ratio
        first = max(0, math.ceil(position - support))
        last = min(len(signal) - 1, math.floor(position + support))
        numerator = 0.0
        denominator = 0.0
        for source_index in range(first, last + 1):
            distance = (source_index - position) * cutoff
            if abs(distance) >= half_taps:
                continue
            sinc = 1.0 if abs(distance) < 1e-12 else math.sin(math.pi * distance) / (
                math.pi * distance
            )
            window = 0.5 + 0.5 * math.cos(math.pi * distance / half_taps)
            weight = cutoff * sinc * window
            numerator += signal[source_index] * weight
            denominator += weight
        output[output_index] = numerator / denominator if denominator else 0.0
    return output


def resample_channels(
    channels: list[list[float]],
    target_length: int,
    ratio: float,
    offset: float = 0.0,
) -> list[list[float]]:
    return [
        resample_channel(channel, target_length, ratio, offset)
        for channel in channels
    ]


def dominant_frequency(signal: list[float], rate: int) -> float:
    fft_length = 1 << ((len(signal) - 1).bit_length() - 1)
    usable = signal[:fft_length]
    window = _hann(len(usable))
    spectrum = [complex(value * window[i], 0.0) for i, value in enumerate(usable)]
    fft(spectrum)
    peak = max(range(1, len(spectrum) // 2), key=lambda i: abs(spectrum[i]))
    return peak * rate / len(spectrum)


def cents_difference(measured: float, reference: float) -> float:
    return 1200.0 * math.log2(measured / reference)
