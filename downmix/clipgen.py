"""Synthetic 5.1 test material: directional pans, dialogue, LFE, phase traps.

The generated clip is deterministic and covers every fold-down failure mode
the toolkit is expected to diagnose, so validation never relies on taking
just the L/R channels.
"""

from __future__ import annotations

import math

from .engine import CHANNELS

SAMPLE_RATE = 48000


def _tone(sample_rate: int, frequency: float, duration: float,
          amplitude: float = 0.5, phase: float = 0.0):
    count = int(round(sample_rate * duration))
    step = 2.0 * math.pi * frequency / sample_rate
    return [amplitude * math.sin(step * i + phase) for i in range(count)]


def _dialogue(sample_rate: int, duration: float, amplitude: float = 0.6):
    """Speech-like signal: a carrier shaped by a slow amplitude envelope."""
    count = int(round(sample_rate * duration))
    out = [0.0] * count
    for i in range(count):
        t = i / sample_rate
        envelope = 0.5 + 0.5 * math.sin(2.0 * math.pi * 3.5 * t)
        voice = (
            math.sin(2.0 * math.pi * 300.0 * t)
            + 0.5 * math.sin(2.0 * math.pi * 620.0 * t)
            + 0.25 * math.sin(2.0 * math.pi * 950.0 * t)
        ) / 1.75
        out[i] = amplitude * envelope * voice
    return out


def _apply_fade(values, sample_rate: int, fade: float = 0.01):
    n = int(sample_rate * fade)
    for i in range(min(n, len(values))):
        gain = i / n
        values[i] *= gain
        values[-1 - i] *= gain
    return values


def _empty_frames(frame_count: int):
    return [[0.0] * 6 for _ in range(frame_count)]


def _pan_pair(frame, length, start_ch, end_ch):
    """Equal-power pan position between two channel indices for one frame."""
    position = frame / max(1, length - 1)
    angle = position * (math.pi / 2.0)
    return (
        (start_ch, math.cos(angle)),
        (end_ch, math.sin(angle)),
    )


def build_test_clip(sample_rate: int = SAMPLE_RATE):
    """Return ``(frames, sample_rate, segment_table)``.

    Segments:
      1. directional movement - tone pans L -> R -> C -> Ls -> Rs
      2. dialogue              - centre-channel speech-like signal
      3. LFE                   - 60 Hz content in the LFE channel only
      4. surround phase trap   - Ls/Rs exact opposites (must cancel)
    """
    frames = []
    table = []

    # Segment 1: directional movement across the five main channels.
    pan_duration = 0.8
    leg_count = int(round(sample_rate * pan_duration))
    route = [0, 1, 2, 4, 5]  # L, R, C, Ls, Rs
    for leg in range(len(route) - 1):
        tone = _apply_fade(
            _tone(sample_rate, 440.0, pan_duration, 0.45), sample_rate
        )
        for f in range(leg_count):
            (a, ga), (b, gb) = _pan_pair(f, leg_count, route[leg], route[leg + 1])
            row = [0.0] * 6
            row[a] = tone[f] * ga
            row[b] = tone[f] * gb
            frames.append(row)
    table.append(("directional_movement", len(frames)))

    # Segment 2: dialogue, centre only.
    dialogue = _dialogue(sample_rate, 1.5)
    start = len(frames)
    for sample in dialogue:
        frames.append([0.0, 0.0, sample, 0.0, 0.0, 0.0])
    table.append(("dialogue", len(frames) - start))

    # Segment 3: LFE only, 60 Hz.
    lfe = _apply_fade(_tone(sample_rate, 60.0, 1.0, 0.8), sample_rate)
    start = len(frames)
    for sample in lfe:
        frames.append([0.0, 0.0, 0.0, sample, 0.0, 0.0])
    table.append(("lfe", len(frames) - start))

    # Segment 4: surround phase trap, Ls = -Rs at 220 Hz.
    trap = _apply_fade(_tone(sample_rate, 220.0, 1.0, 0.5), sample_rate)
    start = len(frames)
    for sample in trap:
        frames.append([0.0, 0.0, 0.0, 0.0, sample, -sample])
    table.append(("surround_phase_trap", len(frames) - start))

    return frames, sample_rate, table


def flatten(frames):
    flat = [0.0] * (len(frames) * 6)
    for i, row in enumerate(frames):
        base = i * 6
        for ch, value in enumerate(row):
            flat[base + ch] = value
    return flat


def segment_slices(table):
    """Map each segment name to a (start, end) frame range."""
    slices = {}
    cursor = 0
    for name, length in table:
        slices[name] = (cursor, cursor + length)
        cursor += length
    return slices


def write_test_clip(path: str, sample_rate: int = SAMPLE_RATE):
    from .wavio import write_wav

    frames, rate, table = build_test_clip(sample_rate)
    flat = flatten(frames)
    write_wav(path, flat, rate, 6, subtype="float32")
    return path, table


def channel_names():
    return CHANNELS
