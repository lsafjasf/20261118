from __future__ import annotations

import math
from pathlib import Path
import tempfile
import unittest

from pcm_repair.audio import Audio, read_wav, write_wav
from pcm_repair.demo import POP_POSITIONS, inject_pops, synthesize_drums
from pcm_repair.detector import repair_audio
from pcm_repair.metrics import compare_audio
from pcm_repair.waveform import render_waveform_svg


def _tone(rate: int, frames: int) -> list[float]:
    return [
        0.18 * math.sin(2.0 * math.pi * 220.0 * frame / rate)
        + 0.07 * math.sin(2.0 * math.pi * 730.0 * frame / rate)
        for frame in range(frames)
    ]


class AudioIoTest(unittest.TestCase):
    def test_integer_pcm_round_trip_all_bit_depths(self) -> None:
        for width in (1, 2, 3, 4):
            with self.subTest(width=width), tempfile.TemporaryDirectory() as directory:
                source = Audio(
                    48000,
                    width,
                    [
                        [-0.75, -0.125, 0.0, 0.125, 0.75],
                        [0.5, 0.25, 0.0, -0.25, -0.5],
                    ],
                )
                path = Path(directory) / f"pcm_{width}.wav"
                write_wav(path, source)
                decoded = read_wav(path)
                self.assertEqual(decoded.sample_rate, source.sample_rate)
                self.assertEqual(decoded.sample_width, width)
                self.assertEqual(decoded.channels, source.channels)
                self.assertEqual(decoded.frames, source.frames)
                quantum = 2.0 / (1 << (8 * width))
                for expected_channel, actual_channel in zip(
                    source.samples, decoded.samples
                ):
                    for expected, actual in zip(expected_channel, actual_channel):
                        self.assertLessEqual(abs(expected - actual), quantum)


class RepairTest(unittest.TestCase):
    def test_three_isolated_pops_are_found_and_filled(self) -> None:
        rate = 44100
        clean_samples = _tone(rate, rate)
        damaged_samples = clean_samples[:]
        positions = [7000, 17000, 33000]
        for position in positions:
            damaged_samples[position] += 0.65
        result = repair_audio(Audio(rate, 2, [damaged_samples]))

        self.assertEqual(
            [(interval.start, interval.end) for interval in result.intervals],
            [(position, position + 1) for position in positions],
        )
        self.assertEqual(result.sample_changes, 3)
        for position in positions:
            self.assertNotEqual(
                result.audio.samples[0][position], damaged_samples[position]
            )
        changed = set(positions)
        for frame, (before, after) in enumerate(
            zip(damaged_samples, result.audio.samples[0])
        ):
            if frame not in changed:
                self.assertEqual(before, after)

        metrics = compare_audio(
            Audio(rate, 2, [clean_samples]),
            result.audio,
            result,
            Audio(rate, 2, [damaged_samples]),
        )
        self.assertLess(metrics.max_error, 0.001)

    def test_piecewise_fill_recovers_a_three_sample_break(self) -> None:
        rate = 44100
        clean_samples = _tone(rate, rate)
        damaged_samples = clean_samples[:]
        for offset, value in enumerate((0.85, 0.72, 0.60)):
            damaged_samples[20000 + offset] = value
        result = repair_audio(Audio(rate, 2, [damaged_samples]))

        self.assertEqual(
            [(interval.start, interval.end) for interval in result.intervals],
            [(20000, 20003)],
        )
        self.assertEqual(result.sample_changes, 3)
        metrics = compare_audio(
            Audio(rate, 2, [clean_samples]),
            result.audio,
            result,
            Audio(rate, 2, [damaged_samples]),
        )
        self.assertLess(metrics.max_error_in_repairs, 0.006)

    def test_isolated_pop_is_repaired_but_percussive_onset_is_rejected(self) -> None:
        rate = 44100
        start = 8000
        pop = [0.0] * (rate // 2)
        pop[start] = 0.8
        pop_result = repair_audio(Audio(rate, 2, [pop]))
        self.assertEqual(pop_result.sample_changes, 1)

        drum = [0.0] * (rate // 2)
        for offset in range(int(0.12 * rate)):
            envelope = 0.8 if offset == 0 else 0.08 * math.exp(-offset / rate * 18.0)
            drum[start + offset] = envelope * math.cos(
                2.0 * math.pi * 160.0 * offset / rate
            )
        drum_result = repair_audio(Audio(rate, 2, [drum]))
        self.assertEqual(drum_result.candidate_groups, 1)
        self.assertEqual(drum_result.rejected_percussive_groups, 1)
        self.assertEqual(drum_result.sample_changes, 0)


class DrumFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.clean, cls.events = synthesize_drums()

    def test_clean_drum_groups_have_no_false_repairs(self) -> None:
        result = repair_audio(self.clean)
        self.assertEqual(result.sample_changes, 0)
        self.assertEqual(result.interval_count, 0)
        self.assertGreaterEqual(len(self.events), 50)

    def test_three_pops_mixed_with_two_drum_groups_are_repaired(self) -> None:
        damaged = inject_pops(self.clean)
        result = repair_audio(damaged)
        expected = [
            (int(position * damaged.sample_rate), int(position * damaged.sample_rate) + 1)
            for position in POP_POSITIONS
        ]
        self.assertEqual(
            [(interval.start, interval.end) for interval in result.intervals],
            expected,
        )
        self.assertEqual(result.sample_changes, 6)
        metrics = compare_audio(self.clean, result.audio, result, damaged)
        self.assertLess(metrics.max_error_in_repairs, 0.001)

        with tempfile.TemporaryDirectory() as directory:
            svg_path = Path(directory) / "waveform.svg"
            render_waveform_svg(damaged, result.audio, result.intervals, svg_path)
            svg = svg_path.read_text(encoding="utf-8")
        for index in range(1, 4):
            self.assertIn(f"#{index}", svg)
        self.assertIn("MODIFIED INTERVALS", svg)


if __name__ == "__main__":
    unittest.main()
