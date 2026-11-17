"""
Map source chapters onto the edited timeline using the explicit cut list.

The mapping is built frame by frame from the kept ranges; it is never derived
from a global percentage scale. Fractional cut points are snapped to the
nearest legal frame (round half up). Chapters fully removed disappear,
chapters intersected by cuts are split, and fragments below the configured
minimum length are deleted with the reason recorded.
"""
from dataclasses import dataclass, field

from common import (
    OUT,
    WORK,
    hms,
    load_json,
    time_to_nearest_frame,
)


@dataclass
class KeptRange:
    src_start_frame: int
    src_end_frame: int  # exclusive
    new_start_frame: int


@dataclass
class MappedChapter:
    index: int
    source_id: int
    part: int | None
    old_start: float
    old_end: float
    new_start: float
    new_end: float
    titles: dict
    languages: list
    reasons: list[str] = field(default_factory=list)
    status: str = "kept"


def snap_cuts(cuts: list[dict], fps: int) -> list[dict]:
    snapped = []
    for cut in cuts:
        sf = time_to_nearest_frame(cut["start"], fps)
        ef = time_to_nearest_frame(cut["end"], fps)
        snapped.append(
            {
                **cut,
                "start_frame": sf,
                "end_frame": ef,
                "start_snapped": sf / fps,
                "end_snapped": ef / fps,
                "start_delta": sf / fps - cut["start"],
                "end_delta": ef / fps - cut["end"],
            }
        )
    return sorted(snapped, key=lambda item: item["start_frame"])


def merge_removed_frames(snapped_cuts: list[dict], total_frames: int) -> list[tuple[int, int]]:
    removed = [(c["start_frame"], c["end_frame"]) for c in snapped_cuts]
    removed = [(max(0, a), min(total_frames, b)) for a, b in removed if b > a]
    merged: list[list[int]] = []
    for a, b in removed:
        if not merged or a > merged[-1][1]:
            merged.append([a, b])
        else:
            merged[-1][1] = max(merged[-1][1], b)
    return [(a, b) for a, b in merged]


def build_kept_ranges(removed: list[tuple[int, int]], total_frames: int) -> list[KeptRange]:
    ranges: list[KeptRange] = []
    cursor = 0
    new_cursor = 0
    for a, b in removed:
        if a > cursor:
            ranges.append(KeptRange(cursor, a, new_cursor))
            new_cursor += a - cursor
        cursor = max(cursor, b)
    if cursor < total_frames:
        ranges.append(KeptRange(cursor, total_frames, new_cursor))
    return ranges


def build_frame_map(kept: list[KeptRange], total_frames: int) -> list[int | None]:
    """old_frame -> new_frame (None when the source frame was removed)."""
    mapping: list[int | None] = [None] * total_frames
    for kr in kept:
        for old in range(kr.src_start_frame, kr.src_end_frame):
            mapping[old] = kr.new_start_frame + (old - kr.src_start_frame)
    return mapping


def surviving_segments(
    start_frame: int,
    end_frame: int,
    frame_map: list[int | None],
) -> list[tuple[int, int]]:
    """Return contiguous surviving source-frame segments inside [start, end)."""
    segments: list[tuple[int, int]] = []
    seg_start: int | None = None
    for frame in range(start_frame, end_frame):
        if frame_map[frame] is not None:
            if seg_start is None:
                seg_start = frame
        elif seg_start is not None:
            segments.append((seg_start, frame))
            seg_start = None
    if seg_start is not None:
        segments.append((seg_start, end_frame))
    return segments


def map_all_chapters(
    chapters: list[dict],
    snapped_cuts: list[dict],
    frame_map: list[int | None],
    fps: int,
    min_fragment_sec: float,
    output_total_frames: int,
) -> tuple[list[MappedChapter], list[dict]]:
    results: list[MappedChapter] = []
    removed_log: list[dict] = []

    for chapter in chapters:
        cid = chapter["id"]
        start_frame = time_to_nearest_frame(chapter["start"], fps)
        end_frame = time_to_nearest_frame(chapter["end"], fps)
        segments = surviving_segments(start_frame, end_frame, frame_map)
        hit_cuts = [
            c
            for c in snapped_cuts
            if c["end_frame"] > start_frame and c["start_frame"] < end_frame
        ]
        if not segments:
            removed_log.append(
                {
                    "source_id": cid,
                    "titles": chapter["titles"],
                    "old_start": chapter["start"],
                    "old_end": chapter["end"],
                    "reason": "章节全部内容落入剪辑删除区间，整章删除",
                }
            )
            continue

        qualified: list[tuple[int, int]] = []
        for seg_a, seg_b in segments:
            duration_frames = seg_b - seg_a
            duration_sec = duration_frames / fps
            if duration_sec + 1e-9 < min_fragment_sec:
                removed_log.append(
                    {
                        "source_id": cid,
                        "part": len(removed_log) + 1,
                        "titles": chapter["titles"],
                        "old_start": seg_a / fps,
                        "old_end": seg_b / fps,
                        "reason": (
                            f"保留片段时长 {duration_sec:.3f}s 低于最小阈值 "
                            f"{min_fragment_sec:.1f}s，删除该碎片"
                        ),
                    }
                )
                continue
            qualified.append((seg_a, seg_b))

        if not qualified:
            removed_log[-1]["reason"] += "（所有保留碎片均低于最小阈值）"
            continue

        split = len(qualified) > 1
        for part_index, (seg_a, seg_b) in enumerate(qualified, start=1):
            new_a = frame_map[seg_a]
            new_b = frame_map[seg_b - 1] + 1
            reasons: list[str] = []
            if seg_a != start_frame:
                reasons.append(
                    f"原章节起点 {hms(chapter['start'])} 之前的内容被删除，"
                    f"本段起点吸附到删除区间之后的最近合法帧 {hms(seg_a / fps)}（源帧 {seg_a}）"
                )
            else:
                reasons.append("起点落在保留片段内，无需调整")
            if seg_b != end_frame:
                reasons.append(
                    f"原章节终点 {hms(chapter['end'])} 之后的内容被删除，"
                    f"本段终点吸附到删除区间之前的最近合法帧 {hms(seg_b / fps)}（源帧 {seg_b}，半开区间）"
                )
            else:
                reasons.append("终点落在保留片段内，无需调整")
            if hit_cuts:
                names = ", ".join(f"{c['id']}({c['reason']})" for c in hit_cuts)
                reasons.append(
                    f"章节被剪辑点 {names} 切割，"
                    + (f"本片段为第 {part_index}/{len(qualified)} 段" if split else "仅单段存活")
                )
            results.append(
                MappedChapter(
                    index=len(results) + 1,
                    source_id=cid,
                    part=part_index if split else None,
                    old_start=seg_a / fps,
                    old_end=seg_b / fps,
                    new_start=new_a / fps,
                    new_end=new_b / fps,
                    titles=chapter["titles"],
                    languages=list(chapter["titles"].keys()),
                    reasons=reasons,
                    status="split" if split else "kept",
                )
            )

    if results:
        last = results[-1]
        eof_sec = output_total_frames / fps
        if abs(last.new_end - eof_sec) > 1e-9 and last.new_end < eof_sec:
            last.reasons.append(
                f"后续章节被整体删除，最后一个存活章节延伸至成片结尾 {hms(eof_sec)}"
            )
            last.new_end = eof_sec
    return results, removed_log
