from __future__ import annotations

from dataclasses import dataclass, field

from .model import Manifest, Representation, Segment
from .seek import seek

EPS = 1e-6


@dataclass
class RequestLog:
    url: str
    period_id: str
    representation_id: str
    segment_number: int
    media_time: int
    expected_base_media_decode_time: int
    presentation_start_s: float
    empty: bool


@dataclass
class PlaybackReport:
    requests: list[RequestLog] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    skipped_empty_urls: list[str] = field(default_factory=list)


def expected_bmdt(segment: Segment, representation: Representation) -> int:
    """Media decode time a normal player expects inside the fMP4 container."""
    return segment.media_time - representation.template.presentation_time_offset


def _check_store_record(
    segment: Segment,
    representation: Representation,
    store: dict,
) -> str | None:
    record = store["segments"].get(segment.url)
    if record is None:
        return f"HTTP 404 would be returned for {segment.url}"
    expected = expected_bmdt(segment, representation)
    if record.get("base_media_decode_time") != expected:
        return (
            f"{segment.url}: parsed BMDT {record.get('base_media_decode_time')} "
            f"!= player expectation {expected}"
        )
    return None


def simulate_playback(
    manifest: Manifest,
    store: dict,
    representation_id: str | None = None,
) -> PlaybackReport:
    report = PlaybackReport()
    for period in manifest.periods:
        for representation in period.representations:
            if representation_id is not None and representation.id != representation_id:
                continue
            for segment in representation.segments:
                failure = _check_store_record(segment, representation, store)
                if failure:
                    report.failures.append(failure)
                record = store["segments"].get(segment.url, {})
                empty = record.get("sample_count", 1) == 0
                report.requests.append(
                    RequestLog(
                        url=segment.url,
                        period_id=period.id,
                        representation_id=representation.id,
                        segment_number=segment.number,
                        media_time=segment.media_time,
                        expected_base_media_decode_time=expected_bmdt(
                            segment, representation
                        ),
                        presentation_start_s=segment.presentation_start_s,
                        empty=empty,
                    )
                )
                if empty:
                    report.skipped_empty_urls.append(segment.url)
    return report


def verify_seek_consistency(
    manifest: Manifest,
    store: dict,
    sample_times_s: list[float],
) -> list[str]:
    """A player seeking to time T must request exactly the segment the
    inspector resolves; verify the mock object's decode time maps back to T."""
    failures: list[str] = []
    for time_s in sample_times_s:
        result = seek(manifest, time_s)
        if not result.in_presentation:
            continue
        for hit in result.hits:
            segment = hit.segment
            period = next(p for p in manifest.periods if p.id == hit.period_id)
            representation = next(
                rep
                for rep in period.representations
                if rep.id == hit.representation_id
            )
            record = store["segments"].get(segment.url)
            if record is None:
                failures.append(
                    f"seek {time_s:g}s -> {segment.url} missing from mock store"
                )
                continue
            if segment.is_empty:
                if record.get("sample_count", 1) != 0:
                    failures.append(
                        f"seek {time_s:g}s: {segment.url} expected empty segment "
                        "but mock object contains samples"
                    )
                continue
            timescale = representation.template.timescale
            mapped_back_s = (
                period.start_s
                + record["base_media_decode_time"] / timescale
            )
            if abs(mapped_back_s - segment.presentation_start_s) > EPS:
                failures.append(
                    f"seek {time_s:g}s: decode time maps back to {mapped_back_s:g}s, "
                    f"segment starts at {segment.presentation_start_s:g}s"
                )
            if not (segment.presentation_start_s - EPS <= time_s <
                    segment.presentation_end_s - EPS):
                failures.append(
                    f"seek {time_s:g}s resolved outside its own segment "
                    f"[{segment.presentation_start_s:g}, {segment.presentation_end_s:g})"
                )
    return failures
