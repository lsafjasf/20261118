"""冲突解决策略：上下换位 与 短暂错峰。

硬约束：
- 任何策略都不删除字幕，只调整槽位或时间。
- 主字幕位置被锁定时，禁止上下换位，只允许错峰。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .conflict import ConflictPeriod, detect_conflicts
from .model import Canvas, Cue, Slot, Track


@dataclass
class StaggerAdjustment:
    """单条字幕的错峰调整（毫秒）。"""

    track_name: str
    cue_id: str
    original_start_ms: int
    original_end_ms: int
    new_start_ms: int
    new_end_ms: int
    delta_ms: int
    note: str


@dataclass
class StrategyResult:
    """一种策略的评估结果。"""

    name: str
    feasible: bool
    remaining_conflict_count: int
    detail: str
    adjustments: list[StaggerAdjustment] = field(default_factory=list)


@dataclass
class LayoutPlan:
    """最终排版方案。"""

    primary_slot: Slot
    translation_slot: Slot
    primary_locked: bool
    selected_strategy: str
    swap: StrategyResult
    stagger: StrategyResult
    conflicts_before: list[ConflictPeriod]
    conflicts_after: list[ConflictPeriod]
    adjustments: list[StaggerAdjustment] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        return not self.conflicts_after


def _shift_cue(cue, delta_ms: int) -> tuple[int, int]:
    return cue.start_ms + delta_ms, cue.end_ms + delta_ms


def _track_with_shifted_cues(
    track: Track, deltas: dict[str, int]
) -> Track:
    """返回平移指定字幕之后的新轨道（不修改原轨道，不删除任何字幕）。"""
    if not deltas:
        return track
    shifted_cues = [
        Cue(
            cue.cue_id,
            cue.start_ms + deltas.get(cue.cue_id, 0),
            cue.end_ms + deltas.get(cue.cue_id, 0),
            cue.text,
        )
        for cue in track.cues
    ]
    return Track(
        name=track.name,
        language=track.language,
        direction=track.direction,
        style=track.style,
        cues=shifted_cues,
    )


def evaluate_swap(
    primary: Track,
    translation: Track,
    canvas: Canvas,
    locked: bool,
    slot_gap: float,
) -> StrategyResult:
    """评估上下换位（主字幕移到顶部，翻译字幕移到底部）。"""
    if locked:
        return StrategyResult(
            "swap",
            False,
            0,
            "主字幕位置已锁定，禁止上下换位",
        )
    remaining = detect_conflicts(
        primary, translation, canvas, primary_slot=Slot.TOP, slot_gap=slot_gap
    )
    if remaining:
        return StrategyResult(
            "swap",
            False,
            len(remaining),
            f"换位后仍有 {len(remaining)} 段冲突（多为安全区溢出，需要缩小字号/折行）",
        )
    return StrategyResult("swap", True, 0, "上下换位后无空间冲突")


def evaluate_stagger(
    primary: Track,
    translation: Track,
    canvas: Canvas,
    max_stagger_ms: int,
    slot_gap: float,
) -> StrategyResult:
    """评估错峰：保持槽位，逐段平移字幕，使两条字幕的显示时间不再重叠。

    只平移翻译字幕（主字幕通常与配音时间码对齐）。错峰是时间分离：
    平移后任一时刻只剩一条字幕，因此同屏空间冲突（含安全区溢出）都可缓解。

    对每条参与冲突的翻译字幕，聚合它同屏的所有主字幕，计算两个方向：
    - 延迟入场：平移量 = max(主字幕结束时间) - 翻译开始时间；
    - 提前入场：平移量 = 翻译结束时间 - min(主字幕开始时间)。
    取平移量更小且不超过 ``max_stagger_ms`` 的方向；两个方向都超限则不可行。
    """
    primary_cues = {cue.cue_id: cue for cue in primary.cues}
    translation_cues = {cue.cue_id: cue for cue in translation.cues}
    # translation cue_id -> 同屏主字幕集合
    involved: dict[str, set[str]] = {}
    for period in detect_conflicts(primary, translation, canvas, slot_gap=slot_gap):
        involved.setdefault(period.translation_cue_id, set()).add(
            period.primary_cue_id
        )

    adjustments: list[StaggerAdjustment] = []
    for translation_id, primary_ids in involved.items():
        translation_cue = translation_cues[translation_id]
        overlapping_primary = [primary_cues[pid] for pid in primary_ids]
        delay_needed = (
            max(cue.end_ms for cue in overlapping_primary)
            - translation_cue.start_ms
        )
        advance_needed = (
            translation_cue.end_ms
            - min(cue.start_ms for cue in overlapping_primary)
        )
        candidates = [
            amount for amount in (delay_needed, advance_needed) if amount > 0
        ]
        if not candidates:
            continue
        step = min(candidates)
        if step > max_stagger_ms:
            return StrategyResult(
                "stagger",
                False,
                0,
                f"错峰不可行：翻译字幕 {translation_id} 至少需平移 {step} ms，"
                f"超过 {max_stagger_ms} ms 上限",
                adjustments,
            )
        direction = 1 if step == delay_needed else -1
        delta = direction * step
        new_start, new_end = _shift_cue(translation_cue, delta)
        verb = "推迟" if direction == 1 else "提前"
        adjustments.append(
            StaggerAdjustment(
                translation.name,
                translation_id,
                translation_cue.start_ms,
                translation_cue.end_ms,
                new_start,
                new_end,
                delta,
                f"{verb} {step} ms 以避开主字幕 {', '.join(sorted(primary_ids))}",
            )
        )

    if adjustments:
        deltas = {item.cue_id: item.delta_ms for item in adjustments}
        shifted_translation = _track_with_shifted_cues(translation, deltas)
        remaining = detect_conflicts(
            primary, shifted_translation, canvas, slot_gap=slot_gap
        )
        if remaining:
            return StrategyResult(
                "stagger",
                False,
                len(remaining),
                "错峰后仍存在同屏冲突（平移受上限约束无法完全分离）",
                adjustments,
            )
        return StrategyResult(
            "stagger",
            True,
            0,
            f"错峰可行：共调整 {len(adjustments)} 条翻译字幕，"
            f"平移均在 {max_stagger_ms} ms 以内",
            adjustments,
        )
    return StrategyResult("stagger", True, 0, "无需错峰调整", adjustments)


def resolve_layout(
    primary: Track,
    translation: Track,
    canvas: Canvas,
    lock_primary: bool = False,
    preferred_primary_slot: Slot = Slot.BOTTOM,
    max_stagger_ms: int = 1500,
    slot_gap: float = 24.0,
) -> LayoutPlan:
    """生成最终排版方案。

    选择优先级：保持原槽位且无冲突 > 换位 > 错峰 > 标记为需人工处理。
    """
    conflicts_before = detect_conflicts(
        primary,
        translation,
        canvas,
        primary_slot=preferred_primary_slot,
        slot_gap=slot_gap,
    )
    swap = evaluate_swap(primary, translation, canvas, lock_primary, slot_gap)
    stagger = evaluate_stagger(
        primary, translation, canvas, max_stagger_ms, slot_gap
    )

    if not conflicts_before:
        selected = "none"
        final_slot = preferred_primary_slot
        conflicts_after: list[ConflictPeriod] = []
        adjustments: list[StaggerAdjustment] = []
    elif swap.feasible:
        selected = "swap"
        final_slot = Slot.TOP if preferred_primary_slot is Slot.BOTTOM else Slot.BOTTOM
        conflicts_after = []
        adjustments = []
    elif stagger.feasible:
        selected = "stagger"
        final_slot = preferred_primary_slot
        conflicts_after = []
        adjustments = stagger.adjustments
    else:
        selected = "manual"
        final_slot = preferred_primary_slot
        conflicts_after = conflicts_before
        adjustments = stagger.adjustments

    translation_slot = Slot.TOP if final_slot is Slot.BOTTOM else Slot.BOTTOM
    return LayoutPlan(
        primary_slot=final_slot,
        translation_slot=translation_slot,
        primary_locked=lock_primary,
        selected_strategy=selected,
        swap=swap,
        stagger=stagger,
        conflicts_before=conflicts_before,
        conflicts_after=conflicts_after,
        adjustments=adjustments,
    )
