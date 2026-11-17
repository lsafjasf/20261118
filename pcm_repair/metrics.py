"""Error and repair coverage metrics."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import log10, sqrt

from .audio import Audio
from .detector import RepairResult


@dataclass(frozen=True)
class ErrorMetrics:
    max_error: float
    max_error_dbfs: float
    max_error_lsb: float
    rms_error: float
    max_error_in_repairs: float
    max_error_in_repairs_dbfs: float
    max_error_in_repairs_lsb: float
    max_correction: float


def _dbfs(value: float) -> float:
    return 20.0 * log10(max(value, 1.0e-12))


def compare_audio(
    reference: Audio,
    actual: Audio,
    result: RepairResult | None = None,
    before: Audio | None = None,
) -> ErrorMetrics:
    """Compare a repaired signal to a clean reference.

    If ``result`` and ``before`` are supplied, errors and corrections are
    also restricted to sample values that were actually changed.
    """

    if (
        reference.sample_rate != actual.sample_rate
        or reference.channels != actual.channels
        or reference.frames != actual.frames
    ):
        raise ValueError("reference and repaired audio must have identical format and length")

    maximum = 0.0
    squared_total = 0.0
    sample_total = 0
    for expected_channel, actual_channel in zip(reference.samples, actual.samples):
        for expected, observed in zip(expected_channel, actual_channel):
            error = observed - expected
            maximum = max(maximum, abs(error))
            squared_total += error * error
            sample_total += 1
    rms = sqrt(squared_total / sample_total)
    scale = float(1 << (8 * reference.sample_width - 1))

    max_in_repairs = 0.0
    max_correction = 0.0
    if result is not None and before is not None:
        for channel, start, end in result.channel_intervals:
            expected_channel = reference.samples[channel]
            actual_channel = actual.samples[channel]
            before_channel = before.samples[channel]
            for frame in range(start, end):
                max_in_repairs = max(
                    max_in_repairs,
                    abs(actual_channel[frame] - expected_channel[frame]),
                )
                max_correction = max(
                    max_correction,
                    abs(actual_channel[frame] - before_channel[frame]),
                )

    return ErrorMetrics(
        max_error=maximum,
        max_error_dbfs=_dbfs(maximum),
        max_error_lsb=maximum * scale,
        rms_error=rms,
        max_error_in_repairs=max_in_repairs,
        max_error_in_repairs_dbfs=_dbfs(max_in_repairs),
        max_error_in_repairs_lsb=max_in_repairs * scale,
        max_correction=max_correction,
    )


def result_payload(result: RepairResult) -> dict[str, object]:
    rate = result.audio.sample_rate
    intervals = [
        {
            "index": index,
            "start_frame": interval.start,
            "end_frame": interval.end,
            "start_s": interval.start / rate,
            "end_s": interval.end / rate,
            "frames": interval.frames,
            "channels": list(interval.channels),
        }
        for index, interval in enumerate(result.intervals, start=1)
    ]
    return {
        "interval_count": result.interval_count,
        "modified_frames": result.modified_frames,
        "repaired_sample_values": result.sample_changes,
        "candidate_groups": result.candidate_groups,
        "rejected_percussive_groups": result.rejected_percussive_groups,
        "rejected_long_groups": result.rejected_long_groups,
        "intervals": intervals,
    }


def metrics_payload(metrics: ErrorMetrics) -> dict[str, float]:
    return asdict(metrics)
