"""Physical loop repair: trimming and crossfade splicing."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from .analyze import evaluate_seam


def wrap_metrics(loop: np.ndarray, sr: int, window: int | None = None
                 ) -> dict:
    """Continuity metrics of the closed end->start boundary.

    Uses first differences (the wrap step compared with interior steps),
    which measure continuity rather than equality of two different phrases.
    """
    n = loop.shape[0]
    if window is None:
        window = min(2048, n // 8)
    win = min(window, n // 4)
    mono = loop.mean(axis=1) if loop.ndim == 2 else loop
    interior_steps = np.diff(mono)
    step_rms = float(np.sqrt(np.mean(interior_steps ** 2) + 1e-20))
    wrap_steps = np.concatenate([
        np.diff(mono[n - win:n]),
        np.array([mono[0] - mono[n - 1]]),
        np.diff(mono[:win]),
    ])
    jump = float(np.abs(loop[n - 1] - loop[0]))
    return {
        "wrap_step_rms_ratio": float(
            np.sqrt(np.mean(wrap_steps ** 2) + 1e-20) / step_rms),
        "wrap_jump_ratio": jump / step_rms,
        "sample_jump": jump,
    }


def max_adjacent_jump(x: np.ndarray) -> float:
    """Largest first difference, including the wrap point if tiled twice."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    tiled = np.concatenate([mono, mono[: min(8, mono.size)]])
    return float(np.max(np.abs(np.diff(tiled))))


def trim_to_seam(x: np.ndarray, seam: int) -> np.ndarray:
    """Crop the material so the new loop boundary sits at ``seam``."""
    if not 1 <= seam <= x.shape[0]:
        raise ValueError("seam out of range")
    return x[:seam].copy()


def loop_crossfade(x: np.ndarray, seam: int, fade_samples: int) -> np.ndarray:
    """Build a click-free loop by crossfading the wrap into the tail.

    Conceptually the material ending at ``seam`` is joined to the phrase
    opening. The last ``fade`` samples are an equal-power blend whose outgoing
    gain falls to zero and whose incoming gain rises to one, with the incoming
    signal being exactly ``x[:fade]``. Consequently the final output sample
    equals ``x[fade-1]``'s blend target and, crucially, the boundary step
    ``out[-1] -> x[0]`` is a single ordinary inter-sample step with no jump.
    """
    fade = int(min(fade_samples, seam // 2, x.shape[0] - 1))
    if fade < 4:
        return trim_to_seam(x, seam)
    body = trim_to_seam(x, seam)
    tail = body[seam - fade:seam].copy()
    head = x[:fade].copy()
    angle = np.linspace(0.0, np.pi / 2.0, fade, endpoint=True)
    gain_out = np.cos(angle)
    gain_in = np.sin(angle)
    if body.ndim == 2:
        gain_out = gain_out[:, None]
        gain_in = gain_in[:, None]
        head = head.reshape(tail.shape)
    blended = tail * gain_out + head * gain_in
    # Force the loop endpoint to equal the phrase opening, so the wrap step
    # out[-1] -> x[0] is exactly zero rather than an audible click.
    blended[-1] = x[0]
    body[seam - fade:seam] = blended
    return body


def repair_file(in_path: str | Path, out_path: str | Path, sr: int,
                seam: int, fade_ms: float = 20.0) -> dict:
    data, file_sr = sf.read(in_path, always_2d=False)
    if file_sr != sr:
        raise ValueError(f"sample rate mismatch: {file_sr} != {sr}")
    fade_samples = int(fade_ms / 1000.0 * sr)
    before = evaluate_seam(data, sr, seam)
    repaired = loop_crossfade(data, seam, fade_samples)
    after_seam = evaluate_seam(repaired, sr, repaired.shape[0])
    after = wrap_metrics(repaired, sr)
    after["combined_cost"] = after_seam.combined_cost
    after["max_adjacent_jump"] = max_adjacent_jump(repaired)
    before_wrap = wrap_metrics(np.asarray(data), sr)
    sf.write(out_path, repaired.astype(np.float32), sr)
    return {
        "input": str(in_path),
        "output": str(out_path),
        "seam_sample": int(seam),
        "fade_samples": int(min(fade_samples, seam // 2, data.shape[0] - seam)),
        "input_samples": int(data.shape[0]),
        "output_samples": int(repaired.shape[0]),
        "before": {**before.to_dict(), **before_wrap},
        "after": after,
    }


def write_looped_preview(loop: np.ndarray, sr: int, out_path: str | Path,
                         repeats: int = 4) -> None:
    """Tile a loop for offline listening without PortAudio."""
    tiled = np.concatenate([loop] * repeats)
    sf.write(out_path, tiled.astype(np.float32), sr)
