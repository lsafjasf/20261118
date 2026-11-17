"""Rebuild a WebM Cues index from scanned cluster/keyframe data."""

import os

from . import ebml
from . import webm_ids as W


def build_cue_entries(result, min_interval_ms=1000):
    """Build one cue point per keyframe, throttled by min_interval_ms/track.

    Returns a sorted list of (timecode_ms, {track_number: rel_offset}).
    Video keyframes drive the cadence; audio gets a cue in the same point when
    its cluster changes. Offsets are relative to Segment data start, which is
    exactly what CueClusterPosition stores.
    """
    points = {}
    last_video_tc = -1
    last_audio_tc = -1
    tracks = result.tracks

    for cluster in result.clusters:
        for frame in cluster.frames:
            track = tracks.get(frame.track_number)
            if track is None:
                continue
            abs_tc = cluster.timecode_ms + frame.rel_timecode
            if track.kind == "video":
                if not frame.keyframe:
                    continue
                if abs_tc - last_video_tc < min_interval_ms and last_video_tc >= 0:
                    continue
                last_video_tc = abs_tc
                points.setdefault(abs_tc, {})[frame.track_number] = (
                    cluster.seg_relative_offset
                )
            elif track.kind == "audio":
                # Audio alone rarely needs the same density as video keys.
                if abs_tc - last_audio_tc < max(min_interval_ms, 2000) \
                        and last_audio_tc >= 0:
                    continue
                last_audio_tc = abs_tc
                points.setdefault(abs_tc, {})[frame.track_number] = (
                    cluster.seg_relative_offset
                )
    return [(tc, points[tc]) for tc in sorted(points)]


def encode_cues(result, entries):
    payload = bytearray()
    for timecode_ms, positions in entries:
        point = bytearray()
        point += ebml.encode_uint(W.CUE_TIME, timecode_ms)
        for track_number, cluster_rel_offset in sorted(positions.items()):
            track_pos = bytearray()
            track_pos += ebml.encode_uint(W.CUE_TRACK, track_number)
            track_pos += ebml.encode_uint(W.CUE_CLUSTER_POS, cluster_rel_offset)
            point += ebml.encode_element(W.CUE_TRACK_POSITIONS, bytes(track_pos))
        payload += ebml.encode_element(W.CUE_POINT, bytes(point))
    return ebml.encode_element(W.CUES, bytes(payload))


def repair_file(src_path, dst_path, min_interval_ms=1000):
    """Write a repaired copy with a fresh Cues element.

    Original media bytes (header/info/tracks/clusters) are copied verbatim;
    nothing inside a Cluster is rewritten. A new Cues element is appended at
    the end of the Segment.
    """
    with open(src_path, "rb") as handle:
        original = handle.read()

    result = _scan(original)
    entries = build_cue_entries(result, min_interval_ms=min_interval_ms)
    cues_bytes = encode_cues(result, entries)

    seg_end = result.file_size if result.segment_size is None else (
        result.segment_data_start + result.segment_size
    )

    if result.segment_size is None:
        # Open-ended segment: append directly, preserving every original byte.
        repaired = original + cues_bytes
    else:
        new_size = result.segment_size + len(cues_bytes)
        size_width = ebml.min_width(new_size)
        old_size_width = result.segment_header_len - 4  # Segment ID is 4 bytes
        new_header = W.SEGMENT.to_bytes(4, "big") + ebml.encode_vint(
            new_size, width=max(size_width, old_size_width)
        )
        head = original[: result.segment_abs_offset]
        body = original[
            result.segment_abs_offset + result.segment_header_len : seg_end
        ]
        trailing = original[seg_end:]
        repaired = head + new_header + body + cues_bytes + trailing

    with open(dst_path, "wb") as handle:
        handle.write(repaired)

    return {
        "entries": entries,
        "cues_size": len(cues_bytes),
        "segment_size_was_unknown": result.segment_size is None,
        "original_size": len(original),
        "repaired_size": len(repaired),
        "appended_offset": len(original) if result.segment_size is None else None,
        "result": result,
    }


def _scan(buf):
    from .scanner import scan_bytes
    return scan_bytes(buf)


def cluster_byte_ranges(result):
    """Absolute byte ranges of every Cluster, for integrity hashing."""
    return [
        (c.index, c.abs_offset, c.elem_end, c.timecode_ms)
        for c in result.clusters
    ]


def cues_coverage(result, entries):
    """Addressable time range exposed by a cue table."""
    if not entries:
        return None
    first_tc = entries[0][0]
    last_tc = entries[-1][0]
    return first_tc, last_tc, len(entries)
