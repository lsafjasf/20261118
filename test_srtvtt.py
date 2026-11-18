import unittest

import srtvtt
from srtvtt import (
    ConversionReport,
    SubtitleError,
    convert_text,
    decode_subtitle,
    parse_srt,
    parse_vtt,
    to_srt,
    to_vtt,
)

SRT_SAMPLE = """1
00:00:01,000 --> 00:00:03,500
Hello, world!

2
00:00:04,000 --> 00:00:06,250
<i>Italic line</i>
second plain line

3
23:59:58,500 --> 00:00:02,250
Crossing midnight
"""


def roundtrip(cues_text, to_target, back_target):
    forward = convert_text(cues_text, to_target)
    return forward, convert_text(forward, back_target)


class TimestampTests(unittest.TestCase):
    def test_comma_and_dot_formats(self):
        self.assertEqual(srtvtt.parse_srt_timestamp("01:02:03,456"), 3723456)
        self.assertEqual(srtvtt.parse_srt_timestamp("01:02:03.456"), 3723456)
        self.assertEqual(srtvtt.parse_vtt_timestamp("01:02:03.456"), 3723456)
        self.assertEqual(srtvtt.parse_vtt_timestamp("02:03.456"), 123456)

    def test_cross_midnight_unwrap(self):
        cues = parse_srt(SRT_SAMPLE)
        self.assertEqual(cues[2].start_ms, 23 * 3600000 + 59 * 60000 + 58500)
        self.assertEqual(cues[2].end_ms, 24 * 3600000 + 2250)

    def test_order_error_locates_cue(self):
        bad = (
            "1\n00:00:05,000 --> 00:00:06,000\nA\n\n"
            "2\n00:00:04,000 --> 00:00:07,000\nB\n"
        )
        with self.assertRaises(SubtitleError) as ctx:
            parse_srt(bad)
        self.assertIn("cue 2", str(ctx.exception))
        self.assertIn("00:00:04,000", str(ctx.exception))

    def test_bad_duration_locates_cue(self):
        bad = "7\n00:00:05,000 --> 00:00:05,000\nA\n"
        with self.assertRaises(SubtitleError) as ctx:
            parse_srt(bad)
        self.assertIn("cue 7", str(ctx.exception))


class EncodingTests(unittest.TestCase):
    def test_windows1252_input(self):
        text = "1\n00:00:01,000 --> 00:00:02,000\nCafé \u201cnaïve\u201d \u2026\n"
        cues = parse_srt(decode_subtitle(text.encode("cp1252")))
        self.assertEqual(cues[0].lines[0], "Café \u201cnaïve\u201d \u2026")

    def test_utf8_bom(self):
        data = "\ufeffWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n".encode("utf-8")
        cues = parse_vtt(decode_subtitle(data))
        self.assertEqual(cues[0].lines, ["Hi"])

    def test_utf16_bom(self):
        data = "1\n00:00:01,000 --> 00:00:02,000\nHi\n".encode("utf-16")
        cues = parse_srt(decode_subtitle(data))
        self.assertEqual(cues[0].lines, ["Hi"])


class StyleTests(unittest.TestCase):
    def test_italic_survives_roundtrip(self):
        vtt, back = roundtrip(SRT_SAMPLE, "vtt", "srt")
        self.assertIn("<i>Italic line</i>", vtt)
        self.assertIn("<i>Italic line</i>", back)

    def test_multiline_preserved(self):
        _, back = roundtrip(SRT_SAMPLE, "vtt", "srt")
        self.assertIn("<i>Italic line</i>\nsecond plain line", back)

    def test_font_tag_warns_but_keeps_text(self):
        srt = (
            "1\n00:00:01,000 --> 00:00:02,000\n"
            '<font color="#ff0000">Red text</font>\n'
        )
        report = ConversionReport()
        vtt = convert_text(srt, "vtt", report)
        self.assertIn("Red text", vtt)
        self.assertNotIn("font", vtt)
        self.assertTrue(any("font" in w for w in report.warnings))

    def test_vtt_class_and_voice_warn_but_keep_text(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:04.000\n"
            "<c.foo>styled</c> <v Bob>spoken</v>\n"
        )
        report = ConversionReport()
        srt = convert_text(vtt, "srt", report)
        self.assertIn("styled spoken", srt)
        self.assertGreaterEqual(len(report.warnings), 2)

    def test_vtt_settings_warn_on_srt(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000 align:start position:10%\n"
            "Text\n"
        )
        report = ConversionReport()
        srt = convert_text(vtt, "srt", report)
        self.assertIn("Text", srt)
        self.assertTrue(any("settings" in w for w in report.warnings))


class RoundTripTests(unittest.TestCase):
    def assert_cues_equal(self, first, second, tolerance_ms=1):
        self.assertEqual(len(first), len(second))
        for a, b in zip(first, second):
            self.assertLessEqual(abs(a.start_ms - b.start_ms), tolerance_ms)
            self.assertLessEqual(abs(a.end_ms - b.end_ms), tolerance_ms)
            self.assertEqual(a.lines, b.lines)

    def test_srt_vtt_srt(self):
        original = parse_srt(SRT_SAMPLE)
        vtt_text = to_vtt(original)
        back = parse_vtt(vtt_text)
        self.assert_cues_equal(original, back)
        srt_text = to_srt(back)
        self.assert_cues_equal(original, parse_srt(srt_text))

    def test_vtt_srt_vtt(self):
        vtt = (
            "WEBVTT\n\n"
            "intro\n"
            "00:00:00.500 --> 00:00:02.750\n"
            "<b>Bold</b> and <u>under</u>\n\n"
            "00:00:03.000 --> 00:00:05.000\n"
            "line one\nline two\n"
        )
        original = parse_vtt(vtt)
        srt_text = to_srt(original)
        back = parse_srt(srt_text)
        self.assert_cues_equal(original, back)
        self.assert_cues_equal(original, parse_vtt(to_vtt(back)))

    def test_cross_midnight_roundtrip_exact_ms(self):
        srt = (
            "1\n23:59:59,999 --> 00:00:01,001\nLate show\n\n"
            "2\n00:00:02,000 --> 00:00:03,500\nAfter midnight\n"
        )
        original = parse_srt(srt)
        back = parse_srt(to_srt(parse_vtt(to_vtt(original))))
        self.assert_cues_equal(original, back, tolerance_ms=0)
        self.assertEqual(back[0].end_ms, 24 * 3600000 + 1001)


if __name__ == "__main__":
    unittest.main()
