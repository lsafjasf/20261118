from __future__ import annotations

import json
import unittest
from pathlib import Path

from dashcheck.mpdparser import (
    build_initialization_url,
    build_segment_url,
    parse_iso8601_duration,
    parse_mpd,
)
from dashcheck.player import simulate_playback, verify_seek_consistency
from dashcheck.seek import seek
from dashcheck.timeline import (
    empty_urls_from_store,
    mark_empty_segments,
    validate_manifest,
)

ROOT = Path(__file__).resolve().parent.parent
MPD_PATH = ROOT / "mpd" / "sample.mpd"
STORE_PATH = ROOT / "artifacts" / "segments.json"


class IsoDurationTest(unittest.TestCase):
    def test_parses_full_duration(self) -> None:
        self.assertEqual(parse_iso8601_duration("PT22S"), 22.0)
        self.assertEqual(parse_iso8601_duration("PT1M30.5S"), 90.5)
        self.assertIsNone(parse_iso8601_duration(None))

    def test_rejects_garbage(self) -> None:
        with self.assertRaises(ValueError):
            parse_iso8601_duration("22s")


class TemplateTest(unittest.TestCase):
    def test_segment_url_substitution(self) -> None:
        url = build_segment_url(
            "P1/$RepresentationID$/chunk-$Number%05u$-$Time$.m4s",
            "vhigh",
            7,
            180000,
        )
        self.assertEqual(url, "P1/vhigh/chunk-00007-180000.m4s")

    def test_init_url_substitution(self) -> None:
        self.assertEqual(
            build_initialization_url("P1/$RepresentationID$/init.mp4", "vlow"),
            "P1/vlow/init.mp4",
        )


class ManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = parse_mpd(str(MPD_PATH))
        self.store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        mark_empty_segments(self.manifest, empty_urls_from_store(self.store))

    def test_period_layout(self) -> None:
        ids = [period.id for period in self.manifest.periods]
        self.assertEqual(ids, ["P1", "P2", "P3"])
        self.assertEqual(
            [(p.start_s, p.end_s) for p in self.manifest.periods],
            [(0.0, 10.0), (9.0, 17.0), (17.0, 22.0)],
        )

    def test_segment_count_and_urls(self) -> None:
        counts = {
            (period.id, rep.id): len(rep.segments)
            for period in self.manifest.periods
            for rep in period.representations
        }
        self.assertEqual(
            counts,
            {
                ("P1", "vhigh"): 3,
                ("P1", "vlow"): 3,
                ("P2", "vhigh"): 2,
                ("P2", "vlow"): 2,
                ("P3", "vhigh"): 2,
                ("P3", "vlow"): 2,
            },
        )
        p1_high = self.manifest.periods[0].representations[0]
        first = p1_high.segments[0]
        self.assertEqual(first.url, "P1/vhigh/chunk-00007-180000.m4s")
        self.assertEqual(first.presentation_start_s, 0.0)

    def test_pto_and_timescale_conversion(self) -> None:
        p1_high = next(
            rep
            for rep in self.manifest.periods[0].representations
            if rep.id == "vhigh"
        )
        p1_low = next(
            rep
            for rep in self.manifest.periods[0].representations
            if rep.id == "vlow"
        )
        for high, low in zip(p1_high.segments, p1_low.segments):
            self.assertAlmostEqual(
                high.presentation_start_s, low.presentation_start_s, places=6
            )
            self.assertAlmostEqual(high.duration_s, low.duration_s, places=6)
        middle = p1_high.segments[1]
        self.assertEqual(middle.media_time, 540000)
        self.assertAlmostEqual(middle.period_relative_s, 4.0)
        self.assertAlmostEqual(
            (middle.media_time - p1_high.template.presentation_time_offset)
            / p1_high.template.timescale,
            4.0,
        )

    def test_representation_level_template_override(self) -> None:
        p2_high = self.manifest.periods[1].representations[0]
        self.assertEqual(p2_high.template.presentation_time_offset, 90000)
        self.assertEqual(p2_high.template.timescale, 90000)
        self.assertIsNotNone(p2_high.template.media)
        self.assertEqual(p2_high.segments[0].period_relative_s, 0.0)

    def test_validation_detects_all_designed_issues(self) -> None:
        issues = validate_manifest(self.manifest, self.store)
        codes = sorted(issue.code for issue in issues)
        self.assertIn("PERIOD_OVERLAP", codes)
        self.assertEqual(codes.count("SEGMENT_OVERHANG"), 4)
        self.assertIn("EMPTY_SEGMENT", codes)
        self.assertIn("ORPHAN_STORE_OBJECT", codes)
        overlap = next(issue for issue in issues if issue.code == "PERIOD_OVERLAP")
        self.assertIn("overlap 1s", overlap.message)

    def test_empty_segment_flagged_on_segments(self) -> None:
        issues = validate_manifest(self.manifest, self.store)
        empty_warning = next(issue for issue in issues if issue.code == "EMPTY_SEGMENT")
        self.assertEqual(empty_warning.detail["representation"], "vhigh")
        p1_high = self.manifest.periods[0].representations[0]
        self.assertTrue(p1_high.segments[1].is_empty)
        self.assertFalse(p1_high.segments[0].is_empty)

    def test_seek_resolution_and_keyframe_flags(self) -> None:
        result = seek(self.manifest, 4.5)
        self.assertEqual(len(result.hits), 2)
        high_hit = next(hit for hit in result.hits if hit.representation_id == "vhigh")
        self.assertTrue(high_hit.segment.starts_with_keyframe)
        self.assertTrue(high_hit.segment.is_empty)
        self.assertAlmostEqual(high_hit.offset_in_segment_s, 0.5)

    def test_seek_inside_overlap_is_ambiguous(self) -> None:
        result = seek(self.manifest, 9.5)
        self.assertEqual(result.matched_periods, ["P1", "P2"])
        self.assertTrue(all(hit.ambiguous_period for hit in result.hits))

    def test_seek_out_of_range(self) -> None:
        for bad_time in (-1.0, 23.0):
            result = seek(self.manifest, bad_time)
            self.assertFalse(result.in_presentation)
            self.assertEqual(result.hits, [])

    def test_player_simulation_matches_parser(self) -> None:
        report = simulate_playback(self.manifest, self.store)
        self.assertEqual(report.failures, [])
        self.assertEqual(
            report.skipped_empty_urls,
            ["P1/vhigh/chunk-00008-540000.m4s"],
        )
        first = report.requests[0]
        self.assertEqual(first.expected_base_media_decode_time, 0)
        self.assertEqual(first.presentation_start_s, 0.0)
        failures = verify_seek_consistency(
            self.manifest,
            self.store,
            [0.5, 4.5, 7.0, 9.5, 16.5, 21.0],
        )
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
