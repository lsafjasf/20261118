"""Command-line interface for drift detection, correction, and validation."""

from __future__ import annotations

import argparse
import functools
import http.server
import math
import socketserver
from pathlib import Path

from .analysis import (
    aligned_rms_error,
    analyze_files,
    analyze_signals,
    correct_result,
    local_offset,
    make_test_signals,
    pitch_metrics,
)
from .dsp import resample_channels
from .report import write_report
from .wavio import read_wav, to_mono, write_wav


def _print_result(result) -> None:
    print("Drift analysis")
    print(f"  model: offset(t) = {result.intercept:.9f} + {result.slope:.9f} * t seconds")
    print(f"  slope: {result.slope_ppm_per_second:.3f} ppm/s")
    print(f"  estimated actual rate: {result.estimated_actual_rate:.6f} Hz")
    print(f"  relative rate error: {result.relative_rate_ppm:.3f} ppm")
    print(f"  suggested resample ratio: {result.resample_ratio:.9f}")
    print(f"  fit residual RMS: {result.residual_rms_seconds*1_000_000:.3f} us")
    print(f"  mean correlation: {result.confidence_mean:.5f}")


def _common_analysis_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--window", type=float, default=0.5, help="analysis window seconds")
    parser.add_argument("--max-lag", type=float, default=0.05, help="maximum lag seconds")
    parser.add_argument("--points", type=int, default=12, help="number of time offsets")


def analyze_command(args: argparse.Namespace) -> None:
    result = analyze_files(
        args.reference,
        args.candidate,
        window_seconds=args.window,
        max_lag_seconds=args.max_lag,
        point_count=args.points,
    )
    _print_result(result)
    corrected, start = correct_result(args.candidate, args.output, result)
    print(f"  corrected WAV: {args.output}")
    if args.report:
        write_report(
            args.report,
            result,
            args.reference,
            args.candidate,
            args.output,
            {"corrected_reference_start_sample": start},
        )
        print(f"  HTML report: {args.report}")


def _validation_metrics(
    reference, drifted, corrected, rate, start, injected_factor
) -> dict[str, object]:
    end_time = min(len(reference), len(drifted)) / rate - 0.5
    initial_offset, initial_score = local_offset(
        reference, drifted, rate, end_time
    )
    corrected_offset, corrected_score = local_offset(
        reference[start:], corrected, rate, 0.45
    )
    common = min(len(reference), len(drifted))
    initial_rms = aligned_rms_error(reference[:common], drifted[:common])
    corrected_ref = reference[start : start + len(corrected)]
    corrected_rms = aligned_rms_error(corrected_ref, corrected)
    pitch = pitch_metrics(reference, corrected, rate)
    return {
        "injected_rate_factor": f"{injected_factor:.9f}",
        "initial_global_offset_ms": f"{initial_offset * 1000:.5f}",
        "corrected_global_offset_ms": f"{corrected_offset * 1000:.5f}",
        "total_offset_reduction": f"{(1.0 - abs(corrected_offset) / max(abs(initial_offset), 1e-12)) * 100:.2f}%",
        "initial_alignment_rms": f"{initial_rms:.6f}",
        "corrected_alignment_rms": f"{corrected_rms:.6f}",
        "initial_correlation": f"{initial_score:.6f}",
        "corrected_correlation": f"{corrected_score:.6f}",
        "corrected_frequency_hz": f"{pitch['candidate_frequency']:.4f}",
        "reference_frequency_hz": f"{pitch['reference_frequency']:.4f}",
        "pitch_error_cents": f"{pitch['corrected_cents_from_reference']:.5f}",
    }


def demo_command(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    reference, drifted = make_test_signals(
        rate=args.rate,
        seconds=args.seconds,
        drift_factor=args.drift_factor,
    )
    reference_path = output_dir / "reference.wav"
    drifted_path = output_dir / "drifted.wav"
    corrected_path = output_dir / "corrected.wav"
    report_path = output_dir / "report.html"
    write_wav(str(reference_path), [reference], args.rate)
    write_wav(str(drifted_path), [drifted], args.rate)

    result = analyze_signals(
        reference,
        drifted,
        args.rate,
        args.window,
        args.max_lag,
        args.points,
    )
    corrected_channels, start = correct_result(
        str(drifted_path), str(corrected_path), result
    )
    corrected = corrected_channels[0]
    metrics = _validation_metrics(
        reference, drifted, corrected, args.rate, start, args.drift_factor
    )
    write_report(
        str(report_path),
        result,
        str(reference_path),
        str(drifted_path),
        str(corrected_path),
        metrics,
    )
    _print_result(result)
    print("Validation")
    for key, value in metrics.items():
        print(f"  {key}: {value}")
    print(f"Artifacts written under: {output_dir}")


def verify_command(args: argparse.Namespace) -> int:
    reference, drifted = make_test_signals(
        args.rate, args.seconds, args.drift_factor
    )
    result = analyze_signals(
        reference, drifted, args.rate, args.window, args.max_lag, args.points
    )
    target_length = int(math.floor((len(drifted) - 1) * result.resample_ratio)) + 1
    corrected = resample_channels(
        [drifted],
        target_length,
        result.resample_ratio,
        result.intercept * args.rate,
    )[0]
    start = max(0, int(round(result.intercept * args.rate)))
    metrics = _validation_metrics(
        reference, drifted, corrected, args.rate, start, args.drift_factor
    )
    reduction = float(metrics["total_offset_reduction"].rstrip("%"))
    pitch_error = abs(float(metrics["pitch_error_cents"]))
    initial_rms = float(metrics["initial_alignment_rms"])
    corrected_rms = float(metrics["corrected_alignment_rms"])

    print("Synthetic drift verification")
    for key, value in metrics.items():
        print(f"  {key}: {value}")
    passed = (
        reduction >= 90.0
        and pitch_error < 0.05
        and corrected_rms < initial_rms * 0.25
    )
    print(f"  result: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


def serve_command(args: argparse.Namespace) -> None:
    root = Path(args.directory).resolve()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Serving {root} at http://127.0.0.1:{args.port}/")
        httpd.serve_forever()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Detect and correct slow sample-clock drift between WAV recordings."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze = subparsers.add_parser("analyze", help="analyze and correct two WAV files")
    analyze.add_argument("reference")
    analyze.add_argument("candidate")
    analyze.add_argument("--output", required=True)
    analyze.add_argument("--report")
    _common_analysis_args(analyze)
    analyze.set_defaults(func=analyze_command)

    demo = subparsers.add_parser("demo", help="generate fixed-drift material and report")
    demo.add_argument("--output-dir", default="demo_output")
    demo.add_argument("--rate", type=int, default=24000)
    demo.add_argument("--seconds", type=float, default=8.0)
    demo.add_argument("--drift-factor", type=float, default=1.0005)
    _common_analysis_args(demo)
    demo.set_defaults(func=demo_command)

    verify = subparsers.add_parser("verify", help="run non-interactive synthetic checks")
    verify.add_argument("--rate", type=int, default=24000)
    verify.add_argument("--seconds", type=float, default=8.0)
    verify.add_argument("--drift-factor", type=float, default=1.0005)
    _common_analysis_args(verify)
    verify.set_defaults(func=verify_command)

    serve = subparsers.add_parser("serve", help="preview a report directory")
    serve.add_argument("directory")
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=serve_command)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "verify":
        return args.func(args)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
