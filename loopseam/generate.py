"""Synthetic loop material generator.

The base loop is built so every component is exactly periodic over
``n_beats`` beats: sinusoids use an integer number of cycles per loop and
the noise layer is a fixed periodic buffer. Truncating or extending that
buffer therefore produces perfectly controlled seam defects.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf


def _pluck(t: np.ndarray, start: float, decay: float) -> np.ndarray:
    dt = t - start
    env = np.where(dt >= 0, np.exp(-dt / decay), 0.0)
    return env


def build_loop(sr: int = 44100, bpm: float = 120.0, n_beats: int = 8,
               seed: int = 20261118) -> np.ndarray:
    beat = 60.0 / bpm
    duration = beat * n_beats
    n = int(round(duration * sr))
    t = np.arange(n) / sr
    sig = np.zeros(n)

    # Harmonic pad: every partial completes an integer cycle count in n.
    base = 110.0
    for partial, amp in ((1, 0.32), (2, 0.18), (3, 0.10), (4, 0.06), (6, 0.03)):
        cycles = int(round(base * partial * duration))
        freq = cycles / duration
        sig += amp * np.sin(2 * np.pi * freq * t + partial * 0.7)

    # Slow tremolo, itself periodic over the loop (4 cycles).
    sig *= 0.85 + 0.15 * np.sin(2 * np.pi * (4 / duration) * t)

    # Kick on every beat: pitch-swept sine with fast exponential decay.
    for b in range(n_beats):
        start = b * beat
        dt = t - start
        active = dt >= 0
        kick_freq = 120.0 * np.exp(-dt * 18.0) + 45.0
        phase = 2 * np.pi * np.cumsum(np.where(active, kick_freq, 0.0)) / sr
        sig += 0.55 * np.where(active, np.exp(-dt * 9.0) * np.sin(phase), 0.0)

    # Hi-hat on off-beats using periodic pseudo-noise (same buffer wraps).
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(n)
    noise -= np.mean(noise)
    hat_env = np.zeros(n)
    for b in range(n_beats):
        hat_env += _pluck(t, start=b * beat + beat / 2, decay=0.018)
    sig += 0.10 * hat_env * noise

    # Guarantee envelope silence at both edges so the wrap is click-free.
    edge = max(1, int(0.004 * sr))
    sig[:edge] *= np.linspace(0.0, 1.0, edge) ** 2
    sig[-edge:] *= np.linspace(1.0, 0.0, edge) ** 2

    peak = np.max(np.abs(sig)) or 1.0
    return (sig / peak * 0.89).astype(np.float64)


def write_materials(out_dir: str | Path = "artifacts/materials",
                    sr: int = 44100) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    loop = build_loop(sr=sr)
    beat_n = int(round(60.0 / 120.0 * sr))
    quarter_n = beat_n // 4
    n = loop.shape[0]

    variants = {
        "seamless": loop,
        "missing_beat": loop[: n - beat_n],
        "extra_quarter": np.concatenate([loop, loop[:quarter_n]]),
    }
    meta = {
        "sr": sr,
        "bpm": 120.0,
        "beat_samples": beat_n,
        "quarter_samples": quarter_n,
        "true_loop_samples": n,
        "true_loop_seconds": n / sr,
        "files": {},
    }
    for name, data in variants.items():
        path = out / f"{name}.wav"
        sf.write(path, data.astype(np.float32), sr)
        meta["files"][name] = {
            "path": str(path),
            "samples": int(data.shape[0]),
            "seconds": data.shape[0] / sr,
            "delta_from_true_loop": int(data.shape[0] - n),
        }
    with open(out / "ground_truth.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return meta


if __name__ == "__main__":
    info = write_materials()
    print(json.dumps(info, indent=2))
