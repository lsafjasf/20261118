"""Regression checks for the WebM Cues rebuilder (stdlib unittest only)."""

import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import ebml, rebuilder, seeker, synth
from src.scanner import scan


class EbmlTests(unittest.TestCase):
    def test_vint_roundtrip(self):
        for value in [0, 1, 126, 127, 128, 16382, 2 ** 32, 2 ** 48]:
            encoded = ebml.encode_vint(value)
            decoded, width = ebml.read_vint(encoded, 0)
            self.assertEqual(decoded, value)
            self.assertEqual(width, len(encoded))

    def test_unknown_size_vint(self):
        encoded = ebml.encode_vint(0, width=8, unknown=True)
        self.assertEqual(encoded, b"\x01\xff\xff\xff\xff\xff\xff\xff")


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.damaged = os.path.join(self.tmp, "damaged.webm")
        self.repaired = os.path.join(self.tmp, "repaired.webm")
        blob, _ = synth.generate(duration_s=10)
        with open(self.damaged, "wb") as handle:
            handle.write(blob)
        synth.corrupt_cues(self.damaged, mode="garbage")

    def _cluster_hash(self, path):
        result = scan(path)
        with open(path, "rb") as handle:
            data = handle.read()
        digest = hashlib.sha256()
        for cluster in result.clusters:
            digest.update(data[cluster.abs_offset:cluster.elem_end])
        return digest.hexdigest()

    def test_tracks_clusters_and_timecodes_recognized(self):
        result = scan(self.damaged)
        self.assertEqual({t.kind for t in result.tracks.values()},
                         {"video", "audio"})
        self.assertEqual(len(result.clusters), 10)
        self.assertEqual(result.clusters[0].timecode_ms, 0)
        self.assertEqual(result.clusters[-1].timecode_ms, 9000)

    def test_damaged_file_not_seekable(self):
        self.assertIsNone(seeker.addressable_range(self.damaged))

    def test_repair_restores_addressability_without_touching_media(self):
        report = rebuilder.repair_file(self.damaged, self.repaired)
        self.assertGreater(len(report["entries"]), 0)
        self.assertEqual(self._cluster_hash(self.damaged),
                         self._cluster_hash(self.repaired))

        with open(self.damaged, "rb") as handle:
            damaged = handle.read()
        with open(self.repaired, "rb") as handle:
            repaired = handle.read()
        self.assertTrue(repaired.startswith(damaged))

        first_tc, last_tc, count = seeker.addressable_range(self.repaired)
        self.assertEqual(first_tc, 0)
        self.assertGreaterEqual(last_tc, 8000)
        self.assertEqual(count, len(report["entries"]))

    def test_ten_seek_targets_land_near_target(self):
        rebuilder.repair_file(self.damaged, self.repaired)
        targets = [300, 1200, 2300, 3400, 4500, 5600, 6700, 7800, 8900, 9500]
        for target in targets:
            probe = seeker.seek(self.repaired, target)
            self.assertIsNotNone(probe.landed_time_ms)
            self.assertLessEqual(probe.landed_time_ms, target)
            self.assertLessEqual(probe.seek_error_ms, 2000)

    def test_truncate_mode(self):
        truncated = os.path.join(self.tmp, "trunc.webm")
        blob, _ = synth.generate(duration_s=6)
        with open(truncated, "wb") as handle:
            handle.write(blob)
        synth.corrupt_cues(truncated, mode="truncate")
        self.assertEqual(len(scan(truncated).cues_elements), 0)
        out = os.path.join(self.tmp, "trunc_fixed.webm")
        rebuilder.repair_file(truncated, out)
        self.assertIsNotNone(seeker.addressable_range(out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
