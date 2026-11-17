"""冲突时间段与最终布局的文本 / JSON 报告。"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass

from .conflict import ConflictPeriod
from .model import Rect
from .solver import LayoutPlan

REASON_LABELS = {
    "rect_overlap": "矩形重叠",
    "insufficient_gap": "纵向安全间距不足",
}

STRATEGY_LABELS = {
    "none": "保持原槽位（无冲突）",
    "swap": "上下换位",
    "stagger": "短暂错峰",
    "manual": "需人工处理（自动策略均不可行，不删除任何字幕）",
}


def format_timestamp(ms: int) -> str:
    """毫秒 -> ``HH:MM:SS.mmm``。"""
    sign = "-" if ms < 0 else ""
    ms = abs(ms)
    hours, remainder = divmod(ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{sign}{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def format_range(start_ms: int, end_ms: int) -> str:
    return f"{format_timestamp(start_ms)} --> {format_timestamp(end_ms)}"


def _reason_label(reason: str) -> str:
    if reason.startswith("primary_safe_area_overflow:"):
        return f"主字幕超出安全区（{reason.split(':', 1)[1]} 边）"
    if reason.startswith("translation_safe_area_overflow:"):
        return f"翻译字幕超出安全区（{reason.split(':', 1)[1]} 边）"
    return REASON_LABELS.get(reason, reason)


def rect_to_dict(rect: Rect) -> dict:
    return {
        "x0": round(rect.x0, 2),
        "y0": round(rect.y0, 2),
        "x1": round(rect.x1, 2),
        "y1": round(rect.y1, 2),
        "width": round(rect.width, 2),
        "height": round(rect.height, 2),
    }


def _placement_to_dict(placement) -> dict:
    return {
        "track": placement.track.name,
        "language": placement.track.language,
        "cue_id": placement.cue.cue_id,
        "text": placement.cue.text,
        "slot": placement.slot.value,
        "rect": rect_to_dict(placement.rect),
        "safe_area_overflow": placement.overflow,
    }


def conflict_to_dict(period: ConflictPeriod) -> dict:
    return {
        "start_ms": period.start_ms,
        "end_ms": period.end_ms,
        "time_range": format_range(period.start_ms, period.end_ms),
        "duration_ms": period.duration_ms,
        "primary_cue_id": period.primary_cue_id,
        "translation_cue_id": period.translation_cue_id,
        "reasons": period.reasons,
        "reason_labels": [_reason_label(reason) for reason in period.reasons],
        "primary": _placement_to_dict(period.primary_placement),
        "translation": _placement_to_dict(period.translation_placement),
        "overlap_rect": rect_to_dict(period.overlap_rect) if period.overlap_rect else None,
    }


def _adjustment_to_dict(adjustment) -> dict:
    return {
        "track": adjustment.track_name,
        "cue_id": adjustment.cue_id,
        "original_time_range": format_range(
            adjustment.original_start_ms, adjustment.original_end_ms
        ),
        "new_time_range": format_range(adjustment.new_start_ms, adjustment.new_end_ms),
        "delta_ms": adjustment.delta_ms,
        "note": adjustment.note,
    }


def plan_to_dict(plan: LayoutPlan) -> dict:
    return {
        "primary_slot": plan.primary_slot.value,
        "translation_slot": plan.translation_slot.value,
        "primary_locked": plan.primary_locked,
        "selected_strategy": plan.selected_strategy,
        "selected_strategy_label": STRATEGY_LABELS[plan.selected_strategy],
        "resolved": plan.resolved,
        "conflict_count_before": len(plan.conflicts_before),
        "conflict_count_after": len(plan.conflicts_after),
        "options": {
            "swap": {"feasible": plan.swap.feasible, "detail": plan.swap.detail},
            "stagger": {
                "feasible": plan.stagger.feasible,
                "detail": plan.stagger.detail,
            },
        },
        "conflicts": [conflict_to_dict(period) for period in plan.conflicts_before],
        "remaining_conflicts": [
            conflict_to_dict(period) for period in plan.conflicts_after
        ],
        "adjustments": [_adjustment_to_dict(item) for item in plan.adjustments],
    }


def _format_conflict_lines(period: ConflictPeriod) -> list[str]:
    lines = [
        f"  - {format_range(period.start_ms, period.end_ms)} "
        f"（持续 {period.duration_ms} ms）",
        f"    主字幕 #{period.primary_cue_id} × 翻译字幕 #{period.translation_cue_id}",
        f"    原因：{'；'.join(_reason_label(reason) for reason in period.reasons)}",
        f"    主字幕矩形：{rect_to_dict(period.primary_placement.rect)}",
        f"    翻译矩形：{rect_to_dict(period.translation_placement.rect)}",
    ]
    if period.overlap_rect:
        lines.append(f"    重叠矩形：{rect_to_dict(period.overlap_rect)}")
    return lines


def format_combination_report(name: str, languages: tuple[str, str], plan: LayoutPlan) -> str:
    """单个语言组合的人类可读报告。"""
    primary_lang, translation_lang = languages
    lines = [
        f"=== 组合：{name}（主 {primary_lang} / 译 {translation_lang}）===",
        f"主字幕锁定：{'是' if plan.primary_locked else '否'}",
        f"最终布局：主字幕 -> {plan.primary_slot.value} 槽位，"
        f"翻译字幕 -> {plan.translation_slot.value} 槽位",
        f"选择策略：{STRATEGY_LABELS[plan.selected_strategy]}",
        f"冲突段数：调整前 {len(plan.conflicts_before)}，调整后 {len(plan.conflicts_after)}",
        "",
        "策略评估：",
        f"  [上下换位] {'可行' if plan.swap.feasible else '不可行'} — {plan.swap.detail}",
        f"  [短暂错峰] {'可行' if plan.stagger.feasible else '不可行'} — {plan.stagger.detail}",
        "",
    ]
    if plan.conflicts_before:
        lines.append("冲突时间段：")
        for period in plan.conflicts_before:
            lines.extend(_format_conflict_lines(period))
    else:
        lines.append("冲突时间段：无")
    if plan.adjustments:
        lines.append("")
        lines.append("错峰时间调整（字幕均保留，未删除任何一条）：")
        for adjustment in plan.adjustments:
            lines.append(
                f"  - {adjustment.track_name} #{adjustment.cue_id}："
                f"{format_range(adjustment.original_start_ms, adjustment.original_end_ms)} -> "
                f"{format_range(adjustment.new_start_ms, adjustment.new_end_ms)} "
                f"（{adjustment.note}）"
            )
    if plan.conflicts_after:
        lines.append("")
        lines.append("未解决冲突（需人工调整字号/安全边距/折行）：")
        for period in plan.conflicts_after:
            lines.extend(_format_conflict_lines(period))
    return "\n".join(lines)


def format_comparison_table(rows: list[dict]) -> str:
    """多语言组合排版结果对比表。"""
    header = (
        f"{'组合':<18}{'语言':<14}{'锁定':<6}{'冲突前':<8}{'冲突后':<8}"
        f"{'最终策略':<12}{'主槽位':<8}"
    )
    separator = "-" * len(header)
    lines = [separator, header, separator]
    for row in rows:
        lines.append(
            f"{row['name']:<18}{row['languages']:<14}"
            f"{('是' if row['locked'] else '否'):<6}"
            f"{row['before']:<8}{row['after']:<8}"
            f"{row['strategy']:<12}{row['slot']:<8}"
        )
    lines.append(separator)
    return "\n".join(lines)


def to_jsonable(value):
    """把 dataclass / 枚举等递归转成可 JSON 序列化的原生类型。"""
    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "value"):
        return value.value
    return value
