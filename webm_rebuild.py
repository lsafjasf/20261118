#!/usr/bin/env python3
"""Rebuild the Cues index of a damaged WebM file whose Clusters survive.

Usage:
  python3 webm_rebuild.py scan  damaged.webm
  python3 webm_rebuild.py fix   damaged.webm repaired.webm
  python3 webm_rebuild.py demo  [workdir]

The fix command never edits the source file: it writes a new file and copies
every original media byte verbatim, appending only a freshly built Cues.
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src import rebuilder
from src import seeker
from src import synth
from src.scanner import scan


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cluster_hash(path):
    """Hash only Cluster bytes, proving media data is untouched."""
    result = scan(path)
    with open(path, "rb") as handle:
        buf = handle.read()
    digest = hashlib.sha256()
    for index, start, end, _ in rebuilder.cluster_byte_ranges(result):
        digest.update(buf[start:end])
    return digest.hexdigest()


def print_scan(path):
    result = scan(path)
    print(f"file                 : {path} ({result.file_size} bytes)")
    seg_size = "unknown-size" if result.segment_size is None else result.segment_size
    print(f"segment              : offset={result.segment_abs_offset} size={seg_size}")
    print(f"segment data start   : {result.segment_data_start}")
    print(f"timestamp scale      : {result.timestamp_scale} ns")
    print(f"declared duration    : {result.duration_ms:.0f} ms")
    print("tracks:")
    for number, track in sorted(result.tracks.items()):
        extra = ""
        if track.pixel_width:
            extra = f" {track.pixel_width}x{track.pixel_height}"
        print(f"  #{number} {track.kind:5s} {track.codec_id}{extra}")
    print(f"clusters             : {len(result.clusters)}")
    if result.clusters:
        first, last = result.clusters[0], result.clusters[-1]
        print(f"  first              : tc={first.timecode_ms}ms "
              f"file_offset={first.abs_offset} rel={first.seg_relative_offset}")
        print(f"  last               : tc={last.timecode_ms}ms "
              f"file_offset={last.abs_offset} rel={last.seg_relative_offset}")
    print(f"existing Cues elements: {len(result.cues_elements)}")
    coverage = seeker.addressable_range(path)
    if coverage is None:
        print("cue coverage         : NONE (not addressable beyond start)")
    else:
        first_tc, last_tc, count = coverage
        print(f"cue coverage         : {first_tc}-{last_tc} ms over {count} entries")


def cmd_fix(src, dst):
    print(f"source sha256        : {sha256_of(src)}")
    report = rebuilder.repair_file(src, dst)
    print(f"repaired sha256      : {sha256_of(dst)}")
    print(f"source size          : {report['original_size']} bytes")
    print(f"repaired size        : {report['repaired_size']} bytes "
          f"(+{report['cues_size']} bytes Cues)")
    print(f"clusters media sha256: {cluster_hash(src)}")
    print(f"rebuilt  media sha256: {cluster_hash(dst)}")
    entries = report["entries"]
    print(f"cue entries rebuilt  : {len(entries)}")
    print("first 10 cue points (timecode_ms, track -> cluster byte offsets):")
    for timecode_ms, positions in entries[:10]:
        rendered = ", ".join(
            f"track {track} @ rel {offset} "
            f"(abs {report['result'].segment_data_start + offset})"
            for track, offset in sorted(positions.items())
        )
        print(f"  {timecode_ms:6d} ms -> {rendered}")


def cmd_demo(workdir):
    os.makedirs(workdir, exist_ok=True)
    damaged = os.path.join(workdir, "clip_damaged.webm")
    repaired = os.path.join(workdir, "clip_repaired.webm")

    print("== 1. generate synthetic 30 s VP8+Opus clip ==")
    blob, entries = synth.generate(duration_s=30)
    with open(damaged, "wb") as handle:
        handle.write(blob)
    good_hash = sha256_of(damaged)
    print(f"reference file       : {damaged} ({len(blob)} bytes, "
          f"{len(entries)} keyframe cues)")

    print("\n== 2. corrupt the Cues payload (Clusters stay untouched) ==")
    synth.corrupt_cues(damaged, mode="garbage")
    damaged_hash = sha256_of(damaged)
    print(f"hash changed by corruption: {good_hash != damaged_hash}")
    print_scan(damaged)

    print("\n== 3. rebuild Cues ==")
    cmd_fix(damaged, repaired)

    print("\n== 4. compare seek addressability at 10 time points ==")
    targets_ms = [1500, 4200, 7800, 11000, 14500,
                  18000, 21300, 24700, 27500, 29900]
    print("target_ms | damaged: landed (error)      | repaired: landed (error)  abs offset")
    rows = []
    for target in targets_ms:
        before = seeker.seek(damaged, target)
        after = seeker.seek(repaired, target)
        rows.append((target, before, after))
        before_text = (
            f"{before.landed_time_ms}ms ({before.seek_error_ms}ms)"
            if before.landed_time_ms is not None else "start only (no cue)"
        )
        after_text = (
            f"{after.landed_time_ms}ms ({after.seek_error_ms}ms)"
        )
        print(f"{target:9d} | {before_text:27s} | {after_text:25s} "
              f"{after.cluster_file_offset}")

    print("\n== 5. addressable range summary ==")
    before_range = seeker.addressable_range(damaged)
    after_range = seeker.addressable_range(repaired)
    print(f"damaged  : {before_range}")
    print(f"repaired : {after_range}")

    summary = {
        "damaged": {
            "path": damaged,
            "sha256": damaged_hash,
            "addressable": before_range,
        },
        "repaired": {
            "path": repaired,
            "sha256": sha256_of(repaired),
            "addressable": after_range,
            "media_cluster_sha256": cluster_hash(repaired),
        },
        "reference_sha256": good_hash,
        "media_unchanged": cluster_hash(damaged) == cluster_hash(repaired),
        "seeks": [
            {
                "target_ms": target,
                "damaged_landed_ms": before.landed_time_ms,
                "repaired_landed_ms": after.landed_time_ms,
                "repaired_error_ms": after.seek_error_ms,
                "cluster_abs_offset": after.cluster_file_offset,
                "cluster_rel_offset": after.cluster_relative_offset,
            }
            for target, before, after in rows
        ],
    }
    report_path = os.path.join(workdir, "report.json")
    with open(report_path, "w") as handle:
        json.dump(summary, handle, indent=2)
    print(f"\nmachine-readable report: {report_path}")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    command = argv[1]
    if command == "scan" and len(argv) == 3:
        print_scan(argv[2])
    elif command == "fix" and len(argv) == 4:
        cmd_fix(argv[2], argv[3])
    elif command == "demo":
        cmd_demo(argv[2] if len(argv) > 2 else "artifacts")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
