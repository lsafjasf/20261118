from __future__ import annotations

from dataclasses import dataclass, field

from .model import Manifest, Period, Representation, Segment

EPS = 1e-6


@dataclass
class SeekHit:
    period_id: str
    representation_id: str
    segment: Segment
    offset_in_segment_s: float
    ambiguous_period: bool


@dataclass
class SeekResult:
    requested_s: float
    in_presentation: bool
    matched_periods: list[str] = field(default_factory=list)
    hits: list[SeekHit] = field(default_factory=list)
    note: str = ""


def periods_at(manifest: Manifest, time_s: float) -> list[Period]:
    return [
        period
        for period in manifest.periods
        if period.start_s - EPS <= time_s < period.end_s - EPS
    ]


def _segment_at(representation: Representation, time_s: float) -> tuple[Segment, float] | None:
    for segment in representation.segments:
        if segment.presentation_start_s - EPS <= time_s < segment.presentation_end_s - EPS:
            return segment, time_s - segment.presentation_start_s
    return None


def seek(
    manifest: Manifest,
    time_s: float,
    representation_id: str | None = None,
) -> SeekResult:
    result = SeekResult(
        requested_s=time_s,
        in_presentation=(
            0.0 - EPS <= time_s < manifest.last_period_end_s - EPS
        ),
    )
    if not result.in_presentation:
        result.note = (
            f"time {time_s:g}s is outside the media presentation "
            f"[0, {manifest.last_period_end_s:g})s"
        )
        return result

    matched = periods_at(manifest, time_s)
    result.matched_periods = [period.id for period in matched]
    if len(matched) > 1:
        result.note = (
            "ambiguous: multiple Periods cover this time because of a Period overlap; "
            "a real player resolves by Period order/availability, both candidates shown"
        )
    elif not matched:
        result.note = "no Period content covers this time (Period gap)"
        return result

    for period in matched:
        reps = [
            representation
            for representation in period.representations
            if representation_id is None or representation.id == representation_id
        ]
        for representation in reps:
            located = _segment_at(representation, time_s)
            if located is None:
                continue
            segment, offset = located
            result.hits.append(
                SeekHit(
                    period_id=period.id,
                    representation_id=representation.id,
                    segment=segment,
                    offset_in_segment_s=offset,
                    ambiguous_period=len(matched) > 1,
                )
            )
    if not result.hits and not result.note:
        result.note = "time falls inside a Period but outside every declared segment"
    return result
