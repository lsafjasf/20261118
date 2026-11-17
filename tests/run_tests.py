"""End-to-end tests for the keyframe browser.

Generates long-GOP, short-GOP, non-zero-edit-list and all-intra test
videos, then verifies that keyframe lookup results are usable for
precise decode (pixel-hash comparison against full-decode reference)
and that miss cases report the right reasons.

Run: python3 tests/run_tests.py
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kfbrowser import build_index, precise_seek, extract_thumbnail  # noqa: E402
from kfbrowser.seeker import FFMPEG  # noqa: E402

VIDEOS = os.path.join(os.path.dirname(__file__), "videos")
SRC = "testsrc2=size=320x240:rate=25:duration=10"

SPECS = {
    "long_gop.mp4": ["-f", "lavfi", "-i", SRC, "-c:v", "libx264",
                     "-g", "240", "-bf", "2", "-pix_fmt", "yuv420p"],
    "short_gop.mp4": ["-f", "lavfi", "-i", SRC, "-c:v", "libx264",
                      "-g", "12", "-bf", "2", "-pix_fmt", "yuv420p"],
    "all_intra.mp4": ["-f", "lavfi", "-i",
                      "testsrc2=size=320x240:rate=25:duration=4",
                      "-c:v", "mjpeg", "-q:v", "5"],
}

PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    tag = "PASS" if cond else "FAIL"
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print(f"[{tag}] {name}" + (f" -- {detail}" if detail else ""))


def generate():
    os.makedirs(VIDEOS, exist_ok=True)
    for name, args in SPECS.items():
        out = os.path.join(VIDEOS, name)
        if not os.path.exists(out):
            subprocess.run([FFMPEG, "-v", "error", "-y", *args, out],
                           check=True)
    edit = os.path.join(VIDEOS, "edit_list.mp4")
    if not os.path.exists(edit):
        subprocess.run(
            [FFMPEG, "-v", "error", "-y", "-ss", "1.52", "-i",
             os.path.join(VIDEOS, "short_gop.mp4"), "-c", "copy", edit],
            check=True)


def test_index(name, expect_elst=False):
    idx = build_index(os.path.join(VIDEOS, name))
    gop = idx.gop_interval
    print(f"\n== {name}: {len(idx.keyframes)} keyframes, "
          f"GOP ~{f'{gop:.3f}s' if gop else 'n/a'}, "
          f"edit-list offset {idx.media_time_offset:.3f}s")
    check(f"{name}: keyframes found", len(idx.keyframes) > 0)
    check(f"{name}: offsets valid",
          all(k.file_offset >= 0 and k.size > 0 for k in idx.keyframes))
    if expect_elst:
        check(f"{name}: non-zero edit list", idx.media_time_offset != 0)
    return idx


def test_seek(idx, targets):
    for t in targets:
        r = precise_seek(idx, t)
        check(f"{os.path.basename(idx.path)} seek t={t}",
              r.ok and r.hash_match,
              r.reason if not r.ok else
              f"kf@{r.lookup.keyframe.pts_seconds:.3f}s "
              f"frame {r.target_frame}, {r.frames_decoded} frames decoded")


def test_misses(idx):
    r = precise_seek(idx, -1.0)
    check("miss: negative time",
          not r.ok and r.lookup.reason_code == "NEGATIVE_TIME", r.reason)
    r = precise_seek(idx, idx.duration_seconds + 10)
    check("miss: beyond duration",
          not r.ok and r.lookup.reason_code == "BEYOND_DURATION", r.reason)


def test_thumbnail(idx, tmp="/tmp/kfbrowser_test_thumb.jpg"):
    kf = idx.keyframes[-1]
    extract_thumbnail(idx, kf, tmp)
    ok = os.path.getsize(tmp) > 1000
    check("thumbnail decodes", ok, f"{tmp} {os.path.getsize(tmp)} bytes")


def main():
    generate()
    long_idx = test_index("long_gop.mp4")
    short_idx = test_index("short_gop.mp4")
    edit_idx = test_index("edit_list.mp4", expect_elst=True)
    intra_idx = test_index("all_intra.mp4")

    check("long GOP interval > short GOP interval",
          long_idx.gop_interval > short_idx.gop_interval,
          f"{long_idx.gop_interval:.3f}s vs {short_idx.gop_interval:.3f}s")

    for idx in (long_idx, short_idx, edit_idx):
        test_seek(idx, [0.5, 3.3, 7.7])
    test_seek(intra_idx, [0.5, 2.0, 3.5])
    test_seek(edit_idx, [0.0, 8.5])   # edit-list edge region
    test_misses(short_idx)
    test_misses(edit_idx)
    test_thumbnail(long_idx)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
