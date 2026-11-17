"""unittest suite for bwfmeta; run: python3 -m unittest discover tests"""
from __future__ import annotations

import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import make_samples  # noqa: E402
from bwfmeta.check import check_wave  # noqa: E402
from bwfmeta.edit import EditError, export_wave, set_field  # noqa: E402
from bwfmeta.riff import parse_wave, roundtrip_ok  # noqa: E402


def build(kind: str) -> bytes:
    if kind == "missing_bext":
        return make_samples.wave(
            make_samples.fmt_chunk(),
            make_samples.ixml_chunk(make_samples.TIMREF_0800),
            make_samples.cue_chunks(), make_samples.data_chunk())
    if kind == "timeref_mismatch":
        return make_samples.wave(
            make_samples.fmt_chunk(),
            make_samples.bext_chunk(make_samples.TIMREF_0800),
            make_samples.ixml_chunk(make_samples.TIMREF_0900),
            make_samples.cue_chunks(), make_samples.data_chunk())
    if kind == "unknown_chunk":
        return make_samples.wave(
            make_samples.fmt_chunk(),
            make_samples.bext_chunk(make_samples.TIMREF_0800),
            make_samples.ixml_chunk(make_samples.TIMREF_0800),
            make_samples.chunk(b"zzZ1", b"proprietary-payload\x00\x01\x02"),
            make_samples.cue_chunks(), make_samples.data_chunk())
    raise ValueError(kind)


def data_sha(blob: bytes) -> str:
    return hashlib.sha256(parse_wave(blob).find(b"data").payload).hexdigest()


class TestRoundTrip(unittest.TestCase):
    def test_parse_build_is_identity(self):
        for kind in ("missing_bext", "timeref_mismatch", "unknown_chunk"):
            self.assertTrue(roundtrip_ok(build(kind)), kind)


class TestChecks(unittest.TestCase):
    def test_missing_bext_flagged(self):
        findings = check_wave(parse_wave(build("missing_bext")))
        self.assertTrue(any(f.field == "bext" and f.severity == "error"
                            for f in findings))

    def test_timeref_mismatch_flagged_with_offsets(self):
        findings = check_wave(parse_wave(build("timeref_mismatch")))
        hit = [f for f in findings
               if f.field == "iXML.BEXT/BWF_TIME_REFERENCE"]
        self.assertEqual(len(hit), 1)
        self.assertIsNotNone(hit[0].offset)
        self.assertIn("bext.time_reference", hit[0].message)

    def test_unknown_chunk_flagged_with_offset(self):
        findings = check_wave(parse_wave(build("unknown_chunk")))
        hit = [f for f in findings if f.field == "zzZ1"]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0].severity, "warning")
        self.assertIsNotNone(hit[0].offset)

    def test_consistent_file_has_no_errors(self):
        findings = check_wave(parse_wave(build("unknown_chunk")))
        self.assertFalse([f for f in findings if f.severity == "error"])


class TestEditExport(unittest.TestCase):
    def test_safe_edit_keeps_structure_and_audio(self):
        blob = build("timeref_mismatch")
        wave = parse_wave(blob)
        before_ids = [c.cid for c in wave.chunks]
        set_field(wave, "bext.description", "new description")
        set_field(wave, "ixml.SCENE", "14B")
        set_field(wave, "cue.label", "1=Scene 14B slate")
        out = export_wave(wave)
        again = parse_wave(out)
        self.assertEqual([c.cid for c in again.chunks], before_ids)
        self.assertEqual(data_sha(out), data_sha(blob))

    def test_double_export_is_stable(self):
        wave = parse_wave(build("unknown_chunk"))
        set_field(wave, "ixml.TAKE", "7")
        once = export_wave(wave)
        twice = export_wave(parse_wave(once))
        self.assertEqual(once, twice)

    def test_unsafe_fields_refused(self):
        wave = parse_wave(build("unknown_chunk"))
        for field in ("bext.time_reference", "fmt.channel_mask",
                      "fmt.sample_rate", "data", "bext.version"):
            with self.assertRaises(EditError, msg=field):
                set_field(wave, field, "1")

    def test_scene_mismatch_detected_then_fixed(self):
        blob = build("unknown_chunk")
        wave = parse_wave(blob)
        set_field(wave, "ixml.SCENE", "99Z")
        out = export_wave(wave)
        findings = check_wave(parse_wave(out))
        self.assertTrue(any(f.field == "cue.label"
                            and f.severity == "error" for f in findings))
        wave2 = parse_wave(out)
        set_field(wave2, "cue.label", "1=Scene 99Z slate")
        out2 = export_wave(wave2)
        findings2 = check_wave(parse_wave(out2))
        self.assertFalse([f for f in findings2 if f.severity == "error"])


if __name__ == "__main__":
    unittest.main()
