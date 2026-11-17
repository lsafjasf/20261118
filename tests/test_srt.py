import unittest

from subtitle_layout.srt import parse_srt


class SrtParsingTests(unittest.TestCase):
    def test_parses_basic_blocks_with_comma_timestamp(self):
        content = (
            "1\n"
            "00:00:01,000 --> 00:00:02,500\n"
            "Hello world\n"
            "\n"
            "2\n"
            "00:00:03.000 --> 00:00:04,000\n"
            "Second cue\n"
        )
        cues = parse_srt(content)
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0].cue_id, "1")
        self.assertEqual(cues[0].start_ms, 1000)
        self.assertEqual(cues[0].end_ms, 2500)
        self.assertEqual(cues[0].text, "Hello world")
        self.assertEqual(cues[1].start_ms, 3000)

    def test_rejects_inverted_timing(self):
        with self.assertRaises(ValueError):
            parse_srt("1\n00:00:02,000 --> 00:00:01,000\nBad\n")

    def test_multiline_text_is_preserved(self):
        cues = parse_srt("1\n00:00:01,000 --> 00:00:02,000\nLine A\nLine B\n")
        self.assertEqual(cues[0].lines, ["Line A", "Line B"])


if __name__ == "__main__":
    unittest.main()
