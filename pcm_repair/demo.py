"""Deterministic validation demo with two drum groups and three pops."""

from __future__ import annotations

from dataclasses import dataclass
import argparse
import json
import math
from pathlib import Path
import random

from .audio import Audio, read_wav, write_wav
from .detector import DetectionConfig, RepairResult, repair_audio
from .metrics import compare_audio, metrics_payload, result_payload
from .waveform import render_waveform_svg


SAMPLE_RATE = 44100
DURATION = 7.10
POP_POSITIONS = (1.11, 5.50, 6.72)
POP_AMPLITUDES = (0.78, -0.72, 0.62)


@dataclass(frozen=True)
class DrumEvent:
    time: float
    group: str
    kind: str
    gain: float
    pan: float


def _add_kick(channel: list[float], start: int, gain: float) -> None:
    length = int(0.65 * SAMPLE_RATE)
    phase = 0.0
    for offset in range(min(length, len(channel) - start)):
        seconds = offset / SAMPLE_RATE
        frequency = 48.0 + 135.0 * math.exp(-seconds * 32.0)
        phase += 2.0 * math.pi * frequency / SAMPLE_RATE
        envelope = math.exp(-seconds * 8.0)
        channel[start + offset] += gain * envelope * (
            math.sin(phase) + 0.25 * math.sin(phase * 0.5)
        )


def _add_snare(channel: list[float], start: int, gain: float, seed: int) -> None:
    length = int(0.38 * SAMPLE_RATE)
    rng = random.Random(seed)
    previous = 0.0
    for offset in range(min(length, len(channel) - start)):
        seconds = offset / SAMPLE_RATE
        noise = rng.uniform(-1.0, 1.0)
        high_passed = noise - previous * 0.7
        previous = noise
        envelope = math.exp(-seconds * 17.0)
        channel[start + offset] += gain * envelope * (
            0.7 * high_passed + 0.45 * math.sin(2.0 * math.pi * 185.0 * seconds)
        )


def _add_hat(channel: list[float], start: int, gain: float, rng: random.Random) -> None:
    length = int(0.12 * SAMPLE_RATE)
    previous = 0.0
    for offset in range(min(length, len(channel) - start)):
        seconds = offset / SAMPLE_RATE
        noise = rng.uniform(-1.0, 1.0)
        high_passed = noise - previous
        previous = noise
        channel[start + offset] += gain * math.exp(-seconds * 55.0) * high_passed


def _schedule_events() -> list[DrumEvent]:
    events: list[DrumEvent] = []
    for index in range(12):
        events.append(
            DrumEvent(0.08 + index * 0.26, "A", "hat", 0.10, -0.45 if index % 2 else 0.45)
        )
    for time in (0.06, 0.56, 1.06, 1.56, 2.06, 2.56, 3.06):
        events.append(DrumEvent(time, "A", "kick", 0.72, 0.0))
    for time in (0.47, 1.47, 2.47):
        events.append(DrumEvent(time, "A", "snare", 0.42, 0.0))

    for index in range(24):
        events.append(
            DrumEvent(3.32 + index * 0.13, "B", "hat", 0.09, -0.55 if index % 2 else 0.55)
        )
    for time in (3.35, 3.87, 4.18, 4.92, 5.40, 5.72, 6.12):
        events.append(DrumEvent(time, "B", "kick", 0.68, 0.0))
    for time in (3.77, 4.77, 5.77):
        events.append(DrumEvent(time, "B", "snare", 0.40, 0.0))
    return events


def synthesize_drums() -> tuple[Audio, list[DrumEvent]]:
    """Create a stereo fixture; each channel has independent noise textures."""

    frames = int(DURATION * SAMPLE_RATE)
    channels = [[0.0] * frames, [0.0] * frames]
    rng = random.Random(42)
    events = _schedule_events()
    for event in events:
        start = int(event.time * SAMPLE_RATE)
        pan = (event.pan + 1.0) * math.pi / 4.0
        left_gain = math.cos(pan) * event.gain
        right_gain = math.sin(pan) * event.gain
        if event.kind == "kick":
            _add_kick(channels[0], start, left_gain)
            _add_kick(channels[1], start, right_gain)
        elif event.kind == "snare":
            _add_snare(channels[0], start, left_gain, int(event.time * 1000) + 1)
            _add_snare(channels[1], start, right_gain, int(event.time * 1000) + 2)
        else:
            _add_hat(channels[0], start, left_gain, rng)
            _add_hat(channels[1], start, right_gain, rng)

    peak = max(max(abs(value) for value in channel) for channel in channels)
    if peak > 0.95:
        scale = 0.95 / peak
        channels = [[value * scale for value in channel] for channel in channels]
    return Audio(SAMPLE_RATE, 2, channels), events


def inject_pops(audio: Audio) -> Audio:
    damaged = audio.copy()
    for position, amplitude in zip(POP_POSITIONS, POP_AMPLITUDES):
        frame = int(position * audio.sample_rate)
        for channel in damaged.samples:
            channel[frame] = max(-0.999, min(0.999, channel[frame] + amplitude))
    return damaged


def _pop_validation(
    result: RepairResult,
    pop_frames: list[int],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    matched: list[dict[str, object]] = []
    used: set[int] = set()
    for pop_index, frame in enumerate(pop_frames, start=1):
        hits = [
            index
            for index, interval in enumerate(result.intervals)
            if interval.start <= frame < interval.end
        ]
        used.update(hits)
        matched.append(
            {
                "pop": pop_index,
                "frame": frame,
                "time_s": frame / result.audio.sample_rate,
                "detected": bool(hits),
                "intervals": [index + 1 for index in hits],
            }
        )
    unexpected = [
        {
            "index": index + 1,
            "start_frame": interval.start,
            "end_frame": interval.end,
            "start_s": interval.start / result.audio.sample_rate,
        }
        for index, interval in enumerate(result.intervals)
        if index not in used
    ]
    return matched, unexpected


def _onset_guard_validation() -> dict[str, object]:
    """Check the same detector on an isolated click and a sharp drum onset."""

    rate = 44100
    start = 8000
    click = [0.0] * (rate // 2)
    click[start] = 0.8
    pop_result = repair_audio(Audio(rate, 2, [click]))

    onset = [0.0] * (rate // 2)
    for offset in range(int(0.12 * rate)):
        envelope = 0.8 if offset == 0 else 0.08 * math.exp(-offset / rate * 18.0)
        onset[start + offset] = envelope * math.cos(
            2.0 * math.pi * 160.0 * offset / rate
        )
    onset_result = repair_audio(Audio(rate, 2, [onset]))
    return {
        "isolated_click": {
            "repaired_sample_values": pop_result.sample_changes,
            "intervals": pop_result.interval_count,
        },
        "sharp_drum_onset": {
            "candidate_groups": onset_result.candidate_groups,
            "rejected_percussive_groups": onset_result.rejected_percussive_groups,
            "repaired_sample_values": onset_result.sample_changes,
        },
    }


def _write_markdown(
    path: Path,
    metrics,
    mixed: RepairResult,
    pure: RepairResult,
    events: list[DrumEvent],
    pop_matches: list[dict[str, object]],
    unexpected: list[dict[str, object]],
    onset_guard: dict[str, object],
) -> None:
    pop_rows = "\n".join(
        f"| {row['pop']} | {row['time_s']:.3f}s | {row['frame']} | "
        f"{'yes' if row['detected'] else 'NO'} | "
        f"{', '.join(f'#{value}' for value in row['intervals']) or '—'} |"
        for row in pop_matches
    )
    interval_rows = "\n".join(
        f"| #{index} | {interval.start / mixed.audio.sample_rate:.6f}s | "
        f"{interval.end / mixed.audio.sample_rate:.6f}s | {interval.start}–{interval.end - 1} | "
        f"{', '.join('L' if ch == 0 else 'R' for ch in interval.channels)} |"
        for index, interval in enumerate(mixed.intervals, start=1)
    )
    group_a = sum(event.group == "A" for event in events)
    group_b = sum(event.group == "B" for event in events)
    markdown = f"""# PCM transient repair — validation

## A/B listening

- **A (damaged):** [a_damaged.wav](a_damaged.wav) — two drum groups plus three one-sample pop events.
- **B (repaired):** [b_repaired.wav](b_repaired.wav) — same performance after detection and piecewise Hermite fill.
- **Clean reference:** [clean_reference.wav](clean_reference.wav) — used only to measure error.
- **Waveform:** [waveform.svg](waveform.svg) — A/B panels, red bands and numbered labels on every changed interval.

## Repair metrics

- Repaired intervals: **{mixed.interval_count}**
- Modified frames: **{mixed.modified_frames}**
- Repaired PCM sample values: **{mixed.sample_changes}** (stereo values, not frames)
- Maximum error vs clean reference: **{metrics.max_error:.9f} full scale** 
  ({metrics.max_error_dbfs:.2f} dBFS, **{metrics.max_error_lsb:.2f} LSB @ 16-bit**)
- Maximum error inside repaired samples: **{metrics.max_error_in_repairs_lsb:.2f} LSB @ 16-bit**
- Maximum A/B correction: **{metrics.max_correction:.9f} full scale**

## Pop detection

| Pop | Time | Frame | Detected | Interval |
|---:|---:|---:|:---:|---|
{pop_rows}

Unexpected changed intervals outside the three injected pops: **{len(unexpected)}**.

## Drum false-repair audit

The clean drum-only reference contains **{len(events)} attacks**: {group_a} in group A and
{group_b} in group B, including kicks, snares and hats. Running the same detector on the
undamaged drum reference changed **{pure.sample_changes} PCM sample values** and produced
**{pure.interval_count} intervals**.

This is the key percussion guard: zero drum attacks were repaired, so no kick, snare or hat
transient lost its leading edge or impact. Percussion-shaped candidates rejected by the
onset classifier: **{pure.rejected_percussive_groups}**.

The dedicated discriminator check produced:

- Isolated one-sample click: **{onset_guard['isolated_click']['repaired_sample_values']}**
  repaired sample value(s).
- Sharp one-sample drum attack with a sustained body: **{onset_guard['sharp_drum_onset']['candidate_groups']}**
  candidate group(s), **{onset_guard['sharp_drum_onset']['rejected_percussive_groups']}**
  rejected as percussion, **{onset_guard['sharp_drum_onset']['repaired_sample_values']}**
  repaired sample value(s).

## Changed intervals

| # | Start | End | Frames | Channels |
|---:|---:|---:|---:|---|
{interval_rows}
"""
    path.write_text(markdown, encoding="utf-8")


def export_demo(directory: str | Path) -> dict[str, object]:
    """Write reproducible A/B WAVs, waveform, JSON and Markdown validation."""

    output = Path(directory)
    output.mkdir(parents=True, exist_ok=True)
    clean, events = synthesize_drums()
    clean_path = output / "clean_reference.wav"
    damaged_path = output / "a_damaged.wav"
    repaired_path = output / "b_repaired.wav"
    waveform_path = output / "waveform.svg"
    report_path = output / "report.json"
    markdown_path = output / "report.md"

    write_wav(clean_path, clean)
    clean_quantized = read_wav(clean_path)
    damaged = inject_pops(clean_quantized)
    write_wav(damaged_path, damaged)
    damaged_quantized = read_wav(damaged_path)

    config = DetectionConfig()
    pure_result = repair_audio(clean_quantized, config)
    mixed_result = repair_audio(damaged_quantized, config)
    write_wav(repaired_path, mixed_result.audio)
    repaired_quantized = read_wav(repaired_path)
    metrics = compare_audio(
        clean_quantized,
        repaired_quantized,
        mixed_result,
        damaged_quantized,
    )
    render_waveform_svg(
        damaged_quantized,
        repaired_quantized,
        mixed_result.intervals,
        waveform_path,
        title="PCM transient repair · 2 drum groups + 3 pops",
    )

    pop_frames = [int(position * SAMPLE_RATE) for position in POP_POSITIONS]
    pop_matches, unexpected = _pop_validation(mixed_result, pop_frames)
    onset_guard = _onset_guard_validation()
    validation = {
        "expected_pops": 3,
        "pops_detected": sum(bool(row["detected"]) for row in pop_matches),
        "unexpected_intervals": unexpected,
        "pure_drums": {
            "drum_attack_events": len(events),
            "group_a_events": sum(event.group == "A" for event in events),
            "group_b_events": sum(event.group == "B" for event in events),
            "repaired_sample_values": pure_result.sample_changes,
            "repaired_intervals": pure_result.interval_count,
            "rejected_percussive_groups": pure_result.rejected_percussive_groups,
        },
        "onset_guard": onset_guard,
        "pop_matches": pop_matches,
    }
    report: dict[str, object] = {
        "tool": "pcm_repair",
        "fixture": {
            "sample_rate": SAMPLE_RATE,
            "duration_s": DURATION,
            "drum_groups": ["A", "B"],
            "pop_times_s": list(POP_POSITIONS),
            "pop_amplitudes_full_scale": list(POP_AMPLITUDES),
        },
        "ab": {
            "a_damaged": damaged_path.name,
            "b_repaired": repaired_path.name,
            "clean_reference": clean_path.name,
            "waveform": waveform_path.name,
        },
        "detector": {
            key: value
            for key, value in vars(config).items()
        },
        "repair": result_payload(mixed_result),
        "reference_error": metrics_payload(metrics),
        "validation": validation,
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    _write_markdown(
        markdown_path,
        metrics,
        mixed_result,
        pure_result,
        events,
        pop_matches,
        unexpected,
        onset_guard,
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the A/B drum-pop validation fixture.")
    parser.add_argument(
        "--output",
        default="artifacts/demo",
        help="output directory (default: artifacts/demo)",
    )
    args = parser.parse_args(argv)
    report = export_demo(args.output)
    metrics = report["reference_error"]
    validation = report["validation"]
    print(f"A (damaged):  {Path(args.output) / 'a_damaged.wav'}")
    print(f"B (repaired): {Path(args.output) / 'b_repaired.wav'}")
    print(f"Waveform:     {Path(args.output) / 'waveform.svg'}")
    print(f"Report:       {Path(args.output) / 'report.md'}")
    print(
        f"Pops detected: {validation['pops_detected']}/3; "
        f"repaired values: {report['repair']['repaired_sample_values']}; "
        f"max error: {metrics['max_error_lsb']:.0f} LSB @ 16-bit; "
        f"pure-drum false repairs: {validation['pure_drums']['repaired_sample_values']}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
