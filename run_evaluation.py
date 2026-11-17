"""End-to-end seam evaluation on the three synthetic materials."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf
from scipy import signal

from loopseam.analyze import SeamAnalyzer, onset_envelope
from loopseam.repair import (
    max_adjacent_jump,
    repair_file,
    wrap_metrics,
    write_looped_preview,
)


MATERIALS = ("seamless", "missing_beat", "extra_quarter")


def find_recommendation(an: SeamAnalyzer) -> dict:
    """Two-stage search: quarter-beat grid, then sample-exact refinement.

    Sample-exact refinement always runs near the best grid point. A
    crossfade is only required when the best achievable boundary jump still
    exceeds the click threshold (a structurally damaged phrase such as a
    dropped beat, where no clean seam position exists).
    """
    grid, beat, bpm = an.best_beat_aligned()
    peak_threshold = 0.15
    fine = an.refine_around(grid.seam_sample)
    crossfade_required = bool(fine.sample_diff_peak > peak_threshold)
    return {
        "estimated_bpm": bpm,
        "beat_samples": beat,
        "grid_best": grid.to_dict(),
        "sample_best": fine.to_dict(),
        "peak_threshold": peak_threshold,
        "crossfade_required": crossfade_required,
    }


def plot_diagnosis(name: str, x: np.ndarray, sr: int, an: SeamAnalyzer,
                   seam: int, out_path: Path, context: int) -> None:
    lo = max(0, seam - context)
    hi = min(x.size, seam + context)
    t = np.arange(lo, hi)
    fig, axes = plt.subplots(3, 1, figsize=(11, 9), constrained_layout=True)

    axes[0].plot(t, x[lo:hi], lw=0.6, color="#3366cc")
    axes[0].axvline(seam, color="#d62728", lw=1.3, label="seam")
    axes[0].axhline(0, color="#d62728", lw=0.7, ls="--", alpha=0.5)
    axes[0].set_title(f"{name}: waveform at seam {seam}")
    axes[0].legend(loc="upper right")

    f, _, z = signal.spectrogram(
        x[lo:hi], fs=sr, nperseg=1024, noverlap=896, mode="magnitude")
    z = 20 * np.log10(z + 1e-8)
    axes[1].imshow(z, origin="lower", aspect="auto", cmap="magma",
                   extent=(lo, hi, f[0], f[-1]))
    axes[1].axvline(seam, color="#d62728", lw=1.3)
    axes[1].axhline(1500, color="#d62728", lw=0.7, ls="--", alpha=0.5)
    axes[1].set_ylim(0, 6000)
    axes[1].set_title("spectrogram with seam crosshair (intersection)")

    env, hop = onset_envelope(x, sr)
    pos = np.arange(env.size) * hop
    axes[2].plot(pos, env, color="#2ca02c", lw=0.8)
    axes[2].axvline(seam, color="#d62728", lw=1.3)
    axes[2].set_xlim(lo, hi)
    axes[2].set_title("onset envelope: transient break at the seam")
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def plot_cost_landscape(name: str, an: SeamAnalyzer, chosen: int,
                        out_path: Path) -> None:
    start = max(an.beat_samples, an.n - 2 * an.beat_samples)
    seams = np.arange(start, an.n + 1, max(1, an.beat_samples // 16))
    costs, peaks = [], []
    for s in seams:
        report = an.evaluate(int(s))
        costs.append(report.combined_cost)
        peaks.append(report.sample_diff_peak)
    fig, ax = plt.subplots(figsize=(11, 4.2), constrained_layout=True)
    offsets_ms = (seams - an.n) / an.sr * 1000.0
    ax.plot(offsets_ms, costs, color="#3366cc", label="combined cost")
    ax.plot(offsets_ms, peaks, color="#d62728", label="boundary jump (x step RMS)")
    ax.axvline((chosen - an.n) / an.sr * 1000.0, color="#2ca02c",
               lw=1.4, label="chosen seam")
    ax.set_xlabel("trim offset relative to current end (ms)")
    ax.set_ylabel("defect metric")
    ax.set_title(f"{name}: seam cost landscape near end")
    ax.legend()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def main() -> None:
    root = Path("artifacts")
    mat_dir = root / "materials"
    truth = json.loads((mat_dir / "ground_truth.json").read_text())
    sr = truth["sr"]
    beat_n = truth["beat_samples"]
    true_n = truth["true_loop_samples"]
    rep_dir = root / "repaired"
    fig_dir = root / "figures"
    rep_dir.mkdir(parents=True, exist_ok=True)
    fig_dir.mkdir(parents=True, exist_ok=True)

    summary = {}
    for name in MATERIALS:
        path = mat_dir / f"{name}.wav"
        x, file_sr = sf.read(path, dtype="float64")
        assert file_sr == sr
        an = SeamAnalyzer(x, sr)
        current = an.evaluate(x.size)
        rec = find_recommendation(an)
        best_seam = rec["sample_best"]["seam_sample"]
        trim_offset = best_seam - x.size

        fade_ms = 20.0 if rec["crossfade_required"] else 0.0
        repair = repair_file(path, rep_dir / f"{name}_repaired.wav",
                             sr, best_seam, fade_ms=fade_ms)
        loop, _ = sf.read(repair["output"], dtype="float64")
        write_looped_preview(loop, sr,
                             rep_dir / f"{name}_preview4x.wav")

        plot_diagnosis(name, x, sr, an, best_seam,
                       fig_dir / f"{name}_diagnosis.png", context=beat_n)
        plot_cost_landscape(name, an, best_seam,
                            fig_dir / f"{name}_cost_landscape.png")

        summary[name] = {
            "input_samples": int(x.size),
            "ground_truth_loop_samples": true_n,
            "current_end_seam": current.to_dict(),
            "recommendation": rec,
            "recommended_seam_sample": int(best_seam),
            "recommended_trim_offset_samples": int(trim_offset),
            "recommended_trim_offset_beats": trim_offset / beat_n,
            "recommended_trim_offset_ms": 1000.0 * trim_offset / sr,
            "repair": repair,
            "validation": {
                "repaired_loop_samples": int(loop.shape[0]),
                "repaired_wrap": wrap_metrics(loop, sr),
                "repaired_max_adjacent_jump": max_adjacent_jump(loop),
            },
        }
    (root / "seam_report.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: {
        "trim_offset_samples": v["recommended_trim_offset_samples"],
        "trim_offset_beats": round(v["recommended_trim_offset_beats"], 4),
        "trim_offset_ms": round(v["recommended_trim_offset_ms"], 3),
        "crossfade_required": v["recommendation"]["crossfade_required"],
        "peak_jump_before": round(
            v["current_end_seam"]["sample_diff_peak"], 2),
        "max_jump_after": round(
            v["validation"]["repaired_max_adjacent_jump"], 4),
    } for k, v in summary.items()}, indent=2))


if __name__ == "__main__":
    main()
