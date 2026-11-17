from __future__ import annotations

import argparse
import json

from .mpdparser import build_initialization_url, parse_mpd
from .player import simulate_playback, verify_seek_consistency
from .reporting import (
    render_issues,
    render_json,
    render_playback,
    render_seek,
    render_segments,
)
from .seek import seek
from .timeline import empty_urls_from_store, mark_empty_segments, validate_manifest

DEFAULT_SEEK_TIMES = [0.5, 4.5, 7.0, 9.5, 11.0, 16.5, 18.0, 21.0, 23.0, -1.0]


def _load_store(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def cmd_segments(args: argparse.Namespace) -> None:
    manifest = parse_mpd(args.mpd)
    if args.store:
        validate_manifest(manifest, _load_store(args.store))
    print(render_segments(manifest))


def cmd_issues(args: argparse.Namespace) -> None:
    manifest = parse_mpd(args.mpd)
    issues = validate_manifest(manifest, _load_store(args.store))
    print(render_issues(issues))


def cmd_seek(args: argparse.Namespace) -> None:
    manifest = parse_mpd(args.mpd)
    if args.store:
        store = _load_store(args.store)
        mark_empty_segments(manifest, empty_urls_from_store(store))
    for time_s in args.time:
        print(render_seek(seek(manifest, float(time_s), args.representation)))


def cmd_verify(args: argparse.Namespace) -> None:
    manifest = parse_mpd(args.mpd)
    store = _load_store(args.store)
    issues = validate_manifest(manifest, store)
    report = simulate_playback(manifest, store, args.representation)
    seek_times = [float(value) for value in args.seek_time] or DEFAULT_SEEK_TIMES
    seek_results = [seek(manifest, time_s) for time_s in seek_times]
    seek_failures = verify_seek_consistency(manifest, store, seek_times)
    if args.json:
        print(render_json(manifest, issues, report, seek_results))
        return
    print(render_segments(manifest))
    print()
    print(render_issues(issues))
    print()
    print(render_playback(report))
    print()
    for result in seek_results:
        print(render_seek(result))
    print()
    if seek_failures:
        print("SEEK CONSISTENCY FAILURES:")
        for failure in seek_failures:
            print(f"  - {failure}")
        raise SystemExit(1)
    print("seek/parse consistency verified OK")


def cmd_gen_store(args: argparse.Namespace) -> None:
    manifest = parse_mpd(args.mpd)
    empty = set(args.empty)
    store: dict = {
        "description": "Mock fMP4 segment objects; sample_count 0 marks an empty segment.",
        "initialization": {},
        "segments": {},
    }
    for period in manifest.periods:
        for representation in period.representations:
            tpl = representation.template
            init_pattern = tpl.initialization
            if init_pattern:
                store["initialization"][
                    f"{period.id}/{representation.id}"
                ] = build_initialization_url(init_pattern, representation.id)
            for segment in representation.segments:
                bmdt = segment.media_time - tpl.presentation_time_offset
                store["segments"][segment.url] = {
                    "base_media_decode_time": bmdt,
                    "timescale": tpl.timescale,
                    "media_duration_s": round(segment.duration_s, 6),
                    "sample_count": 0 if segment.url in empty else 240,
                    "starts_with_keyframe": (
                        tpl.sap_type is not None and 1 <= tpl.sap_type <= 3
                    ),
                }
    if args.orphan:
        store["segments"][args.orphan] = {
            "base_media_decode_time": 0,
            "timescale": 90000,
            "media_duration_s": 4.0,
            "sample_count": 1,
            "starts_with_keyframe": True,
        }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(store, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dashcheck",
        description="Inspect DASH SegmentTemplate timing and simulate player requests.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_segments = sub.add_parser("segments", help="List expanded segment URLs and times.")
    p_segments.add_argument("mpd")
    p_segments.add_argument("--store")
    p_segments.set_defaults(func=cmd_segments)

    p_issues = sub.add_parser("issues", help="Print all time-boundary issues.")
    p_issues.add_argument("mpd")
    p_issues.add_argument("store")
    p_issues.set_defaults(func=cmd_issues)

    p_seek = sub.add_parser("seek", help="Resolve playback time(s) to segments.")
    p_seek.add_argument("mpd")
    p_seek.add_argument("time", nargs="+")
    p_seek.add_argument("--representation")
    p_seek.add_argument("--store")
    p_seek.set_defaults(func=cmd_seek)

    p_verify = sub.add_parser("verify", help="Full validation plus player simulation.")
    p_verify.add_argument("mpd")
    p_verify.add_argument("store")
    p_verify.add_argument("--representation")
    p_verify.add_argument("--seek-time", action="append", default=[])
    p_verify.add_argument("--json", action="store_true")
    p_verify.set_defaults(func=cmd_verify)

    p_gen = sub.add_parser("gen-store", help="Generate mock segment store from an MPD.")
    p_gen.add_argument("mpd")
    p_gen.add_argument("output")
    p_gen.add_argument(
        "--empty", action="append", default=[], help="URL to mark as an empty segment."
    )
    p_gen.add_argument("--orphan", help="Add an unreferenced store object.")
    p_gen.set_defaults(func=cmd_gen_store)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
