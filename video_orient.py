#!/usr/bin/env python3
"""Inspect and physically normalize video orientation.

Distinguishes container-level orientation metadata (MOV/MP4 display matrix
and the legacy ``rotate`` tag) from the actual decoded pixel dimensions, and
optionally bakes the orientation into the pixels while stripping every
duplicate rotation marker so the output cannot be rotated a second time.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys


def _resolve_bins() -> tuple[str, str]:
    here = os.path.dirname(os.path.abspath(__file__))
    bundled = os.path.join(here, "bin")
    ffmpeg = os.path.join(bundled, "ffmpeg")
    ffprobe = os.path.join(bundled, "ffprobe")
    if not (os.path.exists(ffmpeg) and os.path.exists(ffprobe)):
        found = shutil.which("ffmpeg")
        if not found or not shutil.which("ffprobe"):
            sys.exit("error: ffmpeg/ffprobe not found (expected ./bin or PATH)")
        ffmpeg, ffprobe = found, shutil.which("ffprobe")
    return ffmpeg, ffprobe


FFMPEG, FFPROBE = _resolve_bins()


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        raise SystemExit(f"error: executable not found: {cmd[0]}")
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            f"command failed ({exc.returncode}): {' '.join(cmd)}\n"
            f"{exc.stderr.strip()}"
        )


def probe(path: str) -> dict:
    cmd = [
        FFPROBE,
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
    ]
    proc = run(cmd)
    return json.loads(proc.stdout)


def first_video_stream(meta: dict) -> dict | None:
    for stream in meta.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    return None


def parse_display_matrix(stream: dict) -> tuple[list[list[int]] | None, int | None]:
    """Return the raw 3x3 fixed-point matrix and ffmpeg's rotation angle."""
    matrix = None
    rotation = None
    for side in stream.get("side_data_list", []):
        if side.get("side_data_type") != "Display Matrix":
            continue
        rotation = side.get("rotation")
        raw = side.get("displaymatrix", "")
        rows: list[list[int]] = []
        for line in raw.splitlines():
            if ":" not in line:
                continue
            values = [int(token) for token in line.split(":", 1)[1].split()]
            if values:
                rows.append(values)
        if len(rows) == 3 and all(len(row) == 3 for row in rows):
            matrix = rows
    return matrix, rotation


def classify_orientation(matrix: list[list[int]] | None) -> dict:
    """Classify the 2x2 affine block into rotation + optional flip."""
    if matrix is None:
        return {"rotation": 0, "hflip": False, "vflip": False, "identity": True}
    one = 1 << 16
    a, b = matrix[0][0], matrix[0][1]
    c, d = matrix[1][0], matrix[1][1]
    patterns = {
        (one, 0, 0, one): (0, False, False),
        (0, -one, one, 0): (90, False, False),
        (-one, 0, 0, -one): (180, False, False),
        (0, one, -one, 0): (270, False, False),
        (-one, 0, 0, one): (0, True, False),
        (0, one, one, 0): (90, True, False),
        (one, 0, 0, -one): (0, False, True),
        (0, -one, -one, 0): (270, False, True),
    }
    match = patterns.get((a, b, c, d))
    if match is None:
        return {"rotation": None, "hflip": None, "vflip": None, "identity": False}
    rotation, hflip, vflip = match
    return {
        "rotation": rotation,
        "hflip": hflip,
        "vflip": vflip,
        "identity": rotation == 0 and not hflip and not vflip,
    }


def legacy_rotate_tag(stream: dict, meta: dict) -> str | None:
    value = stream.get("tags", {}).get("rotate")
    if value is None:
        value = meta.get("format", {}).get("tags", {}).get("rotate")
    return value


def display_dimensions(stream: dict, orientation: dict) -> tuple[int, int]:
    width = int(stream["width"])
    height = int(stream["height"])
    if orientation["rotation"] in (90, 270):
        return height, width
    return width, height


def build_report(path: str) -> dict:
    meta = probe(path)
    stream = first_video_stream(meta)
    if stream is None:
        raise SystemExit(f"error: no video stream found in {path}")
    matrix, side_rotation = parse_display_matrix(stream)
    orientation = classify_orientation(matrix)
    legacy = legacy_rotate_tag(stream, meta)
    marker_sources = []
    if matrix is not None and not orientation["identity"]:
        marker_sources.append("display_matrix")
    if legacy is not None:
        marker_sources.append("legacy_rotate_tag")
    effective = dict(orientation)
    if "display_matrix" not in marker_sources and legacy is not None:
        effective = {"rotation": int(legacy) % 360, "hflip": False,
                     "vflip": False, "identity": False}
    display_width, display_height = display_dimensions(stream, effective)
    needs_normalization = (
        (bool(marker_sources) and not orientation["identity"])
        or legacy is not None
    )
    return {
        "file": os.path.abspath(path),
        "codec": stream.get("codec_name"),
        "decoded_pixels": {
            "width": int(stream["width"]),
            "height": int(stream["height"]),
        },
        "display": {
            "width": display_width,
            "height": display_height,
        },
        "orientation": orientation,
        "effective_orientation": effective,
        "matrix_rotation_reported": side_rotation,
        "legacy_rotate_tag": legacy,
        "marker_sources": marker_sources,
        "duplicate_markers": len(marker_sources) > 1,
        "needs_normalization": needs_normalization,
    }


def print_report(report: dict) -> None:
    pixels = report["decoded_pixels"]
    display = report["display"]
    orient = report["effective_orientation"]
    print(f"file            : {report['file']}")
    print(f"codec           : {report['codec']}")
    print(
        "decoded pixels  : "
        f"{pixels['width']}x{pixels['height']}  (actual H.264/HEVC sample grid)"
    )
    print(
        "display size    : "
        f"{display['width']}x{display['height']}  (after applying container matrix)"
    )
    if orient["rotation"] is None:
        print("rotation/flip   : non-standard matrix, manual review required")
    else:
        flips = []
        if orient["hflip"]:
            flips.append("hflip")
        if orient["vflip"]:
            flips.append("vflip")
        flip_text = f", flip={'+'.join(flips)}" if flips else ""
        print(
            f"rotation/flip   : {orient['rotation']} deg CCW{flip_text} "
            "(container metadata, pixels untouched)"
        )
    print(f"legacy rotate=  : {report['legacy_rotate_tag']}")
    print(f"marker sources  : {', '.join(report['marker_sources']) or 'none'}")
    if report["duplicate_markers"]:
        print("warning         : duplicate rotation markers detected")
    print(
        "normalization   : "
        + ("required" if report["needs_normalization"] else "not needed")
    )


def rotation_filter(rotation: int, hflip: bool, vflip: bool) -> str:
    parts = []
    if hflip:
        parts.append("hflip")
    if vflip:
        parts.append("vflip")
    if rotation == 90:
        parts.append("transpose=1")       # 90 degrees counter-clockwise
    elif rotation == 180:
        parts.append("transpose=1,transpose=1")
    elif rotation == 270:
        parts.append("transpose=2")       # 270 CCW == 90 clockwise
    return ",".join(parts)


def planned_orientation(report: dict) -> tuple[int, bool, bool]:
    """Resolve the effective physical orientation to bake.

    A display matrix always wins; a legacy rotate= tag only drives the
    physical transform when no matrix exists (ffmpeg >= 6 ignores the tag
    for autorotation).
    """
    orient = report["orientation"]
    if "display_matrix" in report["marker_sources"]:
        return orient["rotation"], orient["hflip"], orient["vflip"]
    if report["legacy_rotate_tag"] is not None:
        # The historical rotate= tag documented clockwise degrees, while
        # transpose/rotation_filter() speak counter-clockwise.
        angle = -int(report["legacy_rotate_tag"]) % 360
        return angle, False, False
    return 0, False, False


def normalize_command(input_path: str, output_path: str, crf: int,
                      preset: str, audio_codec: str, vf: str | None,
                      no_autorotate: bool) -> list[str]:
    # Two explicit, single-application paths:
    # * display matrix present -> ffmpeg's built-in autorotate consumes the
    #   matrix and bakes it (including flips) into the pixels exactly once;
    # * legacy rotate tag only  -> -noautorotate plus an explicit transpose,
    #   because modern ffmpeg no longer rotates on the tag.
    # -map_metadata -1 drops container tags; rotate= is blanked as well.
    cmd = [
        FFMPEG,
        "-y",
        "-i",
        input_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-crf",
        str(crf),
        "-preset",
        preset,
        "-pix_fmt",
        "yuv420p",
    ]
    if no_autorotate:
        cmd[2:2] = ["-noautorotate"]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-c:a",
        audio_codec,
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-metadata:s:v:0",
        "rotate=",
        "-movflags",
        "+faststart",
        output_path,
    ]
    return cmd


def verify_output(output_path: str, expected: dict) -> list[str]:
    report = build_report(output_path)
    errors = []
    if report["marker_sources"]:
        errors.append(
            "output still carries rotation markers: "
            + ", ".join(report["marker_sources"])
        )
    if report["legacy_rotate_tag"] is not None:
        errors.append("output still carries legacy rotate tag")
    out_pixels = report["decoded_pixels"]
    want = (expected["display"]["width"], expected["display"]["height"])
    got = (out_pixels["width"], out_pixels["height"])
    if got != want:
        errors.append(f"output pixels {got[0]}x{got[1]} != expected {want[0]}x{want[1]}")
    return errors


def normalize(input_path: str, output_path: str, *, crf: int, preset: str,
              audio_codec: str, assume_yes: bool, dry_run: bool) -> int:
    report = build_report(input_path)
    print_report(report)
    rotation, hflip, vflip = planned_orientation(report)
    has_matrix = "display_matrix" in report["marker_sources"]
    if has_matrix:
        vf, no_autorotate = None, False
    else:
        vf, no_autorotate = rotation_filter(rotation, hflip, vflip), True
    cmd = normalize_command(input_path, output_path, crf, preset,
                            audio_codec, vf, no_autorotate)
    if dry_run:
        print("\ndry-run command:")
        print(" ".join(cmd))
        return 0
    if not report["needs_normalization"]:
        print("\nno rotation metadata found; nothing to normalize")
        return 0
    if report["orientation"]["rotation"] is None:
        print(
            "\nwarning: non-standard display matrix (contains scaling or "
            "skew);\n         ffmpeg's autorotate will be used to interpret "
            "it, please review the result."
        )
        if not assume_yes:
            answer = input("continue anyway? [y/N] ")
            if answer.strip().lower() not in ("y", "yes"):
                print("aborted")
                return 1
    if not assume_yes:
        if not sys.stdin.isatty():
            print("error: refusing to transcode without a TTY; pass --yes")
            return 2
        answer = input(f"\nbake orientation into pixels -> {output_path}? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("aborted")
            return 1
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        return proc.returncode
    errors = verify_output(output_path, report)
    if errors:
        for error in errors:
            print(f"VERIFY FAIL: {error}")
        return 2
    print(f"\nwrote {output_path}")
    print("verify          : no rotation markers, pixel dimensions match display")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect video rotation metadata and physically normalize it."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", help="show pixel/display size and rotation")
    inspect_parser.add_argument("input")
    inspect_parser.add_argument("--json", action="store_true")

    norm = sub.add_parser("normalize", help="bake rotation into pixels and strip tags")
    norm.add_argument("input")
    norm.add_argument("output")
    norm.add_argument("--crf", type=int, default=18)
    norm.add_argument("--preset", default="medium")
    norm.add_argument(
        "--audio-codec",
        default="copy",
        help="copy keeps AAC bit-exact for sync testing; use aac to re-encode",
    )
    norm.add_argument("-y", "--yes", action="store_true", help="skip confirmation")
    norm.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "inspect":
        report = build_report(args.input)
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print_report(report)
        return 0
    return normalize(
        args.input,
        args.output,
        crf=args.crf,
        preset=args.preset,
        audio_codec=args.audio_codec,
        assume_yes=args.yes,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    raise SystemExit(main())
