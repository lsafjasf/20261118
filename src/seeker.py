"""Simulate a WebM player's cue-based seek without needing a real player."""

from dataclasses import dataclass

from . import ebml
from . import webm_ids as W
from .scanner import scan


@dataclass
class SeekProbe:
    target_ms: int
    cue_time_ms: int | None
    cluster_file_offset: int | None
    cluster_relative_offset: int | None
    landed_time_ms: int | None
    seek_error_ms: int | None
    reason: str


def load_cue_table(path):
    with open(path, "rb") as handle:
        buf = handle.read()
    result = scan(path)
    usable = []
    problems = []
    for idx, (data_start, _, elem_end) in enumerate(result.cues_elements):
        try:
            parsed = _parse_one_cues(buf, data_start, elem_end)
        except ebml.EbmlError as exc:
            problems.append(f"Cues[{idx}] unparsable: {exc}")
            continue
        if parsed:
            usable = parsed  # latest valid table wins (muxer convention)
    status = "ok" if usable else "; ".join(problems) or "empty Cues"
    return buf, result, usable, status


def _parse_one_cues(buf, data_start, elem_end):
    cues = []
    for pid, _, psize, pstart, pend in ebml.iter_children(buf, data_start, elem_end):
        if pid != W.CUE_POINT:
            continue
        cue_time = None
        positions = {}
        for cid, _, csize, cstart, cend in ebml.iter_children(buf, pstart, pend):
            if cid == W.CUE_TIME:
                cue_time = ebml.read_uint(buf, cstart, csize)
            elif cid == W.CUE_TRACK_POSITIONS:
                track_number = None
                cluster_pos = None
                for tid, _, tsize, tstart, _ in ebml.iter_children(buf, cstart, cend):
                    if tid == W.CUE_TRACK:
                        track_number = ebml.read_uint(buf, tstart, tsize)
                    elif tid == W.CUE_CLUSTER_POS:
                        cluster_pos = ebml.read_uint(buf, tstart, tsize)
                if track_number is not None:
                    positions[track_number] = cluster_pos
        if cue_time is not None:
            cues.append((cue_time, positions))
    return cues


def seek(path, target_ms):
    """Mimic Matroska demuxer behaviour: pick the latest cue <= target."""
    buf, result, cues, status = load_cue_table(path)
    if not cues:
        return SeekProbe(target_ms, None, None, None, None, None,
                         f"no usable Cues ({status}); player falls back to start")

    chosen = None
    video_number = next(
        (num for num, track in result.tracks.items() if track.kind == "video"),
        None,
    )
    for cue_time, positions in cues:
        if cue_time <= target_ms:
            chosen = (cue_time, positions)
        else:
            break
    if chosen is None:
        chosen = cues[0]

    cue_time, positions = chosen
    track_number = video_number if video_number in positions else next(iter(positions))
    rel_offset = positions[track_number]
    abs_offset = result.segment_data_start + rel_offset

    # A demuxer then opens the cluster at abs_offset and reads its timecode.
    landed_ms = _cluster_timecode_at(buf, abs_offset, result)
    error = abs(target_ms - landed_ms) if landed_ms is not None else None
    return SeekProbe(
        target_ms=target_ms,
        cue_time_ms=cue_time,
        cluster_file_offset=abs_offset,
        cluster_relative_offset=rel_offset,
        landed_time_ms=landed_ms,
        seek_error_ms=error,
        reason="cue hit",
    )


def _cluster_timecode_at(buf, abs_offset, result):
    elem_id, header_len, data_size, data_start = ebml.read_elem_header(
        buf, abs_offset
    )
    if elem_id != W.CLUSTER:
        return None
    end = data_start + (data_size or 0)
    for cid, _, csize, cstart, _ in ebml.iter_children(buf, data_start, end or data_start):
        if cid == W.CLUSTER_TIMECODE:
            return ebml.read_uint(buf, cstart, csize)
    return None


def addressable_range(path):
    """Return (first_cue_ms, last_cue_ms, cue_count) or None."""
    _, _, cues, _ = load_cue_table(path)
    if not cues:
        return None
    return cues[0][0], cues[-1][0], len(cues)
