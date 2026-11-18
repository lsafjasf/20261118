import math
import tempfile
import unittest
from pathlib import Path

from drift_audio.analysis import (
    aligned_rms_error,
    analyze_signals,
    local_offset,
    make_test_signals,
)
from drift_audio.dsp import fft, resample_channels
from drift_audio.wavio import read_wav, write_wav


class DriftAudioTests(unittest.TestCase):
    def test_fft_round_trip(self):
        values = [complex(math.sin(index * 0.37), math.cos(index * 0.21)) for index in range(64)]
        spectrum = values[:]
        fft(spectrum)
        fft(spectrum, invert=True)
        for original, restored in zip(values, spectrum):
            self.assertAlmostEqual(original.real, restored.real, places=9)
            self.assertAlmostEqual(original.imag, restored.imag, places=9)

    def test_wav_round_trip(self):
        channels = [[0.15, -0.25, 0.5, -0.75]]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.wav"
            write_wav(str(path), channels, 16000)
            restored, rate = read_wav(str(path))
        self.assertEqual(rate, 16000)
        for expected, actual in zip(channels[0], restored[0]):
            self.assertAlmostEqual(expected, actual, delta=3.2e-5)

    def test_synthetic_drift_correction_preserves_pitch(self):
        rate = 24000
        reference, drifted = make_test_signals(rate, seconds=6.0, drift_factor=1.0005)
        result = analyze_signals(reference, drifted, rate, point_count=10)
        self.assertAlmostEqual(result.slope, -0.0005, delta=2.5e-5)
        self.assertLess(result.residual_rms_seconds, 3e-5)

        target_length = int(math.floor((len(drifted) - 1) * result.resample_ratio)) + 1
        corrected = resample_channels(
            [drifted],
            target_length,
            result.resample_ratio,
            result.intercept * rate,
        )[0]
        start = max(0, int(round(result.intercept * rate)))
        end_offset, _ = local_offset(reference, drifted, rate, len(drifted) / rate - 0.5)
        remaining_offset, _ = local_offset(
            reference[start:], corrected, rate, 0.45
        )
        corrected_rms = aligned_rms_error(
            reference[start : start + len(corrected)], corrected
        )
        initial_rms = aligned_rms_error(
            reference[: len(drifted)], drifted
        )

        self.assertGreater(abs(end_offset), 0.0025)
        self.assertLess(abs(remaining_offset), 2e-5)
        self.assertLess(corrected_rms, initial_rms * 0.05)


if __name__ == "__main__":
    unittest.main()
