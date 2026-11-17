from __future__ import annotations

import json

from .model import Issue, Manifest
from .player import PlaybackReport
from .seek import SeekResult


def render_segments(manifest: Manifest) -> str:
    lines = [
        "period | representation | # | media time (ticks) | duration | "
        "relative s | presentation s | URL | keyframe | empty"
    ]
    for period in manifest.periods:
        for representation in period.representations:
            tpl = representation.template
            for segment in representation.segments:
                lines.append(
                    " | ".join(
                        [
                            period.id,
                            representation.id,
                            str(segment.number),
                            f"{segment.media_time} @{tpl.timescale}",
                            f"{segment.duration_s:g}s",
                            f"{segment.period_relative_s:g}",
                            f"[{segment.presentation_start_s:g}, "
                            f"{segment.presentation_end_s:g})",
                            segment.url,
                            "SAP" if segment.starts_with_keyframe else "-",
                            "EMPTY" if segment.is_empty else "",
                        ]
                    )
                )
    return "\n".join(lines)


def render_issues(issues: list[Issue]) -> str:
    if not issues:
        return "No time-boundary issues found."
    lines = ["severity | code | period | representation | message"]
    for issue in sorted(issues, key=lambda item: (item.severity, item.code)):
        lines.append(" | ".join(issue.as_row()))
    return "\n".join(lines)


def render_seek(result: SeekResult) -> str:
    lines = [f"seek t={result.requested_s:g}s"]
    if not result.in_presentation:
        lines.append(f"  OUT OF RANGE: {result.note}")
        return "\n".join(lines)
    lines.append(f"  matched periods: {', '.join(result.matched_periods) or '-'}")
    if result.note:
        lines.append(f"  note: {result.note}")
    for hit in result.hits:
        segment = hit.segment
        lines.append(
            "  "
            + " | ".join(
                [
                    f"{hit.period_id}/{hit.representation_id}",
                    f"segment #{segment.number}",
                    f"media time {segment.media_time}",
                    f"offset {hit.offset_in_segment_s:.3f}s",
                    f"presentation [{segment.presentation_start_s:g}, "
                    f"{segment.presentation_end_s:g})",
                    "starts at keyframe" if segment.starts_with_keyframe
                    else "no keyframe at start",
                    "EMPTY segment" if segment.is_empty else "",
                    segment.url,
                ]
            ).rstrip(" |")
        )
    if not result.hits:
        lines.append("  no segment covers this time")
    return "\n".join(lines)


def render_playback(report: PlaybackReport) -> str:
    lines = ["normal-player request log:"]
    for request in report.requests:
        lines.append(
            "  "
            + " | ".join(
                [
                    f"{request.period_id}/{request.representation_id}",
                    f"#{request.segment_number}",
                    f"t={request.media_time}",
                    f"BMDT={request.expected_base_media_decode_time}",
                    f"start={request.presentation_start_s:g}s",
                    "EMPTY->skip" if request.empty else "",
                    request.url,
                ]
            ).rstrip(" |")
        )
    if report.skipped_empty_urls:
        lines.append(
            "empty segments skipped: " + ", ".join(report.skipped_empty_urls)
        )
    if report.failures:
        lines.append("FAILURES:")
        lines.extend(f"  - {failure}" for failure in report.failures)
    else:
        lines.append("all requested objects and decode times verified OK")
    return "\n".join(lines)


def render_json(
    manifest: Manifest,
    issues: list[Issue],
    report: PlaybackReport,
    seek_samples: list[SeekResult],
) -> str:
    payload = {
        "issues": [
            {
                "severity": issue.severity,
                "code": issue.code,
                "message": issue.message,
                "detail": issue.detail,
            }
            for issue in issues
        ],
        "segments": [
            {
                "period": period.id,
                "representation": representation.id,
                "number": segment.number,
                "media_time": segment.media_time,
                "timescale": representation.template.timescale,
                "presentation_time_offset":
                    representation.template.presentation_time_offset,
                "presentation_start_s": segment.presentation_start_s,
                "presentation_end_s": segment.presentation_end_s,
                "url": segment.url,
                "starts_with_keyframe": segment.starts_with_keyframe,
                "is_empty": segment.is_empty,
            }
            for period in manifest.periods
            for representation in period.representations
            for segment in representation.segments
        ],
        "playback_failures": report.failures,
        "seek_samples": [
            {
                "requested_s": result.requested_s,
                "in_presentation": result.in_presentation,
                "matched_periods": result.matched_periods,
                "note": result.note,
                "hits": [
                    {
                        "period": hit.period_id,
                        "representation": hit.representation_id,
                        "segment_number": hit.segment.number,
                        "offset_in_segment_s": hit.offset_in_segment_s,
                        "starts_with_keyframe": hit.segment.starts_with_keyframe,
                        "is_empty": hit.segment.is_empty,
                        "url": hit.segment.url,
                    }
                    for hit in result.hits
                ],
            }
            for result in seek_samples
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)
