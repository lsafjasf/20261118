"""Generate a 10-minute mono test track with programmed dynamic-range changes.

The signal is fully synthesized (deterministic via a fixed RNG seed) so the
analysis results can be checked against known ground truth:

  * true digital silence (exact zero) regions,
  * sustained very-low-level regions,
  * steady program at several calibrated RMS levels,
  * abrupt "sudden loud" bursts with steep onset,
  * a slow dynamic fade,
  * a single full-scale 0.0 dBFS blip whose timestamp is known.

Outputs:
  artifacts/test_track.wav        24 kHz mono PCM_16, 600 s
  artifacts/ground_truth.json     programmed segment table + event timestamps
"""

from __future__ import annotations

import json
import os

import numpy as np
import soundfile as sf

SR = 24000
DURATION = 600.0
OUT_WAV = os.path.join("artifacts", "test_track.wav")
OUT_JSON = os.path.join("artifacts", "ground_truth.json")

# Programmed segments: (start_s, end_s, rms_dbfs, kind, description)
# rms_dbfs is the target broadband RMS level of the noise/music bed.
# Level ladder is chosen so the three conditions are unambiguously separable:
#   program ~ -20 dBFS RMS  | low-level beds -45 dBFS (audible, above silence)
#   bursts ~ -8/-6 dBFS     | true silence = exact zero | silence gate -60 dBFS.
SEGMENTS = [
    (0.0,   30.0,  -20.0, "program",  "normal program bed"),
    (30.0,  60.0,  -20.0, "program",  "normal program bed"),
    (60.0,  75.0,  -45.0, "low",      "sustained low-level bed"),
    (75.0,  90.0,  -20.0, "program",  "normal program bed"),
    (90.0,  110.0, -45.0, "low",      "sustained low-level bed"),
    (110.0, 150.0, -20.0, "program",  "normal program bed"),
    (150.0, 154.0, -8.0,  "burst",    "abrupt sudden-loud burst"),
    (154.0, 200.0, -20.0, "program",  "normal program bed"),
    (200.0, 220.0, -26.0, "program",  "slightly quieter program"),
    (220.0, 250.0, -20.0, "program",  "normal program bed"),
    (250.0, 280.0, -20.0, "program",  "bed containing 0 dBFS blip"),
    (280.0, 300.0, -45.0, "low",      "sustained low-level bed"),
    (300.0, 340.0, -20.0, "program",  "normal program bed"),
    (340.0, 380.0, -24.0, "fade",     "slow dynamic fade -18 -> -34 dBFS"),
    (380.0, 400.0, -20.0, "program",  "normal program bed"),
    (400.0, 403.0, -6.0,  "burst",    "loudest sudden-loud burst"),
    (403.0, 440.0, -20.0, "program",  "normal program bed"),
    (440.0, 460.0, -45.0, "low",      "sustained low-level bed"),
    (460.0, 500.0, -20.0, "program",  "normal program bed"),
    (500.0, 520.0, -20.0, "silence",  "true digital silence"),
    (520.0, 560.0, -20.0, "program",  "normal program bed"),
    (560.0, 580.0, -20.0, "silence",  "true digital silence"),
    (580.0, 600.0, -20.0, "program",  "normal program bed"),
]

# A single full-scale sample event embedded in an otherwise -20 dBFS bed.
BLIP_TIME_S = 250.0

# Crossfade applied at every segment boundary to avoid zipper clicks (seconds).
XFADE_S = 0.01

# Program (everything except the blip) is scaled to this peak before inserting
# the full-scale blip, guaranteeing the blip is the unique 0.0 dBFS event.
HEADROOM_PEAK_DBFS = -3.0


def _program_bed(n: int, rng: np.random.Generator) -> np.ndarray:
    """Band-limited, slightly colored noise that resembles a program/music bed."""
    white = rng.standard_normal(n)
    # One-pole low-pass for a softer spectrum, plus a gentle tonal component.
    alpha = 0.35
    low = np.empty(n, dtype=np.float64)
    acc = 0.0
    for i in range(n):
        acc += alpha * (white[i] - acc)
        low[i] = acc
    t = np.arange(n) / SR
    tonal = 0.25 * np.sin(2 * np.pi * 220.0 * t) + 0.15 * np.sin(2 * np.pi * 330.0 * t)
    bed = 0.8 * low + tonal
    return bed


def _normalize_to_rms(x: np.ndarray, target_dbfs: float) -> np.ndarray:
    """Scale a segment so its measured RMS equals the target dBFS level."""
    rms = float(np.sqrt(np.mean(x * x))) + 1e-12
    target_amp = 10.0 ** (target_dbfs / 20.0)
    return x * (target_amp / rms)


def main() -> None:
    os.makedirs("artifacts", exist_ok=True)
    rng = np.random.default_rng(20261118)
    total = int(round(DURATION * SR))
    audio = np.zeros(total, dtype=np.float64)

    ground_segments = []
    for start, end, target_db, kind, desc in SEGMENTS:
        i0, i1 = int(round(start * SR)), int(round(end * SR))
        n = i1 - i0
        if kind == "silence":
            seg = np.zeros(n, dtype=np.float64)
        elif kind == "fade":
            seg = _program_bed(n, rng)
            # Linear-in-dB fade from -18 dBFS to -34 dBFS.
            db_env = np.linspace(-18.0, -34.0, n)
            seg = _normalize_to_rms(seg, 0.0) * (10.0 ** (db_env / 20.0))
        else:
            seg = _program_bed(n, rng)
            seg = _normalize_to_rms(seg, target_db)

        # Short equal-power crossfade with whatever is already in the buffer.
        x = int(XFADE_S * SR)
        if i0 > 0 and x > 0:
            k = min(x, n)
            ramp = np.linspace(0.0, 1.0, k)
            seg[:k] = ramp * seg[:k] + (1.0 - ramp) * audio[i0:i0 + k]
        audio[i0:i1] = seg

        ground_segments.append(
            {
                "start_s": start,
                "end_s": end,
                "target_rms_dbfs": target_db,
                "kind": kind,
                "description": desc,
            }
        )

    # Reserve headroom on the whole program so nothing clips before the blip.
    headroom_gain = 10.0 ** (HEADROOM_PEAK_DBFS / 20.0) / float(np.max(np.abs(audio)))
    audio *= headroom_gain

    # Embed the known full-scale blip (single positive full-scale sample).
    blip_idx = int(round(BLIP_TIME_S * SR))
    audio[blip_idx] = 1.0

    # Safety clamp then write 16-bit PCM.
    audio = np.clip(audio, -1.0, 1.0)
    pcm16 = np.round(audio * 32767.0).astype(np.int16)
    sf.write(OUT_WAV, pcm16, SR, subtype="PCM_16")

    program_peak_dbfs = 20.0 * np.log10(float(np.max(np.abs(audio[np.arange(len(audio)) != blip_idx]))))
    ground_truth = {
        "sample_rate": SR,
        "duration_s": DURATION,
        "channels": 1,
        "blip_time_s": BLIP_TIME_S,
        "blip_index": blip_idx,
        "headroom_peak_dbfs": HEADROOM_PEAK_DBFS,
        "program_peak_dbfs_excluding_blip": round(float(program_peak_dbfs), 3),
        "expected": {
            "global_peak_dbfs": 0.0,
            "global_peak_time_s": BLIP_TIME_S,
            "highest_loudness_window_s": [400.0, 403.0],
            "sudden_loud_burst_s": [[150.0, 154.0], [400.0, 403.0]],
            "sustained_low_s": [[60.0, 75.0], [90.0, 110.0], [280.0, 300.0], [440.0, 460.0]],
            "silence_s": [[500.0, 520.0], [560.0, 580.0]],
            "silence_total_s": 40.0,
        },
        "segments": ground_segments,
        "notes": (
            "Levels are target broadband RMS dBFS. The 0 dBFS blip is a single "
            "full-scale sample. 'silence' segments contain exact zero samples."
        ),
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(ground_truth, fh, indent=2)

    print(f"wrote {OUT_WAV} ({len(pcm16) / SR:.1f} s, {SR} Hz mono PCM16)")
    print(f"wrote {OUT_JSON} with {len(ground_segments)} programmed segments")
    print(f"full-scale blip at t={BLIP_TIME_S:.3f} s (sample {blip_idx})")


if __name__ == "__main__":
    main()
