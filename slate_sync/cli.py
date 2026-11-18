"""SLATE/SYNC 命令行入口。"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import report as report_mod
from .engine import SyncEngine
from .generate_media import generate
from .timeline import validate_segments

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA_DIR = os.path.join(ROOT, "samples", "media")
OUT_DIR = os.path.join(ROOT, "samples", "output")


def cmd_generate(_args: argparse.Namespace) -> int:
    manifest = generate(MEDIA_DIR)
    manifest_path = os.path.join(ROOT, "samples", "media_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(f"已生成 {len(manifest['tracks'])} 条素材 -> {MEDIA_DIR}")
    return 0


def _run_engine(nudges: dict[str, float] | None = None) -> tuple[SyncEngine, dict]:
    engine = SyncEngine(MEDIA_DIR)
    engine.analyze()
    for track_id, nudge_ms in (nudges or {}).items():
        engine.set_nudge(track_id, nudge_ms)
    full_report = report_mod.build_report(engine)
    offsets = {row["trackId"]: row["finalOffsetMs"] / 1000.0
               for row in full_report["matrix"]}
    durations = {row["trackId"]: row["durationMs"] / 1000.0
                 for row in full_report["matrix"]}
    problems = validate_segments(
        full_report["programSegments"], offsets, durations,
        full_report["commonInSec"], full_report["commonOutSec"])
    full_report["timelineProblems"] = problems
    return engine, full_report


def _parse_nudges(values: list[str]) -> dict[str, float]:
    nudges = {}
    for item in values or []:
        if "=" not in item:
            raise argparse.ArgumentTypeError(f"微调格式应为 轨道=毫秒，收到 {item}")
        track_id, nudge = item.split("=", 1)
        nudges[track_id.strip()] = float(nudge)
    return nudges


def cmd_analyze(args: argparse.Namespace) -> int:
    nudges = _parse_nudges(args.nudge)
    engine, full_report = _run_engine(nudges)
    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, "sync-report.json")
    csv_path = os.path.join(OUT_DIR, "sync-matrix.csv")
    report_mod.write_json(full_report, json_path)
    report_mod.write_csv_matrix(full_report, csv_path)
    _print_summary(full_report)
    print(f"\n报告: {json_path}\n矩阵: {csv_path}")
    if full_report["timelineProblems"]:
        print("时间线校验问题:", full_report["timelineProblems"])
        return 2
    return 0 if full_report["verification"]["passed"] else 1


def cmd_verify(args: argparse.Namespace) -> int:
    _, full_report = _run_engine(_parse_nudges(args.nudge))
    verification = full_report["verification"]
    print(f"最长录音: {verification['longestTrackName']} "
          f"({verification['longestDurationSec']}s)")
    print(f"共同段落: {verification['commonInSec']}s ~ "
          f"{verification['commonOutSec']}s "
          f"({verification['commonDurationSec']}s)")
    print(f"比对窗口: {verification['comparedWindows']} 个 | "
          f"平均误差 {verification['meanErrorMs']}ms | "
          f"P95 {verification['p95ErrorMs']}ms | "
          f"最大 {verification['maxErrorMs']}ms "
          f"(阈值 {verification['thresholdMs']}ms)")
    for item in verification["perTrack"]:
        print(f"  {item['name']}: {item['status']} "
              f"max={item['maxErrorMs']}ms windows={item['comparedWindows']}")
    print("结论:", "PASS" if verification["passed"] else "FAIL")
    return 0 if verification["passed"] else 1


def _print_summary(full_report: dict) -> None:
    print(f"工程: {full_report['project']} | 主轨: {full_report['masterTrackId']}")
    print("同步矩阵:")
    for row in full_report["matrix"]:
        print(f"  {row['trackId']:9s} 自动 {row['autoOffsetMs']:>8.1f}ms "
              f"微调 {row['manualNudgeMs']:>6.1f}ms "
              f"最终 {row['finalOffsetMs']:>8.1f}ms "
              f"r={row['correlation']:.5f} [{row['status']}]")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="场记板脉冲多机位同步工具")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("generate", help="生成测试素材").set_defaults(func=cmd_generate)
    analyze = sub.add_parser("analyze", help="检测同步并导出矩阵/报告")
    analyze.add_argument("--nudge", action="append",
                         help="手动微调，如 cam_a=-10（单位 ms，可重复）")
    analyze.set_defaults(func=cmd_analyze)
    verify = sub.add_parser("verify", help="验证共同段落误差")
    verify.add_argument("--nudge", action="append", help="同 analyze")
    verify.set_defaults(func=cmd_verify)
    render = sub.add_parser("render", help="按统一时间线渲染成片（画面切换+主音轨）")
    render.add_argument("--nudge", action="append", help="同 analyze")
    render.set_defaults(func=cmd_render)
    serve = sub.add_parser("serve", help="启动 Web 工作站")
    serve.add_argument("--port", type=int, default=8067)
    serve.set_defaults(func=cmd_serve)
    return parser


def cmd_render(args: argparse.Namespace) -> int:
    from .render import render_program
    engine, full_report = _run_engine(_parse_nudges(args.nudge))
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, "program.mp4")
    render_program(engine, full_report, out_path)
    print(f"成片已导出: {out_path}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from .web_server import serve
    serve(args.port)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
