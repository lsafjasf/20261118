"""命令行入口：分析场景中的全部语言组合并输出报告。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .report import (
    STRATEGY_LABELS,
    format_combination_report,
    format_comparison_table,
    plan_to_dict,
)
from .scenario import load_scenario
from .solver import resolve_layout


def analyze(scenario_path: str | Path, force_lock: bool | None = None):
    """加载场景并分析全部语言组合，返回（文本, JSON 数据, 方案列表）。"""
    scenario = load_scenario(scenario_path)
    primary = scenario["primary"]
    canvas = scenario["canvas"]

    text_blocks: list[str] = [
        f"场景：{scenario['name']}",
        f"画布：{canvas.width}x{canvas.height}，安全边距 {canvas.safe_margin}",
        f"主字幕轨：{primary.name}（{primary.language}，"
        f"方向 {primary.direction.value}，字号 {primary.style.font_size}px）",
        "",
    ]
    json_payload: dict = {
        "scenario": scenario["name"],
        "canvas": {
            "width": canvas.width,
            "height": canvas.height,
            "safe_margin": canvas.safe_margin.__dict__,
            "slot_gap": scenario["slot_gap"],
        },
        "primary_track": {
            "name": primary.name,
            "language": primary.language,
            "direction": primary.direction.value,
        },
        "combinations": [],
    }
    table_rows: list[dict] = []
    plans = []

    for combo in scenario["combinations"]:
        translation = combo["translation"]
        locked = combo["lock_primary"] if force_lock is None else force_lock
        plan = resolve_layout(
            primary,
            translation,
            canvas,
            lock_primary=locked,
            preferred_primary_slot=combo["primary_slot"],
            max_stagger_ms=scenario["max_stagger_ms"],
            slot_gap=scenario["slot_gap"],
        )
        plans.append((combo["name"], primary.language, translation.language, plan))
        text_blocks.append(
            format_combination_report(
                combo["name"], (primary.language, translation.language), plan
            )
        )
        json_payload["combinations"].append(
            {
                "name": combo["name"],
                "languages": {
                    "primary": primary.language,
                    "translation": translation.language,
                },
                "translation_direction": translation.direction.value,
                "plan": plan_to_dict(plan),
            }
        )
        table_rows.append(
            {
                "name": combo["name"],
                "languages": f"{primary.language}->{translation.language}",
                "locked": locked,
                "before": len(plan.conflicts_before),
                "after": len(plan.conflicts_after),
                "strategy": plan.selected_strategy,
                "slot": plan.primary_slot.value,
            }
        )

    text_blocks.append("语言组合排版对比：")
    text_blocks.append(format_comparison_table(table_rows))
    text_blocks.append(
        "策略图例：" + "，".join(f"{key}={value}" for key, value in STRATEGY_LABELS.items())
    )
    return "\n\n".join(text_blocks), json_payload, plans


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="双字幕空间冲突检测与排版建议（主字幕 + 翻译字幕）"
    )
    parser.add_argument("scenario", help="场景 JSON 文件路径")
    parser.add_argument("--json", dest="json_path", help="把结构化结果写入该 JSON 文件")
    parser.add_argument("--text", dest="text_path", help="把文本报告写入该文件")
    parser.add_argument(
        "--lock-primary",
        action="store_true",
        default=None,
        help="强制锁定主字幕位置（覆盖场景内设置）",
    )
    parser.add_argument(
        "--unlock-primary",
        action="store_false",
        dest="lock_primary",
        help="强制解锁主字幕位置（覆盖场景内设置）",
    )
    args = parser.parse_args(argv)

    text, payload, _ = analyze(args.scenario, force_lock=args.lock_primary)
    print(text)
    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\nJSON 报告已写入：{args.json_path}")
    if args.text_path:
        Path(args.text_path).write_text(text, encoding="utf-8")
        print(f"文本报告已写入：{args.text_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
