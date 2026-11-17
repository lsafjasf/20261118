#!/usr/bin/env python3
"""HLS media playlist doctor.

Commands:
  diagnose  Parse a media playlist and report missing segment files,
            duplicate sequence entries and a wrong EXT-X-TARGETDURATION.
  repair    Fill missing segments from a backup source (matched by media
            sequence), rebuild a temporary playlist and write a JSON
            report. Backup segments whose duration does not match the
            expected slot are marked non-replaceable and omitted.
  verify    Check a playlist is complete and decodable end to end
            (proxy for a <video> element playing to the end).
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
DURATION_TOLERANCE = 0.4  # seconds; ~a few frames of leeway


class Segment:
    def __init__(self, seq, uri, duration):
        self.seq = seq
        self.uri = uri
        self.duration = duration

    def to_dict(self):
        return {"seq": self.seq, "uri": self.uri,
                "duration": round(self.duration, 3)}


class Playlist:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.target_duration = None
        self.media_sequence = 0
        self.segments = []
        self.has_endlist = False
        self._parse()

    def _parse(self):
        pending_inf = None
        with open(self.path) as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                if line.startswith("#EXT-X-TARGETDURATION:"):
                    self.target_duration = int(line.split(":", 1)[1])
                elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                    self.media_sequence = int(line.split(":", 1)[1])
                elif line.startswith("#EXTINF:"):
                    pending_inf = float(
                        line.split(":", 1)[1].split(",", 1)[0])
                elif line.startswith("#EXT-X-ENDLIST"):
                    self.has_endlist = True
                elif line.startswith("#"):
                    continue
                else:
                    seq = self.media_sequence + len(self.segments)
                    self.segments.append(
                        Segment(seq, line, pending_inf or 0.0))
                    pending_inf = None

    def file_path(self, seg):
        return os.path.join(self.dir, seg.uri)


def probe_duration(path):
    """Actual media duration via ffprobe, or None if unreadable."""
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            check=True, capture_output=True, text=True)
        return float(out.stdout.strip())
    except (subprocess.CalledProcessError, ValueError):
        return None


def diagnose(path):
    pl = Playlist(path)
    issues = {"playlist": pl.path, "missing_segments": [],
              "duplicate_sequences": [], "target_duration": None}

    seen = {}
    for seg in pl.segments:
        if not os.path.exists(pl.file_path(seg)):
            issues["missing_segments"].append({
                "seq": seg.seq, "uri": seg.uri,
                "expected_duration": round(seg.duration, 3)})
        if seg.uri in seen:
            issues["duplicate_sequences"].append({
                "uri": seg.uri,
                "sequences": [seen[seg.uri], seg.seq]})
        else:
            seen[seg.uri] = seg.seq

    if pl.segments:
        required = math.ceil(max(s.duration for s in pl.segments))
        if pl.target_duration != required:
            issues["target_duration"] = {
                "declared": pl.target_duration,
                "required": required,
                "max_extinf": round(
                    max(s.duration for s in pl.segments), 3)}
    return pl, issues


def cmd_diagnose(args):
    _, issues = diagnose(args.playlist)
    print(json.dumps(issues, indent=2))
    bad = (issues["missing_segments"] or issues["duplicate_sequences"]
           or issues["target_duration"])
    return 1 if bad else 0


def continuity_note(timeline, seq, expected, actual):
    """Describe whether inserting `actual` seconds at `seq` keeps the
    cumulative EXTINF timeline consistent."""
    drift = abs(expected - actual)
    return {
        "seq": seq,
        "timeline_offset": round(timeline, 3),
        "expected_duration": round(expected, 3),
        "inserted_duration": round(actual, 3),
        "drift": round(drift, 3),
        "ok": drift <= DURATION_TOLERANCE,
    }


def cmd_repair(args):
    main_pl, issues = diagnose(args.main)
    backup_pl = Playlist(args.backup)
    backup_by_uri = {s.uri: s for s in backup_pl.segments}

    out_dir = os.path.abspath(args.out)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)

    report = {"main": main_pl.path, "backup": backup_pl.path,
              "issues": issues, "replacements": [], "omitted": []}

    # Drop duplicate entries: keep the first occurrence of each URI.
    seen = set()
    unique_segments = []
    for seg in main_pl.segments:
        if seg.uri in seen:
            continue
        seen.add(seg.uri)
        unique_segments.append(seg)

    # Renumber after de-duplication so sequence numbers are contiguous.
    for idx, seg in enumerate(unique_segments):
        seg.seq = main_pl.media_sequence + idx

    rebuilt_entries = []  # (kind, Segment|None) kind: seg|discontinuity
    timeline = 0.0
    gap_pending = False
    for seg in unique_segments:
        local = main_pl.file_path(seg)
        if os.path.exists(local):
            shutil.copy(local, os.path.join(out_dir, seg.uri))
            if gap_pending:
                rebuilt_entries.append(("discontinuity", None))
                gap_pending = False
            rebuilt_entries.append(("seg", seg))
            timeline += seg.duration
            continue

        # Missing locally: try the backup source, same media sequence.
        cand = backup_by_uri.get(seg.uri)
        entry = {"seq": seg.seq, "uri": seg.uri,
                 "expected_duration": round(seg.duration, 3)}
        if cand is None or not os.path.exists(
                backup_pl.file_path(cand)):
            entry.update({"replaceable": False,
                          "reason": "not available in backup source"})
            report["replacements"].append(entry)
            report["omitted"].append({"seq": seg.seq, "uri": seg.uri,
                                      "reason": entry["reason"]})
            gap_pending = True
            continue

        actual = probe_duration(backup_pl.file_path(cand))
        entry["source"] = backup_pl.file_path(cand)
        entry["duration"] = (round(actual, 3)
                             if actual is not None else None)
        if actual is None:
            entry.update({"replaceable": False,
                          "reason": "backup segment unreadable"})
        elif abs(actual - seg.duration) > DURATION_TOLERANCE:
            entry.update({
                "replaceable": False,
                "reason": "duration mismatch: backup %.3fs vs "
                          "expected %.3fs" % (actual, seg.duration)})
        else:
            cont = continuity_note(timeline, seg.seq,
                                   seg.duration, actual)
            entry.update({"replaceable": True, "continuity": cont})
            shutil.copy(backup_pl.file_path(cand),
                        os.path.join(out_dir, seg.uri))
            if gap_pending:
                rebuilt_entries.append(("discontinuity", None))
                gap_pending = False
            rebuilt_entries.append(("seg", seg))
            timeline += actual
        if not entry["replaceable"]:
            report["omitted"].append({"seq": seg.seq, "uri": seg.uri,
                                      "reason": entry["reason"]})
            gap_pending = True
        report["replacements"].append(entry)

    # Rebuild the temporary playlist with a corrected target duration.
    present = [s for kind, s in rebuilt_entries if kind == "seg"]
    target = math.ceil(max(s.duration for s in present)) if present else 0
    lines = ["#EXTM3U", "#EXT-X-VERSION:3",
             "#EXT-X-TARGETDURATION:%d" % target,
             "#EXT-X-MEDIA-SEQUENCE:%d" % main_pl.media_sequence]
    for kind, seg in rebuilt_entries:
        if kind == "discontinuity":
            lines.append("#EXT-X-DISCONTINUITY")
        else:
            lines.append("#EXTINF:%.3f," % seg.duration)
            lines.append(seg.uri)
    lines.append("#EXT-X-ENDLIST")
    rebuilt_path = os.path.join(out_dir, "index.m3u8")
    with open(rebuilt_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    report["rebuilt_playlist"] = rebuilt_path
    report["corrected_target_duration"] = target
    report["segment_count"] = len(present)
    report["total_duration"] = round(
        sum(s.duration for s in present), 3)
    report_path = os.path.join(out_dir, "repair-report.json")
    with open(report_path, "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report, indent=2))
    print("report written to %s" % report_path, file=sys.stderr)
    return 0


def cmd_verify(args):
    pl, issues = diagnose(args.playlist)
    problems = []
    if issues["missing_segments"]:
        problems.append("missing segments: %s"
                        % issues["missing_segments"])
    if issues["duplicate_sequences"]:
        problems.append("duplicate sequences: %s"
                        % issues["duplicate_sequences"])
    if issues["target_duration"]:
        problems.append("bad target duration: %s"
                        % issues["target_duration"])
    if not pl.has_endlist:
        problems.append("missing #EXT-X-ENDLIST")

    expected = sum(s.duration for s in pl.segments)
    decoded = None
    if not problems:
        # Decode the whole playlist; a <video> element must be able to
        # reach the last frame, so any decode error is a failure.
        proc = subprocess.run(
            [FFMPEG, "-v", "error", "-i", pl.path,
             "-f", "null", "-"],
            capture_output=True, text=True)
        if proc.returncode != 0:
            problems.append("decode failed: %s" % proc.stderr.strip())
        else:
            durations = [probe_duration(pl.file_path(s))
                         for s in pl.segments]
            decoded = sum(d for d in durations if d is not None)
            if abs(decoded - expected) > DURATION_TOLERANCE * max(
                    1, len(pl.segments)):
                problems.append(
                    "decoded duration %.3fs != playlist %.3fs"
                    % (decoded, expected))

    result = {"playlist": pl.path,
              "segments": len(pl.segments),
              "playlist_duration": round(expected, 3),
              "decoded_duration": (round(decoded, 3)
                                   if decoded is not None else None),
              "plays_to_end": not problems,
              "problems": problems}
    print(json.dumps(result, indent=2))
    return 0 if not problems else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("diagnose")
    p.add_argument("playlist")
    p.set_defaults(func=cmd_diagnose)
    p = sub.add_parser("repair")
    p.add_argument("--main", required=True)
    p.add_argument("--backup", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_repair)
    p = sub.add_parser("verify")
    p.add_argument("playlist")
    p.set_defaults(func=cmd_verify)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
