from __future__ import annotations

from .model import Issue, Manifest, Representation

EPS = 1e-6


def mark_empty_segments(manifest: Manifest, empty_urls: set[str]) -> None:
    for period in manifest.periods:
        for representation in period.representations:
            for segment in representation.segments:
                segment.is_empty = segment.url in empty_urls


def empty_urls_from_store(store: dict) -> set[str]:
    return {
        url
        for url, record in store["segments"].items()
        if record.get("sample_count", 1) == 0
    }


def _rep_id(representation: Representation) -> str:
    return f"{representation.period_id}/{representation.id}"


def validate_periods(manifest: Manifest) -> list[Issue]:
    issues: list[Issue] = []
    ordered = sorted(manifest.periods, key=lambda period: period.start_s)
    for previous, current in zip(ordered, ordered[1:]):
        if current.start_s < previous.end_s - EPS:
            issues.append(
                Issue(
                    code="PERIOD_OVERLAP",
                    severity="ERROR",
                    message=(
                        f"Period {current.id} starts at {current.start_s:g}s before "
                        f"{previous.id} ends at {previous.end_s:g}s "
                        f"(overlap {previous.end_s - current.start_s:g}s)"
                    ),
                    detail={"period": current.id},
                )
            )
        elif current.start_s > previous.end_s + EPS:
            issues.append(
                Issue(
                    code="PERIOD_GAP",
                    severity="WARN",
                    message=(
                        f"Gap of {current.start_s - previous.end_s:g}s between "
                        f"{previous.id} and {current.id}"
                    ),
                    detail={"period": current.id},
                )
            )
    if manifest.media_presentation_duration_s is not None:
        span_end = manifest.last_period_end_s
        if abs(span_end - manifest.media_presentation_duration_s) > EPS:
            issues.append(
                Issue(
                    code="MPD_DURATION_MISMATCH",
                    severity="WARN",
                    message=(
                        f"mediaPresentationDuration "
                        f"{manifest.media_presentation_duration_s:g}s != last Period end "
                        f"{span_end:g}s (difference "
                        f"{manifest.media_presentation_duration_s - span_end:g}s)"
                    ),
                )
            )
    return issues


def validate_representation(
    manifest: Manifest, representation: Representation
) -> list[Issue]:
    issues: list[Issue] = []
    period = next(p for p in manifest.periods if p.id == representation.period_id)
    template = representation.template
    label = _rep_id(representation)
    segments = representation.segments
    if not segments:
        issues.append(
            Issue(
                code="NO_SEGMENTS",
                severity="ERROR",
                message="No segments could be expanded from SegmentTemplate",
                detail={"period": period.id, "representation": representation.id},
            )
        )
        return issues

    first = segments[0]
    expected_first_time = template.presentation_time_offset
    if first.media_time != expected_first_time:
        issues.append(
            Issue(
                code="PTO_FIRST_SEGMENT_MISMATCH",
                severity="WARN",
                message=(
                    f"First segment media time {first.media_time} != "
                    f"presentationTimeOffset {expected_first_time} "
                    f"(timescale {template.timescale})"
                ),
                detail={"period": period.id, "representation": representation.id},
            )
        )

    for previous, current in zip(segments, segments[1:]):
        gap_ticks = current.media_time - (previous.media_time + previous.duration_ticks)
        if gap_ticks > 0:
            issues.append(
                Issue(
                    code="SEGMENT_GAP",
                    severity="WARN",
                    message=(
                        f"Timeline gap of {gap_ticks} ticks "
                        f"({gap_ticks / template.timescale:g}s) before segment "
                        f"number {current.number}"
                    ),
                    detail={
                        "period": period.id,
                        "representation": representation.id,
                    },
                )
            )
        elif gap_ticks < 0:
            issues.append(
                Issue(
                    code="SEGMENT_OVERLAP",
                    severity="ERROR",
                    message=(
                        f"Timeline overlap of {-gap_ticks} ticks at segment "
                        f"number {current.number}"
                    ),
                    detail={
                        "period": period.id,
                        "representation": representation.id,
                    },
                )
            )

    for segment in segments:
        if segment.period_relative_s < -EPS:
            issues.append(
                Issue(
                    code="SEGMENT_BEFORE_PERIOD_START",
                    severity="ERROR",
                    message=(
                        f"Segment number {segment.number} starts at relative "
                        f"{segment.period_relative_s:g}s, before Period start"
                    ),
                    detail={"period": period.id, "representation": representation.id},
                )
            )
        if period.duration_s is not None and segment.presentation_end_s > period.end_s + EPS:
            overhang = segment.presentation_end_s - period.end_s
            issues.append(
                Issue(
                    code="SEGMENT_OVERHANG",
                    severity="ERROR",
                    message=(
                        f"Segment number {segment.number} ends at "
                        f"{segment.presentation_end_s:g}s presentation time but "
                        f"Period {period.id} ends at {period.end_s:g}s "
                        f"(overhang {overhang:g}s)"
                    ),
                    detail={"period": period.id, "representation": representation.id},
                )
            )

    if template.timescale <= 0:
        issues.append(
            Issue(
                code="BAD_TIMESCALE",
                severity="ERROR",
                message=f"timescale must be positive, got {template.timescale}",
                detail={"period": period.id, "representation": representation.id},
            )
        )

    expected_numbers = list(
        range(template.start_number, template.start_number + len(segments))
    )
    actual_numbers = [segment.number for segment in segments]
    if actual_numbers != expected_numbers:
        issues.append(
            Issue(
                code="NUMBER_SEQUENCE_BROKEN",
                severity="ERROR",
                message=f"Segment numbers {actual_numbers} are not contiguous from startNumber",
                detail={"period": period.id, "representation": representation.id},
            )
        )

    if segment_is_empty := [segment.number for segment in segments if segment.is_empty]:
        issues.append(
            Issue(
                code="EMPTY_SEGMENT",
                severity="WARN",
                message=(
                    f"Empty media segment(s) at number(s) "
                    f"{', '.join(str(n) for n in segment_is_empty)} "
                    f"({label}); player must skip playback samples there"
                ),
                detail={"period": period.id, "representation": representation.id},
            )
        )
    return issues


def cross_check_representations(manifest: Manifest) -> list[Issue]:
    issues: list[Issue] = []
    for period in manifest.periods:
        references = [rep for rep in period.representations if rep.segments]
        if len(references) < 2:
            continue
        anchor = references[0]
        anchor_bounds = [
            (seg.presentation_start_s, seg.presentation_end_s) for seg in anchor.segments
        ]
        for representation in references[1:]:
            bounds = [
                (seg.presentation_start_s, seg.presentation_end_s)
                for seg in representation.segments
            ]
            if len(bounds) != len(anchor_bounds):
                issues.append(
                    Issue(
                        code="REP_SEGMENT_COUNT_MISMATCH",
                        severity="WARN",
                        message=(
                            f"{_rep_id(representation)} has {len(bounds)} segments vs "
                            f"{len(anchor_bounds)} in {_rep_id(anchor)}"
                        ),
                        detail={"period": period.id},
                    )
                )
                continue
            for index, (bounds_a, bounds_b) in enumerate(zip(anchor_bounds, bounds)):
                if abs(bounds_a[0] - bounds_b[0]) > EPS or abs(bounds_a[1] - bounds_b[1]) > EPS:
                    issues.append(
                        Issue(
                            code="REP_BOUNDARY_DRIFT",
                            severity="ERROR",
                            message=(
                                f"Segment index {index} boundary drift: "
                                f"{_rep_id(anchor)} {bounds_a[0]:g}-{bounds_a[1]:g}s vs "
                                f"{_rep_id(representation)} {bounds_b[0]:g}-"
                                f"{bounds_b[1]:g}s"
                            ),
                            detail={"period": period.id},
                        )
                    )
    return issues


def validate_against_store(manifest: Manifest, store: dict) -> list[Issue]:
    issues: list[Issue] = []
    referenced: set[str] = set()
    for period in manifest.periods:
        for representation in period.representations:
            for segment in representation.segments:
                referenced.add(segment.url)
                record = store["segments"].get(segment.url)
                if record is None:
                    issues.append(
                        Issue(
                            code="SEGMENT_NOT_IN_STORE",
                            severity="ERROR",
                            message=f"URL {segment.url} has no mock segment object",
                            detail={
                                "period": period.id,
                                "representation": representation.id,
                            },
                        )
                    )
                    continue
                expected_ticks = segment.duration_ticks
                actual_ticks = round(
                    record["media_duration_s"] * representation.template.timescale
                )
                if abs(actual_ticks - expected_ticks) > 1:
                    issues.append(
                        Issue(
                            code="STORE_DURATION_DRIFT",
                            severity="ERROR",
                            message=(
                                f"{segment.url}: stored duration "
                                f"{record['media_duration_s']:g}s does not match "
                                f"manifest {segment.duration_s:g}s"
                            ),
                            detail={
                                "period": period.id,
                                "representation": representation.id,
                            },
                        )
                    )
    for url in store["segments"]:
        if url not in referenced:
            issues.append(
                Issue(
                    code="ORPHAN_STORE_OBJECT",
                    severity="WARN",
                    message=f"Mock store object {url} is never referenced by the MPD",
                )
            )
    return issues


def validate_manifest(manifest: Manifest, store: dict) -> list[Issue]:
    empty_urls = empty_urls_from_store(store)
    mark_empty_segments(manifest, empty_urls)
    issues = validate_periods(manifest)
    for period in manifest.periods:
        for representation in period.representations:
            issues.extend(validate_representation(manifest, representation))
    issues.extend(cross_check_representations(manifest))
    issues.extend(validate_against_store(manifest, store))
    return issues
