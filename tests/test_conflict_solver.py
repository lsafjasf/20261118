import unittest

from subtitle_layout.conflict import detect_conflicts
from subtitle_layout.model import (
    Canvas,
    Cue,
    ReadingDirection,
    SafeMargin,
    Slot,
    Track,
    TrackStyle,
)
from subtitle_layout.solver import resolve_layout
from subtitle_layout.solver import evaluate_stagger


def cue(cue_id, start_ms, end_ms, text="Subtitle"):
    return Cue(cue_id, start_ms, end_ms, text)


def track(name, language, cues, font_size=48, direction=ReadingDirection.LTR):
    return Track(
        name=name,
        language=language,
        direction=direction,
        style=TrackStyle(font_size=font_size),
        cues=cues,
    )


STD_CANVAS = Canvas()
SHORT_CANVAS = Canvas(
    width=1280,
    height=400,
    safe_margin=SafeMargin(top=40, right=40, bottom=40, left=40),
)


def overflow_tracks():
    """矮画布 + 大字号：堆叠总高超过安全区，外沿块溢出。"""
    primary = track(
        "主", "zh", [cue("1", 500, 1500, "主字幕块")], font_size=120
    )
    translation = track(
        "译", "en", [cue("1", 0, 2000, "Sub")], font_size=120
    )
    return primary, translation


class ConflictDetectionTests(unittest.TestCase):
    def test_no_conflict_when_tracks_never_overlap_in_time(self):
        primary = track("主", "zh", [cue("1", 0, 1000)])
        translation = track("译", "en", [cue("1", 1000, 2000)])
        self.assertEqual(detect_conflicts(primary, translation, STD_CANVAS), [])

    def test_no_conflict_when_blocks_fit_safe_area(self):
        primary = track("主", "zh", [cue("1", 0, 1000, "主字幕")])
        translation = track("译", "en", [cue("1", 200, 1200, "Sub")])
        self.assertEqual(detect_conflicts(primary, translation, STD_CANVAS), [])

    def test_overflow_flagged_during_overlapping_window(self):
        primary, translation = overflow_tracks()
        conflicts = detect_conflicts(
            primary, translation, SHORT_CANVAS, slot_gap=24
        )
        self.assertEqual(len(conflicts), 1)
        period = conflicts[0]
        self.assertEqual((period.start_ms, period.end_ms), (500, 1500))
        self.assertTrue(
            any("safe_area_overflow" in reason for reason in period.reasons)
        )

    def test_adjacent_periods_of_same_pair_merge(self):
        # 同一条翻译字幕跨越一个切换点时，相邻同因区间应合并为一段
        primary = track(
            "主",
            "zh",
            [cue("1", 500, 2000, "主甲"), cue("2", 2000, 3500, "主乙")],
            font_size=120,
        )
        translation = track(
            "译",
            "en",
            [cue("1", 0, 4000, "Sub")],
            font_size=120,
        )
        conflicts = detect_conflicts(
            primary, translation, SHORT_CANVAS, slot_gap=24
        )
        merged = [
            period
            for period in conflicts
            if period.translation_cue_id == "1"
            and period.primary_cue_id == "1"
        ]
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0].start_ms, merged[0].end_ms), (500, 2000))

    def test_giant_font_without_time_overlap_is_ignored(self):
        primary = track(
            "主", "zh", [cue("1", 0, 1000, "主")], font_size=400
        )
        translation = track(
            "译", "en", [cue("1", 2000, 3000, "X")], font_size=400
        )
        self.assertEqual(
            detect_conflicts(primary, translation, STD_CANVAS), []
        )


class LayoutSolverTests(unittest.TestCase):
    def test_clean_layout_keeps_default_slots(self):
        primary = track("主", "zh", [cue("1", 0, 1000, "主字幕")])
        translation = track("译", "en", [cue("1", 200, 1200, "Sub")])
        plan = resolve_layout(primary, translation, STD_CANVAS)
        self.assertEqual(plan.selected_strategy, "none")
        self.assertTrue(plan.resolved)
        self.assertEqual(plan.primary_slot, Slot.BOTTOM)
        self.assertEqual(plan.translation_slot, Slot.TOP)

    def test_locked_primary_disables_swap_option(self):
        primary, translation = overflow_tracks()
        plan = resolve_layout(
            primary, translation, SHORT_CANVAS, lock_primary=True, slot_gap=24
        )
        self.assertFalse(plan.swap.feasible)
        self.assertIn("锁定", plan.swap.detail)
        self.assertEqual(plan.primary_slot, Slot.BOTTOM)

    def test_locked_overflow_resolved_by_stagger_within_limit(self):
        primary, translation = overflow_tracks()
        plan = resolve_layout(
            primary,
            translation,
            SHORT_CANVAS,
            lock_primary=True,
            max_stagger_ms=1500,
            slot_gap=24,
        )
        self.assertTrue(plan.stagger.feasible)
        self.assertEqual(plan.selected_strategy, "stagger")
        self.assertTrue(plan.resolved)
        self.assertEqual(len(plan.adjustments), 1)
        adjustment = plan.adjustments[0]
        self.assertEqual(adjustment.track_name, "译")
        self.assertEqual(abs(adjustment.delta_ms), 1500)

    def test_stagger_never_removes_a_cue(self):
        primary = track("主", "zh", [cue("1", 0, 800, "主字幕")])
        translation = track("译", "en", [cue("1", 400, 1600, "Sub")])
        before = len(translation.cues)
        plan = resolve_layout(
            primary, translation, STD_CANVAS, lock_primary=True
        )
        self.assertEqual(len(translation.cues), before)
        self.assertTrue(plan.resolved)

    def test_stagger_beyond_limit_is_reported_infeasible(self):
        primary, translation = overflow_tracks()
        plan = resolve_layout(
            primary,
            translation,
            SHORT_CANVAS,
            lock_primary=True,
            max_stagger_ms=1000,
            slot_gap=24,
        )
        self.assertFalse(plan.stagger.feasible)
        self.assertEqual(plan.selected_strategy, "manual")
        self.assertFalse(plan.resolved)

    def test_swap_reverses_slot_assignment_when_requested(self):
        primary = track("主", "zh", [cue("1", 0, 1000, "主字幕")])
        translation = track("译", "en", [cue("1", 200, 1200, "Sub")])
        plan = resolve_layout(
            primary,
            translation,
            STD_CANVAS,
            preferred_primary_slot=Slot.TOP,
        )
        self.assertEqual(plan.primary_slot, Slot.TOP)
        self.assertEqual(plan.translation_slot, Slot.BOTTOM)


class StaggerAlgorithmTests(unittest.TestCase):
    def test_stagger_separates_cues_within_limit(self):
        canvas = Canvas(
            width=1280,
            height=400,
            safe_margin=SafeMargin(40, 40, 40, 40),
        )
        primary = track(
            "主",
            "zh",
            [cue("1", 500, 1500, "主甲\n主乙"), cue("2", 5000, 6000, "主丙\n主丁")],
            font_size=96,
        )
        translation = track(
            "译",
            "en",
            [
                cue("1", 0, 2000, "One line\nTwo line"),
                cue("2", 4600, 6500, "Alpha line\nBeta line"),
            ],
            font_size=96,
        )
        result = evaluate_stagger(primary, translation, canvas, 1500, 24)
        self.assertTrue(result.feasible)
        self.assertEqual(len(result.adjustments), 2)
        self.assertTrue(all(abs(a.delta_ms) <= 1500 for a in result.adjustments))

    def test_stagger_rejects_when_shift_cannot_fully_separate(self):
        canvas = Canvas(
            width=1280,
            height=400,
            safe_margin=SafeMargin(40, 40, 40, 40),
        )
        # 翻译 #1 推迟后会与紧邻的主字幕 #2 同屏，单方向平移无法完全分离
        primary = track(
            "主",
            "zh",
            [cue("1", 500, 1500, "主甲\n主乙"), cue("2", 3000, 4000, "主丙\n主丁")],
            font_size=96,
        )
        translation = track(
            "译",
            "en",
            [cue("1", 0, 2000, "One line\nTwo line")],
            font_size=96,
        )
        result = evaluate_stagger(primary, translation, canvas, 1500, 24)
        self.assertFalse(result.feasible)
        self.assertGreater(result.remaining_conflict_count, 0)


if __name__ == "__main__":
    unittest.main()
