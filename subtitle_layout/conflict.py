"""双字幕时间轴重叠扫描与空间冲突判定。"""

from __future__ import annotations

from dataclasses import dataclass, field

from .metrics import block_dimensions, place_stacked, safe_area_overflow
from .model import Canvas, Cue, Rect, Slot, Track


@dataclass
class CuePlacement:
    """某条字幕在某槽位下的瞬时布局。"""

    track: Track
    cue: Cue
    slot: Slot
    rect: Rect
    overflow: list[str] = field(default_factory=list)


@dataclass
class ConflictPeriod:
    """一段冲突时间区间及其几何证据。"""

    start_ms: int
    end_ms: int
    primary_cue_id: str
    translation_cue_id: str
    reasons: list[str]
    primary_placement: CuePlacement
    translation_placement: CuePlacement
    overlap_rect: Rect | None = None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def _overlap_pairs(primary: Track, translation: Track) -> list[tuple[Cue, Cue, int, int]]:
    """返回所有同时出现在画面中的主/译字幕对及其重叠时间区间。"""
    events: list[tuple[int, int, str, Cue]] = []
    for cue in primary.cues:
        events.append((cue.start_ms, 1, "p", cue))
        events.append((cue.end_ms, -1, "p", cue))
    for cue in translation.cues:
        events.append((cue.start_ms, 1, "t", cue))
        events.append((cue.end_ms, -1, "t", cue))
    events.sort(key=lambda item: (item[0], item[1]))

    pairs: list[tuple[Cue, Cue, int, int]] = []
    active_primary: set[Cue] = set()
    active_translation: set[Cue] = set()
    prev_time = events[0][0] if events else 0
    active_pairs: set[tuple[Cue, Cue]] = set()

    for time_ms, kind, track_tag, cue in events:
        if time_ms > prev_time and active_pairs:
            for primary_cue, translation_cue in active_pairs:
                pairs.append(
                    (
                        primary_cue,
                        translation_cue,
                        prev_time,
                        min(time_ms, primary_cue.end_ms, translation_cue.end_ms),
                    )
                )
        if kind == 1 and track_tag == "p":
            active_primary.add(cue)
        elif kind == 1:
            active_translation.add(cue)
        elif track_tag == "p":
            active_primary.discard(cue)
        else:
            active_translation.discard(cue)
        active_pairs = {
            (primary_cue, translation_cue)
            for primary_cue in active_primary
            for translation_cue in active_translation
        }
        prev_time = time_ms
    return pairs


def evaluate_pair(
    primary_cue: Cue,
    translation_cue: Cue,
    primary: Track,
    translation: Track,
    canvas: Canvas,
    primary_slot: Slot,
    slot_gap: float = 24.0,
) -> tuple[CuePlacement, CuePlacement, list[str], Rect | None]:
    """评估一对重叠字幕在给定主字幕槽位下的几何关系。"""
    translation_slot = Slot.TOP if primary_slot is Slot.BOTTOM else Slot.BOTTOM
    primary_size = block_dimensions(primary_cue, primary, canvas)[:2]
    translation_size = block_dimensions(translation_cue, translation, canvas)[:2]
    if primary_slot is Slot.BOTTOM:
        primary_rect, translation_rect = place_stacked(
            canvas,
            Slot.BOTTOM,
            [primary_size, translation_size],
            slot_gap,
            [primary.direction, translation.direction],
        )
    else:
        primary_rect, translation_rect = place_stacked(
            canvas,
            Slot.TOP,
            [primary_size, translation_size],
            slot_gap,
            [primary.direction, translation.direction],
        )

    primary_placement = CuePlacement(
        primary, primary_cue, primary_slot, primary_rect, safe_area_overflow(primary_rect, canvas)
    )
    translation_placement = CuePlacement(
        translation,
        translation_cue,
        translation_slot,
        translation_rect,
        safe_area_overflow(translation_rect, canvas),
    )

    reasons: list[str] = []
    overlap_rect = primary_rect.intersection(translation_rect)
    if overlap_rect is not None:
        reasons.append("rect_overlap")
    # 顺序堆叠保证块间间距恒为 slot_gap，冲突只可能是矩形重叠或安全区溢出
    for edge in primary_placement.overflow:
        reasons.append(f"primary_safe_area_overflow:{edge}")
    for edge in translation_placement.overflow:
        reasons.append(f"translation_safe_area_overflow:{edge}")
    return primary_placement, translation_placement, reasons, overlap_rect


def _merge_periods(periods: list[ConflictPeriod]) -> list[ConflictPeriod]:
    """合并同字幕对、同原因的相邻区间（中间可能夹着第三方字幕切换点）。"""
    merged: list[ConflictPeriod] = []
    for period in sorted(periods, key=lambda item: item.start_ms):
        if merged:
            previous = merged[-1]
            if (
                previous.end_ms == period.start_ms
                and previous.primary_cue_id == period.primary_cue_id
                and previous.translation_cue_id == period.translation_cue_id
                and previous.reasons == period.reasons
            ):
                previous.end_ms = period.end_ms
                continue
        merged.append(
            ConflictPeriod(
                period.start_ms,
                period.end_ms,
                period.primary_cue_id,
                period.translation_cue_id,
                list(period.reasons),
                period.primary_placement,
                period.translation_placement,
                period.overlap_rect,
            )
        )
    return merged


def detect_conflicts(
    primary: Track,
    translation: Track,
    canvas: Canvas,
    primary_slot: Slot = Slot.BOTTOM,
    slot_gap: float = 24.0,
) -> list[ConflictPeriod]:
    """检测给定槽位分配下的全部空间冲突时间段。"""
    periods: list[ConflictPeriod] = []
    for primary_cue, translation_cue, start_ms, end_ms in _overlap_pairs(primary, translation):
        primary_placement, translation_placement, reasons, overlap_rect = evaluate_pair(
            primary_cue,
            translation_cue,
            primary,
            translation,
            canvas,
            primary_slot,
            slot_gap,
        )
        if reasons:
            periods.append(
                ConflictPeriod(
                    start_ms,
                    end_ms,
                    primary_cue.cue_id,
                    translation_cue.cue_id,
                    reasons,
                    primary_placement,
                    translation_placement,
                    overlap_rect,
                )
            )
    return _merge_periods(periods)
