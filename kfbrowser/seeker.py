"""Keyframe lookup and precise decode-to-target using an external ffmpeg.

Lookup policy: for a target presentation time T, pick the newest keyframe
with pts <= T. If none exists, report a structured miss reason so the
caller knows why no keyframe can serve the request.
"""

from __future__ import annotations

import bisect
import hashlib
import os
import subprocess
from dataclasses import dataclass

from .mp4index import VideoIndex

FFMPEG = os.environ.get(
    "KF_FFMPEG",
    os.path.join(os.path.dirname(__file__), "..", "tools",
                 "ffmpeg-static", "ffmpeg"),
)


@dataclass
class LookupResult:
    ok: bool
    keyframe: object = None   # Keyframe when ok
    reason: str = ""          # human-readable miss reason when not ok
    reason_code: str = ""     # machine-readable miss code


def find_keyframe(index: VideoIndex, target_seconds: float) -> LookupResult:
    """Nearest keyframe at or before target_seconds (presentation time)."""
    if not index.keyframes:
        return LookupResult(
            False,
            reason="no keyframes in index: stream has no sync samples "
                   "(stss empty) or sample table is unreadable",
            reason_code="NO_KEYFRAMES",
        )
    if target_seconds < 0:
        return LookupResult(
            False,
            reason=f"target {target_seconds:.3f}s is negative: no keyframe "
                   "can precede a negative presentation time",
            reason_code="NEGATIVE_TIME",
        )
    first = index.keyframes[0]
    if target_seconds < first.pts_seconds - 1e-9:
        return LookupResult(
            False,
            reason=(
                f"target {target_seconds:.3f}s is before the first keyframe "
                f"at {first.pts_seconds:.3f}s"
                + (
                    f" (edit list shifts media by "
                    f"{index.media_time_offset:.3f}s; media before that "
                    "point is not presented)"
                    if index.media_time_offset
                    else ""
                )
            ),
            reason_code="BEFORE_FIRST_KEYFRAME",
        )
    if target_seconds > index.duration_seconds:
        return LookupResult(
            False,
            reason=f"target {target_seconds:.3f}s is beyond stream duration "
                   f"{index.duration_seconds:.3f}s",
            reason_code="BEYOND_DURATION",
        )
    pts_list = [k.pts_seconds for k in index.keyframes]
    pos = bisect.bisect_right(pts_list, target_seconds + 1e-9) - 1
    return LookupResult(True, keyframe=index.keyframes[pos])


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def _parse_framemd5(text):
    """Parse framemd5 output into [(pts_seconds, md5), ...]."""
    tb = None
    frames = []
    for line in text.splitlines():
        if line.startswith("#tb"):
            # e.g. "#tb 0: 1/25"
            frac = line.split(":", 1)[1].strip()
            num, den = frac.split("/")
            tb = float(num) / float(den)
        elif line and not line.startswith("#"):
            parts = [p.strip() for p in line.split(",")]
            pts = int(parts[1])
            md5 = parts[-1]
            frames.append((pts, md5))
    if tb is None:
        tb = 1.0
    return [(pts * tb, md5) for pts, md5 in frames]


def reference_frames(path):
    """Full decode: [(pts_seconds, md5)] for every presented frame."""
    cmd = [FFMPEG, "-v", "error", "-i", path, "-f", "framemd5", "-"]
    r = _run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"reference decode failed: {r.stderr[:300]}")
    return _parse_framemd5(r.stdout)


def decode_from_keyframe(path, keyframe_pts, max_frames):
    """Decode starting at the keyframe nearest to keyframe_pts.

    Uses input seeking (lands on the keyframe itself) plus -copyts so
    output frames keep their original presentation timestamps.
    Returns [(pts_seconds, md5), ...].
    """
    cmd = [
        FFMPEG, "-v", "error", "-copyts",
        "-ss", f"{max(keyframe_pts, 0.0):.6f}", "-i", path,
        "-frames:v", str(max_frames),
        "-f", "framemd5", "-",
    ]
    r = _run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"keyframe decode failed: {r.stderr[:300]}")
    return _parse_framemd5(r.stdout)


@dataclass
class SeekResult:
    ok: bool
    lookup: LookupResult = None
    target_frame: int = -1
    target_pts: float = 0.0
    frames_decoded: int = 0
    hash_match: bool = False
    reason: str = ""


def precise_seek(index: VideoIndex, target_seconds: float,
                 fps_hint=None) -> SeekResult:
    """Find the preceding keyframe, decode forward to the target frame,
    and verify the landed frame against a full-decode reference hash."""
    lookup = find_keyframe(index, target_seconds)
    if not lookup.ok:
        return SeekResult(False, lookup=lookup, reason=lookup.reason)
    kf = lookup.keyframe

    # reference timeline from a full decode (ground truth)
    ref = reference_frames(index.path)
    if not ref:
        return SeekResult(False, lookup=lookup,
                          reason="full decode produced no frames")
    ref_times = [p for p, _ in ref]
    ti = min(range(len(ref)), key=lambda i: abs(ref_times[i] - target_seconds))
    target_pts, target_md5 = ref[ti]
    if abs(target_pts - target_seconds) > 0.5:
        return SeekResult(
            False, lookup=lookup,
            reason=f"no decoded frame within 0.5s of target "
                   f"{target_seconds:.3f}s (nearest at {target_pts:.3f}s)",
        )

    # decode enough frames from the keyframe to pass the target
    if fps_hint is None:
        fps_hint = (
            index.sample_count / index.duration_seconds
            if index.duration_seconds else 25.0
        )
    need = int((target_pts - kf.pts_seconds) * fps_hint) + 4
    need = max(need, 1)
    got = decode_from_keyframe(index.path, kf.pts_seconds, need)
    if not got:
        return SeekResult(
            False, lookup=lookup, target_pts=target_pts,
            reason=f"decode from keyframe @{kf.pts_seconds:.3f}s "
                   "(offset {kf.file_offset}) produced no frames: "
                   "seek point may be corrupt or unsupported codec",
        )
    if got[-1][0] < target_pts - 1e-6:
        return SeekResult(
            False, lookup=lookup, target_pts=target_pts,
            frames_decoded=len(got),
            reason=f"decode from keyframe @{kf.pts_seconds:.3f}s stopped "
                   f"at {got[-1][0]:.3f}s before target {target_pts:.3f}s: "
                   "stream ended early or frames were dropped",
        )

    # the frame carrying the target presentation timestamp
    hit = next((m for p, m in got if abs(p - target_pts) < 1e-6), None)
    if hit is None:
        return SeekResult(
            False, lookup=lookup, target_pts=target_pts,
            frames_decoded=len(got),
            reason=f"no frame with pts {target_pts:.3f}s in decode from "
                   f"keyframe @{kf.pts_seconds:.3f}s: timestamp mismatch "
                   "(check edit list / timebase handling)",
        )
    return SeekResult(
        hit == target_md5,
        lookup=lookup,
        target_frame=ti,
        target_pts=target_pts,
        frames_decoded=len(got),
        hash_match=hit == target_md5,
        reason="" if hit == target_md5 else
        f"pixel hash mismatch at pts {target_pts:.3f}s "
        f"(got {hit}, want {target_md5})",
    )


def extract_thumbnail(index: VideoIndex, keyframe, out_path):
    """Decode only the GOP first frame at `keyframe` into a JPEG."""
    cmd = [
        FFMPEG, "-y", "-v", "error",
        "-ss", f"{keyframe.pts_seconds:.6f}", "-i", index.path,
        "-frames:v", "1", "-q:v", "3", out_path,
    ]
    r = _run(cmd)
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f"thumbnail failed: {r.stderr.strip()[:300]}")
    return out_path
