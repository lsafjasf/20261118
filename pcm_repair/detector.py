"""Transient pop detection and piecewise interpolation repair."""

from __future__ import annotations

from dataclasses import dataclass, field
from math import sqrt

from .audio import Audio


@dataclass(frozen=True)
class DetectionConfig:
    """Thresholds are normalized to full scale, independent of PCM bit depth."""

    noise_context_ms: float = 10.0
    min_jump: float = 0.015
    min_residual: float = 0.020
    diff_ratio: float = 10.0
    slope_ratio: float = 8.0
    energy_ratio: float = 1.5
    merge_gap_samples: int = 1
    max_repair_ms: float = 20.0
    onset_pre_ms: float = 35.0
    onset_attack_ms: float = 12.0
    onset_body_start_ms: float = 12.0
    onset_body_end_ms: float = 70.0
    onset_peak_ratio: float = 1.8
    onset_body_ratio: float = 1.20
    onset_body_floor: float = 0.004
    slope_prediction_radius: int = 6


@dataclass(frozen=True)
class RepairInterval:
    """A frame interval changed in one or more channels."""

    start: int
    end: int
    channels: tuple[int, ...]

    @property
    def frames(self) -> int:
        return self.end - self.start


@dataclass
class RepairResult:
    audio: Audio
    intervals: list[RepairInterval]
    sample_changes: int
    modified_frames: int
    candidate_groups: int = 0
    rejected_percussive_groups: int = 0
    rejected_long_groups: int = 0
    channel_intervals: list[tuple[int, int, int]] = field(default_factory=list)

    @property
    def interval_count(self) -> int:
        return len(self.intervals)


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return 0.5 * (ordered[middle - 1] + ordered[middle])


def _squared_prefix(values: list[float]) -> list[float]:
    prefix = [0.0]
    total = 0.0
    for value in values:
        total += value * value
        prefix.append(total)
    return prefix


def _window_rms(prefix: list[float], start: int, end: int) -> float:
    start = max(0, start)
    end = min(len(prefix) - 1, end)
    if end <= start:
        return 0.0
    return sqrt(max(0.0, (prefix[end] - prefix[start]) / (end - start)))


def _side_rms(prefix: list[float], center: int, width: int, guard: int) -> float:
    left = _window_rms(prefix, center - width, center - guard)
    right = _window_rms(prefix, center + guard + 1, center + width + 1)
    present = [value for value in (left, right) if value > 0.0]
    return sum(present) / len(present) if present else 0.0


def _peak(values: list[float], start: int, end: int) -> float:
    start = max(0, start)
    end = min(len(values), end)
    if end <= start:
        return 0.0
    return max(abs(value) for value in values[start:end])


def _is_percussive_onset(
    channel: list[float],
    prefix: list[float],
    start: int,
    rate: int,
    config: DetectionConfig,
) -> bool:
    """Return true for an energy rise followed by a sustained percussion body."""

    millisecond = rate / 1000.0
    pre_start = start - int(config.onset_pre_ms * millisecond)
    pre_end = start - int(2.0 * millisecond)
    attack_end = start + int(config.onset_attack_ms * millisecond)
    body_start = start + int(config.onset_body_start_ms * millisecond)
    body_end = start + int(config.onset_body_end_ms * millisecond)

    pre_rms = _window_rms(prefix, pre_start, pre_end)
    pre_peak = _peak(channel, pre_start, pre_end)
    attack_peak = _peak(channel, start, attack_end)
    body_rms = _window_rms(prefix, body_start, body_end)

    rising = attack_peak >= max(config.min_jump, pre_peak * config.onset_peak_ratio)
    sustained = body_rms >= max(
        config.onset_body_floor,
        pre_rms * config.onset_body_ratio,
    )
    return rising and sustained


def _candidate_at(
    channel: list[float],
    differences: list[float],
    energy_prefix: list[float],
    difference_prefix: list[float],
    second_prefix: list[float],
    index: int,
    rate: int,
    config: DetectionConfig,
) -> tuple[bool, dict[str, float]]:
    count = len(channel)
    radius = config.slope_prediction_radius
    if index - radius < 1 or index + radius >= count:
        return False, {}

    midpoint_predictions = [
        (channel[index - step] + channel[index + step]) * 0.5
        for step in range(1, radius + 1)
    ]
    prediction = _median(midpoint_predictions)
    residual = abs(channel[index] - prediction)
    diff_peak = max(abs(differences[index]), abs(differences[index + 1]))
    slope_break = abs(differences[index + 1] - differences[index])

    window = max(radius + 4, int(config.noise_context_ms * rate / 1000.0))
    background_rms = _side_rms(energy_prefix, index, window, radius)
    diff_floor = max(
        _side_rms(difference_prefix, index, window, radius),
        3.0 / 32768.0,
    )
    slope_floor = max(
        _side_rms(second_prefix, index, window, radius),
        3.0 / 32768.0,
    )
    energy_ratio = residual / max(background_rms, 1.0 / 32768.0)
    diff_ratio = diff_peak / diff_floor
    slope_ratio = slope_break / slope_floor

    passed = (
        diff_peak >= config.min_jump
        and residual >= config.min_residual
        and diff_ratio >= config.diff_ratio
        and slope_ratio >= config.slope_ratio
        and energy_ratio >= config.energy_ratio
    )
    features = {
        "residual": residual,
        "diff_peak": diff_peak,
        "slope_break": slope_break,
        "energy_ratio": energy_ratio,
        "diff_ratio": diff_ratio,
        "slope_ratio": slope_ratio,
    }
    return passed, features


def _group_candidates(indices: list[int], gap: int) -> list[tuple[int, int]]:
    if not indices:
        return []
    groups: list[tuple[int, int]] = []
    start = indices[0]
    end = indices[0] + 1
    for index in indices[1:]:
        if index - end <= gap:
            end = index + 1
        else:
            groups.append((start, end))
            start, end = index, index + 1
    groups.append((start, end))
    return groups


def _find_intervals(
    channel: list[float],
    rate: int,
    config: DetectionConfig,
) -> tuple[list[tuple[int, int]], int, int, int]:
    count = len(channel)
    differences = [0.0] * count
    second_differences = [0.0] * count
    for index in range(1, count):
        differences[index] = channel[index] - channel[index - 1]
    for index in range(2, count):
        second_differences[index] = differences[index] - differences[index - 1]

    energy_prefix = _squared_prefix(channel)
    difference_prefix = _squared_prefix(differences)
    second_prefix = _squared_prefix(second_differences)
    candidates: list[int] = []
    for index in range(1, count - 1):
        jump = max(abs(differences[index]), abs(differences[index + 1]))
        if jump >= config.min_jump:
            passed, _ = _candidate_at(
                channel,
                differences,
                energy_prefix,
                difference_prefix,
                second_prefix,
                index,
                rate,
                config,
            )
            if passed:
                candidates.append(index)
    groups = _group_candidates(candidates, config.merge_gap_samples)

    accepted: list[tuple[int, int]] = []
    rejected_percussive = 0
    rejected_long = 0
    max_repair_samples = max(1, int(config.max_repair_ms * rate / 1000.0))

    for start, end in groups:
        if end - start > max_repair_samples:
            rejected_long += 1
            continue
        if _is_percussive_onset(channel, energy_prefix, start, rate, config):
            rejected_percussive += 1
            continue
        accepted.append((start, end))

    return accepted, len(groups), rejected_percussive, rejected_long


def _hermite_fill(
    channel: list[float],
    start: int,
    end: int,
) -> None:
    count = len(channel)
    left = start - 1
    right = end
    if left < 0 and right >= count:
        value = 0.0
        for index in range(start, end):
            channel[index] = value
        return
    if left < 0:
        channel[start:end] = [channel[right]] * (end - start)
        return
    if right >= count:
        channel[start:end] = [channel[left]] * (end - start)
        return

    y0 = channel[left]
    y1 = channel[right]
    if end - start == 1:
        channel[start] = 0.5 * (y0 + y1)
        return
    m0 = channel[left] - channel[left - 1] if left >= 1 else y1 - y0
    m1 = channel[right + 1] - channel[right] if right + 1 < count else y1 - y0
    length = float(right - left)
    delta = (y1 - y0) / length

    def limit(slope: float) -> float:
        if delta == 0.0:
            return 0.0
        if slope * delta <= 0.0:
            return 0.0
        return max(-3.0 * abs(delta), min(3.0 * abs(delta), slope))

    m0 = limit(m0)
    m1 = limit(m1)
    for index in range(start, end):
        t = (index - left) / length
        t2 = t * t
        t3 = t2 * t
        h00 = 2.0 * t3 - 3.0 * t2 + 1.0
        h10 = t3 - 2.0 * t2 + t
        h01 = -2.0 * t3 + 3.0 * t2
        h11 = t3 - t2
        channel[index] = h00 * y0 + h10 * length * m0 + h01 * y1 + h11 * length * m1


def _merge_frame_intervals(
    channel_intervals: list[tuple[int, int, int]],
) -> list[RepairInterval]:
    if not channel_intervals:
        return []
    points: list[tuple[int, int, int]] = []
    for channel, start, end in channel_intervals:
        points.append((start, 1, channel))
        points.append((end, -1, channel))
    points.sort()
    active: dict[int, int] = {}
    merged: list[RepairInterval] = []
    previous = points[0][0]
    for position, delta, channel in points:
        if position > previous and active:
            merged.append(RepairInterval(previous, position, tuple(sorted(active))))
        if delta < 0:
            if active[channel] == 1:
                del active[channel]
            else:
                active[channel] -= 1
        else:
            active[channel] = active.get(channel, 0) + 1
        previous = position
    return merged


def repair_audio(audio: Audio, config: DetectionConfig | None = None) -> RepairResult:
    """Detect isolated PCM ruptures, fill them, and return changed intervals."""

    config = config or DetectionConfig()
    repaired = audio.copy()
    channel_intervals: list[tuple[int, int, int]] = []
    candidate_groups = 0
    rejected_percussive = 0
    rejected_long = 0

    for channel_index, channel in enumerate(audio.samples):
        intervals, groups, percussive, long_groups = _find_intervals(
            channel, audio.sample_rate, config
        )
        candidate_groups += groups
        rejected_percussive += percussive
        rejected_long += long_groups
        for start, end in intervals:
            channel_intervals.append((channel_index, start, end))
            _hermite_fill(repaired.samples[channel_index], start, end)

    merged = _merge_frame_intervals(channel_intervals)
    modified_frames = sum(interval.frames for interval in merged)
    sample_changes = sum(end - start for _, start, end in channel_intervals)
    return RepairResult(
        audio=repaired,
        intervals=merged,
        sample_changes=sample_changes,
        modified_frames=modified_frames,
        candidate_groups=candidate_groups,
        rejected_percussive_groups=rejected_percussive,
        rejected_long_groups=rejected_long,
        channel_intervals=channel_intervals,
    )
