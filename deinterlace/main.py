"""命令行入口。

用法：
  python -m deinterlace.main demo                 # 生成测试片、评估、导出并建查看器
  python -m deinterlace.main run --input DIR --order tff
"""

import argparse
import os

from .fields import chronological_fields
from .io_utils import export_sequence, write_json
from .methods import deinterlace_adaptive, deinterlace_bob, deinterlace_weave
from .metrics import timed_run
from .pipeline import run_all, load_interlaced_frames, METHOD_LABELS
from .viewer import build_viewer


def cmd_demo(args: argparse.Namespace) -> None:
    summaries = run_all(
        args.output, frame_count=args.frames, source_fps=args.fps
    )
    viewer = build_viewer(args.output, os.path.join(args.output, "viewer.html"),
                          limit=args.viewer_frames)
    print("\n=== 各测试片实测推荐策略 ===")
    for summary in summaries:
        selection = summary["selection"]
        print(
            f"[{summary['scene']} / {summary['field_order']}] "
            f"推荐 {METHOD_LABELS[selection['recommended']]} "
            f"({selection['recommended']}) — {selection['reason']}"
        )
    print(f"\n图像序列与报告已导出到: {args.output}")
    print(f"逐帧查看器（浏览器打开）: {viewer}")


def cmd_run(args: argparse.Namespace) -> None:
    frames = load_interlaced_frames(args.input)
    fields = chronological_fields(frames, args.order)
    bob, bob_timing = timed_run("bob", deinterlace_bob, fields)
    weave, weave_timing = timed_run("weave", deinterlace_weave, fields)
    adaptive_pack, adaptive_timing = timed_run(
        "adaptive", deinterlace_adaptive, fields
    )
    adaptive, diag = adaptive_pack
    results = {"bob": bob, "weave": weave, "adaptive": adaptive}
    for name, sequence in results.items():
        export_sequence(sequence, os.path.join(args.output, name), name)
    log = {
        "input_dir": args.input,
        "field_order": args.order,
        "input_frames": len(frames),
        "field_count": len(fields),
        "assumed_source_fps": args.fps,
        "output_fps": args.fps * 2,
        "timing": {
            "bob": bob_timing.__dict__,
            "weave": weave_timing.__dict__,
            "adaptive": adaptive_timing.__dict__,
        },
        "adaptive_motion_diag": diag,
        "note": "外部素材无逐行真值，未计算 PSNR；请用查看器人工比较梳齿与分辨率",
    }
    write_json(log, os.path.join(args.output, "external_report.json"))
    print(f"三个策略的图像序列已导出到: {args.output}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="去隔行三策略对比工具")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="用合成测试片跑完整评估并生成查看器")
    demo.add_argument("--output", default="exports/demo")
    demo.add_argument("--frames", type=int, default=16, help="每个场景参考帧数")
    demo.add_argument("--fps", type=float, default=25.0, help="输入隔行帧率")
    demo.add_argument("--viewer-frames", type=int, default=24)
    demo.set_defaults(func=cmd_demo)

    run = sub.add_parser("run", help="对外部隔行帧序列执行三种去隔行")
    run.add_argument("--input", required=True, help="存放隔行 PNG/JPG 的目录")
    run.add_argument("--order", choices=["tff", "bff"], default="tff")
    run.add_argument("--output", default="exports/external")
    run.add_argument("--fps", type=float, default=25.0)
    run.set_defaults(func=cmd_run)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
