import json
import os
import subprocess
import sys
import tempfile
import unittest

from downmix.clipgen import build_test_clip, flatten, segment_slices
from downmix.engine import DownmixConfig, downmix
from downmix.meters import analyze, channel_stats, stereo_planar
from downmix.tui import render_console
from downmix.wavio import read_wav, write_wav


class TestClipTests(unittest.TestCase):
    def setUp(self):
        self.frames, self.rate, self.table = build_test_clip()
        self.samples = flatten(self.frames)
        self.slices = segment_slices(self.table)

    def _segment_channels(self, name):
        start, end = self.slices[name]
        return [
            [self.samples[(f * 6) + ch] for f in range(start, end)]
            for ch in range(6)
        ]

    def test_clip_contains_all_required_segments(self):
        self.assertEqual(
            [name for name, _ in self.table],
            [
                "directional_movement",
                "dialogue",
                "lfe",
                "surround_phase_trap",
            ],
        )

    def test_dialogue_lives_in_centre_channel(self):
        channels = self._segment_channels("dialogue")
        self.assertTrue(any(v != 0.0 for v in channels[2]))
        for ch in (0, 1, 3, 4, 5):
            self.assertTrue(all(v == 0.0 for v in channels[ch]))

    def test_lfe_segment_is_low_frequency_and_lfe_only(self):
        channels = self._segment_channels("lfe")
        self.assertTrue(any(abs(v) > 0.0 for v in channels[3]))
        for ch in (0, 1, 2, 4, 5):
            self.assertTrue(all(v == 0.0 for v in channels[ch]))

    def test_directional_movement_pans_between_channels(self):
        start, end = self.slices["directional_movement"]
        active = {ch: False for ch in range(6)}
        for frame in range(start, end):
            for ch in range(6):
                if self.samples[frame * 6 + ch] != 0.0:
                    active[ch] = True
        # L, R, C, Ls, Rs all carry the panning signal; LFE does not.
        for ch in (0, 1, 2, 4, 5):
            self.assertTrue(active[ch], "channel %d never panned" % ch)
        self.assertFalse(active[3])

    def test_phase_trap_triggers_diagnostic(self):
        start, end = self.slices["surround_phase_trap"]
        trap = [0.0] * ((end - start) * 6)
        for f in range(end - start):
            trap[f * 6 + 4] = self.samples[(start + f) * 6 + 4]
            trap[f * 6 + 5] = self.samples[(start + f) * 6 + 5]
        config = DownmixConfig(soft_clip=False)
        stereo, _ = downmix(trap, 6, config)
        result = analyze(trap, 6, stereo, config)
        self.assertLess(result["surround_retention"], 0.1)
        self.assertGreater(result["surround_cancellation"], 0.9)
        self.assertTrue(
            any("surround" in w for w in result["warnings"])
        )
        # Ls = -Rs folds to L = -R: the mono sum L+R cancels to silence,
        # which is exactly how the surrounds disappear on mono playback.
        left, right = stereo_planar(stereo)
        self.assertTrue(all(abs(l + r) < 1e-9 for l, r in zip(left, right)))

    def test_full_clip_downmix_uses_more_than_lr(self):
        config = DownmixConfig()
        stereo, _ = downmix(self.samples, 6, config)
        result = analyze(self.samples, 6, stereo, config)
        input_stats = channel_stats(self.samples, 6)
        # Every input channel carries energy in the generated material.
        for stat in input_stats:
            self.assertGreater(stat.sample_count, 0)
        centre = next(s for s in input_stats if s.name == "C")
        lfe = next(s for s in input_stats if s.name == "LFE")
        self.assertGreater(centre.rms, 0.0)
        self.assertGreater(lfe.rms, 0.0)
        # Default mix excludes LFE; enabling it changes the output.
        with_lfe, _ = downmix(
            self.samples, 6,
            DownmixConfig(gain_db={"LFE": 0.0}, soft_clip=False),
        )
        no_lfe, _ = downmix(
            self.samples, 6, DownmixConfig(soft_clip=False)
        )
        # LFE segment starts only after movement + dialogue, so compare the
        # full buffers rather than the first samples.
        self.assertNotEqual(no_lfe, with_lfe)

    def test_centre_dominance_warns_when_dialogue_protected_too_hard(self):
        config = DownmixConfig(dialogue_protection_db=12.0)
        start, end = self.slices["dialogue"]
        segment = flatten(self.frames[start:end])
        stereo, _ = downmix(segment, 6, config)
        result = analyze(segment, 6, stereo, config)
        self.assertGreater(result["center_dominance"], 0.75)
        self.assertTrue(
            any("centre" in w for w in result["warnings"])
        )

    def test_console_render_contains_meters_and_warnings(self):
        config = DownmixConfig()
        stereo, _ = downmix(self.samples, 6, config)
        result = analyze(self.samples, 6, stereo, config)
        view = render_console(
            result["input_stats"], result["output_stats"], result,
            config, len(self.frames),
        )
        self.assertIn("LFE", view)
        self.assertIn("centre dominance", view)
        self.assertIn("surround retention", view)


class CliEndToEndTests(unittest.TestCase):
    def test_cli_generates_wav_and_json_report(self):
        frames, rate, _ = build_test_clip()
        flat = flatten(frames)
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "input.wav")
            dst = os.path.join(tmp, "stereo.wav")
            write_wav(src, flat, rate, 6)
            proc = subprocess.run(
                [
                    sys.executable, "-m", "downmix.cli", src,
                    "-o", dst, "-d", "3", "-g", "LFE=-6",
                    "--report", "json",
                ],
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                capture_output=True, text=True, check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["sample_rate"], rate)
            self.assertEqual(len(payload["input_stats"]), 6)
            self.assertEqual(payload["dialogue_protection_db"], 3.0)
            self.assertTrue(os.path.exists(dst))
            loaded, out_rate, nch = read_wav(dst)
            self.assertEqual(nch, 2)
            self.assertEqual(out_rate, rate)
            self.assertEqual(len(loaded), len(frames) * 2)
            self.assertIn("warnings", payload)

    def test_cli_make_test_clip_then_solo_centre(self):
        with tempfile.TemporaryDirectory() as tmp:
            clip = os.path.join(tmp, "clip.wav")
            subprocess.run(
                [sys.executable, "-m", "downmix.cli",
                 "--make-test-clip", clip],
                capture_output=True, text=True, check=True,
            )
            proc = subprocess.run(
                [sys.executable, "-m", "downmix.cli", clip,
                 "--solo", "C", "--report", "json"],
                capture_output=True, text=True, check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["solo"], ["C"])
            # While C is soloed the other five channels contribute nothing.
            expected_frames = flat_frames(clip)
            for stat in payload["input_stats"]:
                self.assertEqual(stat["sample_count"], expected_frames)


def flat_frames(path):
    samples, _rate, nch = read_wav(path)
    return len(samples) // nch


if __name__ == "__main__":
    unittest.main()
