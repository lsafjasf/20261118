#!/usr/bin/env python3
"""Generate the demo HLS sources used by playlist_tool.py.

Scenario:
  main/   9 segments (seq 0-8), TARGETDURATION deliberately wrong (4, real 6),
          seg4.ts listed twice (duplicate sequence), seg2.ts + seg5.ts missing.
  backup/ same 9 segments, seg5.ts re-encoded at 3.2s (duration mismatch),
          seg7.ts missing.
"""
import os
import shutil
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo")
SEG_COUNT = 9
SEG_DUR = 6.0
BAD_DUR = 3.2


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def encode_segment(path, duration):
    run([FFMPEG, "-y",
         "-f", "lavfi", "-i",
         "testsrc2=size=320x180:rate=30:duration=%s" % duration,
         "-f", "lavfi", "-i",
         "sine=frequency=440:duration=%s" % duration,
         "-c:v", "libx264", "-preset", "veryfast", "-g", "60",
         "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "64k",
         "-f", "mpegts", path])


def write_playlist(path, entries, target_duration, media_sequence=0):
    lines = ["#EXTM3U", "#EXT-X-VERSION:3",
             "#EXT-X-TARGETDURATION:%d" % target_duration,
             "#EXT-X-MEDIA-SEQUENCE:%d" % media_sequence]
    for uri, dur in entries:
        lines.append("#EXTINF:%.3f," % dur)
        lines.append(uri)
    lines.append("#EXT-X-ENDLIST")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")


def main():
    main_dir = os.path.join(ROOT, "main")
    backup_dir = os.path.join(ROOT, "backup")
    for d in (main_dir, backup_dir):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)

    for i in range(SEG_COUNT):
        encode_segment(os.path.join(backup_dir, "seg%d.ts" % i), SEG_DUR)

    # main/ starts as a copy of the good segments (before backup losses).
    for i in range(SEG_COUNT):
        if i == 5:
            continue
        src = os.path.join(backup_dir, "seg%d.ts" % i)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(main_dir, "seg%d.ts" % i))

    # backup seg5.ts: wrong duration on purpose; backup loses seg7.ts.
    encode_segment(os.path.join(backup_dir, "seg5.ts"), BAD_DUR)
    os.remove(os.path.join(backup_dir, "seg7.ts"))
    write_playlist(
        os.path.join(backup_dir, "index.m3u8"),
        [("seg%d.ts" % i, SEG_DUR) for i in range(SEG_COUNT)],
        target_duration=6,
    )

    encode_segment(os.path.join(main_dir, "seg5.ts"), SEG_DUR)
    os.remove(os.path.join(main_dir, "seg2.ts"))
    os.remove(os.path.join(main_dir, "seg5.ts"))

    entries = []
    for i in range(SEG_COUNT):
        entries.append(("seg%d.ts" % i, SEG_DUR))
        if i == 4:
            entries.append(("seg4.ts", SEG_DUR))
    write_playlist(os.path.join(main_dir, "index.m3u8"), entries,
                   target_duration=4)

    print("demo sources written under %s" % ROOT)
    print("  main:   9 segments, seg2.ts+seg5.ts missing, "
          "seg4.ts duplicated, TARGETDURATION=4 (wrong)")
    print("  backup: 9 segments, seg7.ts missing, seg5.ts duration=3.2s "
          "(mismatch)")


if __name__ == "__main__":
    sys.exit(main())
