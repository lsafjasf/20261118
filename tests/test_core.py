import math
import os
import tempfile
import unittest

from downmix.engine import CHANNELS, DEFAULT_GAIN_DB, DownmixConfig, downmix
from downmix.meters import (
    center_dominance,
    channel_stats,
    pearson_correlation,
    stereo_planar,
    surround_cancellation,
    surround_retention,
)
from downmix.wavio import read_wav, write_wav


def silence(frames):
    return [0.0] * (frames * 6)


class EngineTests(unittest.TestCase):
    def test_standard_downmix_coefficients(self):
        config = DownmixConfig()
        left, right = config.coefficients()
        self.assertAlmostEqual(left["L"], 1.0)
        self.assertAlmostEqual(right["R"], 1.0)
        self.assertAlmostEqual(left["C"], 10 ** (-3 / 20), places=6)
        self.assertAlmostEqual(right["Ls"], 0.0)
        self.assertAlmostEqual(left["Rs"], 0.0)
        self.assertEqual(left["LFE"], 0.0)
        self.assertEqual(right["LFE"], 0.0)

    def test_uses_all_six_channels_not_just_lr(self):
        samples = silence(4)
        for frame in range(4):
            samples[frame * 6 + 2] = 0.8   # centre
            samples[frame * 6 + 4] = 0.6   # Ls
            samples[frame * 6 + 5] = 0.4   # Rs
            samples[frame * 6 + 3] = 0.5   # LFE
        config = DownmixConfig(soft_clip=False)
        stereo, _ = downmix(samples, 6, config)
        left, right = stereo_planar(stereo)
        # With L/R silent, a naive L/R-only fold-down would output silence.
        self.assertTrue(all(value != 0.0 for value in left))
        self.assertTrue(all(value != 0.0 for value in right))
        k = 10 ** (-3 / 20)
        self.assertAlmostEqual(left[0], k * (0.8 + 0.6), places=6)
        self.assertAlmostEqual(right[0], k * (0.8 + 0.4), places=6)

    def test_lfe_gain_is_adjustable_and_default_off(self):
        samples = silence(2)
        samples[3] = 1.0  # LFE of first frame
        default_mix, _ = downmix(
            samples, 6, DownmixConfig(soft_clip=False)
        )
        self.assertEqual(default_mix[0], 0.0)
        config = DownmixConfig(gain_db={"LFE": -6.0}, soft_clip=False)
        mixed, _ = downmix(samples, 6, config)
        self.assertAlmostEqual(mixed[0], 10 ** (-6 / 20), places=6)
        self.assertAlmostEqual(mixed[1], 10 ** (-6 / 20), places=6)

    def test_dialogue_protection_boosts_centre_only(self):
        samples = silence(1)
        samples[2] = 1.0
        base, _ = downmix(samples, 6, DownmixConfig(soft_clip=False))
        protected, _ = downmix(
            samples, 6,
            DownmixConfig(dialogue_protection_db=6.0, soft_clip=False),
        )
        ratio = protected[0] / base[0]
        self.assertAlmostEqual(ratio, 10 ** (6 / 20), places=5)
        # L/R gains must be untouched by dialogue protection.
        cfg = DownmixConfig(dialogue_protection_db=6.0)
        self.assertAlmostEqual(cfg.effective_gain("L"), 1.0)

    def test_solo_auditions_single_channel(self):
        samples = silence(3)
        for frame in range(3):
            samples[frame * 6 + 0] = 0.9
            samples[frame * 6 + 1] = 0.9
            samples[frame * 6 + 2] = 0.5
        config = DownmixConfig(solo=["C"])
        stereo, _ = downmix(samples, 6, config)
        left, right = stereo_planar(stereo)
        self.assertTrue(all(v > 0.0 for v in left))
        # L/R are excluded while C is soloed.
        self.assertNotIn(0.9 * (10 ** (-3 / 20)), [round(v, 6) for v in left])

    def test_mute_and_solo_interaction(self):
        config = DownmixConfig(solo=["L", "R"], muted=["R"])
        self.assertEqual(config.effective_gain("R"), 0.0)
        self.assertEqual(config.effective_gain("C"), 0.0)
        self.assertAlmostEqual(config.effective_gain("L"), 1.0)

    def test_soft_clipping_keeps_output_in_range(self):
        samples = silence(1)
        for ch in range(6):
            samples[ch] = 1.0
        stereo, peak = downmix(samples, 6, DownmixConfig())
        self.assertGreater(peak["L"], 1.0)  # bus overload detected pre-saturation
        self.assertLessEqual(abs(stereo[0]), 1.0)
        hard, _ = downmix(
            samples, 6, DownmixConfig(soft_clip=False)
        )
        self.assertGreater(hard[0], 1.0)


class MeterTests(unittest.TestCase):
    def test_rms_peak_and_clipping_counts(self):
        samples = silence(8)
        for frame in range(8):
            samples[frame * 6 + 2] = 0.5
        samples[2 * 6 + 2] = 1.2  # clipped centre sample
        stats = channel_stats(samples, 6)
        centre = next(s for s in stats if s.name == "C")
        self.assertEqual(centre.clip_count, 1)
        self.assertGreaterEqual(centre.peak, 1.0)
        self.assertGreater(centre.rms, 0.0)
        silent = next(s for s in stats if s.name == "LFE")
        self.assertEqual(silent.clip_count, 0)
        self.assertEqual(silent.rms_db, float("-inf"))

    def test_center_dominance_flags_mono_mix(self):
        mono = [0.4] * 256
        self.assertGreater(center_dominance(mono, mono), 0.95)
        left = [math.sin(i * 0.3) for i in range(512)]
        right = [-v for v in left]
        self.assertLess(center_dominance(left, right), 0.05)

    def test_correlation_detects_phase_inversion(self):
        left = [math.sin(i * 0.11) for i in range(1024)]
        self.assertLess(pearson_correlation(left, [-v for v in left]), -0.99)
        self.assertGreater(pearson_correlation(left, left), 0.99)

    def test_surround_phase_trap_diagnostics(self):
        samples = silence(128)
        for frame in range(128):
            value = math.sin(frame * 0.2)
            samples[frame * 6 + 4] = value
            samples[frame * 6 + 5] = -value
        config = DownmixConfig()
        retention = surround_retention(samples, None, config)
        cancellation = surround_cancellation(samples, config)
        self.assertLess(retention, 0.05)
        self.assertGreater(cancellation, 0.95)

    def test_healthy_independent_surrounds_are_retained(self):
        samples = silence(2048)
        for frame in range(2048):
            samples[frame * 6 + 4] = math.sin(frame * 0.13)
            samples[frame * 6 + 5] = math.sin(frame * 0.27 + 1.7)
        config = DownmixConfig()
        self.assertGreater(surround_retention(samples, None, config), 0.7)
        self.assertLess(surround_cancellation(samples, config), 0.5)


class WavRoundTripTests(unittest.TestCase):
    def test_float32_multichannel_roundtrip(self):
        samples = []
        for frame in range(64):
            samples.extend(
                [0.25 * math.sin(frame * 0.2 + ch) for ch in range(6)]
            )
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "six.wav")
            write_wav(path, samples, 48000, 6)
            loaded, rate, nch = read_wav(path)
        self.assertEqual(rate, 48000)
        self.assertEqual(nch, 6)
        self.assertEqual(len(loaded), len(samples))
        for a, b in zip(loaded, samples):
            self.assertAlmostEqual(a, b, places=5)

    def test_pcm16_roundtrip_and_clip_accounting(self):
        samples = [0.0, 0.5, -0.5, 1.0, -1.0, 2.0]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "stereo.wav")
            clipped = write_wav(path, samples, 44100, 2, subtype="pcm16")
            loaded, rate, nch = read_wav(path)
        self.assertEqual(nch, 2)
        self.assertEqual(rate, 44100)
        self.assertGreaterEqual(clipped, 1)  # the 2.0 sample is clipped
        self.assertAlmostEqual(loaded[1], 0.5, delta=1e-4)
        self.assertLessEqual(max(abs(v) for v in loaded), 1.0)


if __name__ == "__main__":
    unittest.main()
