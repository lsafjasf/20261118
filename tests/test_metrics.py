import unittest

from subtitle_layout.metrics import (
    block_dimensions,
    cue_rect,
    place_block,
    safe_area_overflow,
    text_width,
)
from subtitle_layout.model import (
    Canvas,
    Cue,
    ReadingDirection,
    SafeMargin,
    Slot,
    Track,
    TrackStyle,
)


def make_track(direction=ReadingDirection.LTR, font_size=48, max_width_ratio=0.82):
    return Track(
        name="t",
        language="en",
        direction=direction,
        style=TrackStyle(font_size=font_size, max_width_ratio=max_width_ratio),
    )


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.canvas = Canvas()

    def test_cjk_wider_than_latin(self):
        self.assertGreater(text_width("汉字", 48), text_width("ab", 48))
        self.assertAlmostEqual(text_width("汉字", 48), 96.0)

    def test_single_line_block_includes_padding(self):
        cue = Cue("1", 0, 1000, "Hello")
        track = make_track()
        width, height, lines = block_dimensions(cue, track, self.canvas)
        self.assertEqual(lines, ["Hello"])
        self.assertAlmostEqual(width, text_width("Hello", 48) + 32)
        self.assertGreater(height, 48)

    def test_long_text_wraps_to_multiple_lines(self):
        long_text = "word " * 60
        cue = Cue("1", 0, 1000, long_text)
        track = make_track(max_width_ratio=0.3)
        _, _, lines = block_dimensions(cue, track, self.canvas)
        self.assertGreater(len(lines), 1)

    def test_cjk_wraps_inside_safe_area(self):
        cue = Cue("1", 0, 1000, "汉" * 200)
        track = make_track()
        width, _, _ = block_dimensions(cue, track, self.canvas)
        self.assertLessEqual(width, self.canvas.content_width)

    def test_bottom_slot_sits_on_content_bottom(self):
        rect = place_block(self.canvas, Slot.BOTTOM, 200, 100)
        self.assertAlmostEqual(rect.y1, self.canvas.content_bottom)
        self.assertAlmostEqual(rect.x0 + rect.width / 2, self.canvas.width / 2)

    def test_top_slot_sits_on_content_top(self):
        rect = place_block(self.canvas, Slot.TOP, 200, 100)
        self.assertAlmostEqual(rect.y0, self.canvas.content_top)

    def test_vertical_track_grows_in_columns(self):
        cue = Cue("1", 0, 1000, "一二三四五六七八九十")
        track = make_track(direction=ReadingDirection.TTB, max_width_ratio=0.2)
        width, height, columns = block_dimensions(cue, track, self.canvas)
        self.assertGreater(len(columns), 1)
        self.assertLessEqual(height, self.canvas.content_height)
        rect = cue_rect(cue, track, self.canvas, Slot.TOP)
        self.assertEqual(safe_area_overflow(rect, self.canvas), [])

    def test_oversized_block_reports_safe_area_overflow(self):
        canvas = Canvas(
            width=640,
            height=360,
            safe_margin=SafeMargin(top=40, right=40, bottom=40, left=40),
        )
        cue = Cue("1", 0, 1000, "巨")
        track = Track(
            name="big",
            language="zh",
            direction=ReadingDirection.LTR,
            style=TrackStyle(font_size=260),
        )
        rect = cue_rect(cue, track, canvas, Slot.BOTTOM)
        overflow = safe_area_overflow(rect, canvas)
        self.assertTrue(overflow)


if __name__ == "__main__":
    unittest.main()
