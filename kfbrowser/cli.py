"""Command-line keyframe browser.

Usage:
  python3 -m kfbrowser.cli list  <video>
  python3 -m kfbrowser.cli thumb <video> <keyframe-index> <out.jpg>
  python3 -m kfbrowser.cli seek  <video> <target-seconds>
"""
from __future__ import annotations

import sys

from .mp4index import build_index
from .seeker import extract_thumbnail, precise_seek


def _print_table(index):
    gop = index.gop_interval
    gop_text = f"{gop:.3f}s" if gop is not None else "n/a (single GOP)"
    print(f"file: {index.path}")
    print(f"duration: {index.duration_seconds:.3f}s  "
          f"samples: {index.sample_count}  timescale: {index.timescale}")
    print(f"keyframes: {len(index.keyframes)}  "
          f"estimated GOP interval: {gop_text}")
    if index.media_time_offset:
        print(f"edit-list media offset: {index.media_time_offset:.3f}s")
    for note in index.notes:
        print(f"note: {note}")
    print(f"{'idx':>4} {'frame':>6} {'time(s)':>10} "
          f"{'file offset':>14} {'size':>8}")
    for i, kf in enumerate(index.keyframes):
        print(f"{i:>4} {kf.frame_number:>6} {kf.pts_seconds:>10.3f} "
              f"{kf.file_offset:>14} {kf.size:>8}")


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    index = build_index(path)
    if cmd == "list":
        _print_table(index)
        return 0
    if cmd == "thumb":
        kf = index.keyframes[int(argv[3])]
        out = extract_thumbnail(index, kf, argv[4])
        print(f"thumbnail of keyframe @{kf.pts_seconds:.3f}s -> {out}")
        return 0
    if cmd == "seek":
        result = precise_seek(index, float(argv[3]))
        if not result.ok:
            print(f"MISS: {result.reason}")
            return 1
        kf = result.lookup.keyframe
        print(f"HIT: keyframe frame={kf.frame_number} "
              f"pts={kf.pts_seconds:.3f}s offset={kf.file_offset}")
        print(f"decoded {result.frames_decoded} frames to target frame "
              f"{result.target_frame} (pts={result.target_pts:.3f}s); "
              f"hash match: {result.hash_match}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
