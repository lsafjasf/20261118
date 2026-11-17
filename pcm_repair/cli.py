"""Command-line interface for the PCM repair tool."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path

from .audio import read_wav, write_wav
from .detector import DetectionConfig, repair_audio
from .metrics import compare_audio, metrics_payload, result_payload
from .waveform import render_waveform_svg


def _changed_peak(before, after, result) -> float:
    peak = 0.0
    for channel, start, end in result.channel_intervals:
        for frame in range(start, end):
            peak = max(
                peak,
                abs(after.samples[channel][frame] - before.samples[channel][frame]),
            )
    return peak


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repair isolated PCM transient damage while preserving drum attacks."
    )
    parser.add_argument("input", help="damaged PCM WAV (A)")
    parser.add_argument("-o", "--output", required=True, help="repaired PCM WAV (B)")
    parser.add_argument("--reference", help="optional clean WAV for error measurement")
    parser.add_argument("--report", help="JSON report path (default: alongside output)")
    parser.add_argument("--waveform", help="SVG path (default: alongside output)")
    parser.add_argument("--no-waveform", action="store_true", help="skip SVG rendering")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    damaged = read_wav(args.input)
    config = DetectionConfig()
    result = repair_audio(damaged, config)
    output = Path(args.output)
    write_wav(output, result.audio)

    report_path = Path(args.report) if args.report else output.with_suffix(".json")
    waveform_path = Path(args.waveform) if args.waveform else output.with_suffix(".svg")
    report: dict[str, object] = {
        "tool": "pcm_repair",
        "input": str(Path(args.input)),
        "output": str(output),
        "audio": {
            "sample_rate": damaged.sample_rate,
            "channels": damaged.channels,
            "sample_width_bytes": damaged.sample_width,
            "frames": damaged.frames,
            "duration_s": damaged.duration,
        },
        "detector": asdict(config),
        "repair": result_payload(result),
        "max_abs_correction": _changed_peak(damaged, result.audio, result),
    }
    if args.reference:
        reference = read_wav(args.reference)
        metrics = compare_audio(reference, result.audio, result, damaged)
        report["reference_error"] = metrics_payload(metrics)

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if not args.no_waveform:
        render_waveform_svg(damaged, result.audio, result.intervals, waveform_path)

    print(f"A (damaged):  {Path(args.input)}")
    print(f"B (repaired): {output}")
    print(
        f"Repaired {result.interval_count} interval(s), "
        f"{result.modified_frames} frame(s), "
        f"{result.sample_changes} PCM sample value(s)."
    )
    print(f"Rejected as percussion: {result.rejected_percussive_groups} candidate group(s).")
    print(f"Report: {report_path}")
    if not args.no_waveform:
        print(f"Waveform: {waveform_path}")
    return 0
