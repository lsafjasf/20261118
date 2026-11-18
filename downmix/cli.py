"""Command line interface for the 5.1 -> stereo downmix toolkit."""

from __future__ import annotations

import argparse
import json
import math
import sys

from .engine import DownmixConfig, downmix
from .meters import analyze
from .wavio import read_wav, write_wav


def _normalize_channel(raw: str) -> str:
    """Accept L, R, C, LFE, LS/RS (or LSS/RSS) and map to canonical names."""
    token = raw.strip().lower()
    aliases = {
        "l": "L",
        "r": "R",
        "c": "C",
        "lfe": "LFE",
        "sub": "LFE",
        "ls": "Ls",
        "lss": "Ls",
        "sl": "Ls",
        "rs": "Rs",
        "rss": "Rs",
        "sr": "Rs",
    }
    if token not in aliases:
        raise argparse.ArgumentTypeError("unknown channel %r" % raw)
    return aliases[token]


def _parse_gain(items):
    gains = {}
    for item in items or []:
        if "=" not in item:
            raise argparse.ArgumentTypeError(
                "gain must look like L=-2, got %r" % item
            )
        name_token, raw = item.split("=", 1)
        name = _normalize_channel(name_token)
        value = raw.strip().lower()
        gains[name] = float("-inf") if value in ("mute", "off", "-inf") \
            else float(value)
    return gains


def _parse_set(items):
    names = set()
    for item in items or []:
        for token in item.split(","):
            if token.strip():
                names.add(_normalize_channel(token))
    return names


def build_parser():
    parser = argparse.ArgumentParser(
        prog="downmix",
        description="Configurable 5.1 to stereo downmixer with metering.",
    )
    parser.add_argument("input", nargs="?", help="input 5.1 WAV file")
    parser.add_argument("-o", "--output", help="stereo output WAV path")
    parser.add_argument(
        "-g", "--gain", action="append", default=[],
        help="per-channel gain in dB, e.g. C=-6 or LFE=-10 (repeatable); "
             "LFE=mute silences it",
    )
    parser.add_argument(
        "-d", "--dialogue-protection", type=float, default=0.0,
        help="extra dB applied to the centre dialogue channel",
    )
    parser.add_argument(
        "-s", "--solo", action="append", default=[],
        help="solo channel(s), comma separated, e.g. -s C",
    )
    parser.add_argument(
        "-m", "--mute", action="append", default=[],
        help="mute channel(s), comma separated",
    )
    parser.add_argument(
        "--hard-clip", action="store_true",
        help="disable tanh soft clipping on the stereo bus",
    )
    parser.add_argument(
        "--pcm", choices=("pcm16", "pcm24"), default="float32",
        help="output sample format (default float32)",
    )
    parser.add_argument(
        "--report", choices=("text", "json"), default="text",
        help="statistics report format",
    )
    parser.add_argument(
        "--make-test-clip", metavar="PATH",
        help="write a synthetic 5.1 test clip and exit",
    )
    parser.add_argument(
        "--tui", action="store_true",
        help="open the interactive curses metering console",
    )
    parser.add_argument(
        "--gui", action="store_true",
        help="open the Tkinter window (requires a desktop Python with Tk)",
    )
    return parser


def config_from_args(args):
    return DownmixConfig(
        gain_db=_parse_gain(args.gain),
        dialogue_protection_db=args.dialogue_protection,
        solo=_parse_set(args.solo),
        muted=_parse_set(args.mute),
        soft_clip=not args.hard_clip,
    )


def _fmt_db(value):
    if value == float("-inf") or math.isinf(value):
        return "  -inf"
    return "%6.2f" % value


def render_text_report(result, pre_peak, output_path, encoded_clips):
    lines = []
    lines.append("== Input channel statistics ==")
    lines.append(
        "ch    RMS(dBFS)  peak(dBFS)  crest(dB)  clips  samples"
    )
    for stat in result["input_stats"]:
        lines.append(
            "%-4s  %s   %s    %s  %5d  %8d"
            % (
                stat.name, _fmt_db(stat.rms_db), _fmt_db(stat.peak_db),
                _fmt_db(stat.crest_factor_db), stat.clip_count,
                stat.sample_count,
            )
        )
    lines.append("")
    lines.append("== Stereo output ==")
    for stat in result["output_stats"]:
        lines.append(
            "%-5s RMS %s dBFS  peak %s dBFS  clips %d"
            % (stat.name, _fmt_db(stat.rms_db), _fmt_db(stat.peak_db),
               stat.clip_count)
        )
    lines.append(
        "pre-saturation bus peak: L=%.4f R=%.4f"
        % (pre_peak["L"], pre_peak["R"])
    )
    if output_path:
        lines.append(
            "samples hard-clipped while encoding %s: %d"
            % (output_path, encoded_clips)
        )
    lines.append("")
    lines.append("== Fold-down diagnostics ==")
    lines.append(
        "stereo L/R correlation : %+.3f" % result["stereo_correlation"]
    )
    lines.append(
        "centre dominance       : %.1f%%"
        % (result["center_dominance"] * 100.0)
    )
    lines.append(
        "surround retention     : %.1f%%"
        % (result["surround_retention"] * 100.0)
    )
    lines.append(
        "surround cancellation  : %.3f" % result["surround_cancellation"]
    )
    lines.append("")
    if result["warnings"]:
        lines.append("WARNINGS:")
        for warning in result["warnings"]:
            lines.append("  - " + warning)
    else:
        lines.append("no diagnostic warnings")
    return "\n".join(lines)


def run(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.make_test_clip:
        from .clipgen import write_test_clip
        path, table = write_test_clip(args.make_test_clip)
        print("wrote test clip %s" % path)
        for name, length in table:
            print("  segment %-22s %6d frames" % (name, length))
        return 0

    if not args.input:
        parser.error("an input WAV is required (or use --make-test-clip)")

    config = config_from_args(args)
    samples, rate, nch = read_wav(args.input)
    if nch != 6:
        parser.error(
            "input has %d channels; a 6-channel 5.1 file is required" % nch
        )

    if args.gui:
        from .gui_tk import launch
        launch(args.input, args.output)
        return 0

    if args.tui:
        from .tui import run_tui
        return run_tui(samples, rate, config, args)

    stereo, pre_peak = downmix(samples, nch, config)
    encoded_clips = 0
    if args.output:
        encoded_clips = write_wav(
            args.output, stereo, rate, 2, subtype=args.pcm
        )
    result = analyze(samples, nch, stereo, config)

    if args.report == "json":
        payload = {
            "sample_rate": rate,
            "frames": len(samples) // nch,
            "gains_db": config.gain_db,
            "dialogue_protection_db": config.dialogue_protection_db,
            "solo": sorted(config.solo),
            "muted": sorted(config.muted),
            "input_stats": [s.as_dict() for s in result["input_stats"]],
            "output_stats": [s.as_dict() for s in result["output_stats"]],
            "pre_clip_bus_peak": pre_peak,
            "encoded_clipped_samples": encoded_clips,
            "stereo_correlation": result["stereo_correlation"],
            "center_dominance": result["center_dominance"],
            "surround_retention": result["surround_retention"],
            "surround_cancellation": result["surround_cancellation"],
            "warnings": result["warnings"],
        }
        print(json.dumps(payload, indent=2, default=_json_safe))
    else:
        print(render_text_report(result, pre_peak, args.output, encoded_clips))
    return 0


def _json_safe(value):
    if value == float("-inf"):
        return "-inf"
    if isinstance(value, float) and math.isinf(value):
        return "inf"
    return str(value)


def main():  # console-script entry point
    sys.exit(run())


if __name__ == "__main__":
    main()
