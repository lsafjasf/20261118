"""Compare analysis output against synthesized ground truth and emit report."""

import argparse
import json
import os

import numpy as np


def nearest_error(detected, truth):
    detected = np.asarray(detected)
    truth = np.asarray(truth)
    dist = np.abs(detected[:, None] - truth[None, :])
    matched = dist.min(axis=1)
    return matched


def evaluate(analysis_path, truth_path):
    with open(analysis_path) as f:
        a = json.load(f)
    with open(truth_path) as f:
        t = json.load(f)
    truth = np.array(t["ground_truth_beats"])
    grid_times = np.array([g["time"] for g in a["grid"]])
    span = (truth.min(), truth.max())
    grid_times = grid_times[(grid_times >= span[0] - 0.05) & (grid_times <= span[1] + 0.05)]
    matched = nearest_error(grid_times, truth)
    bpm = np.array(a["bpm_curve"])[:, 1]
    return {
        "scene": a["mode"],
        "confidence": a["confidence"],
        "mean_grid_error_ms": a["mean_grid_error_ms"],
        "median_grid_error_ms": a["median_grid_error_ms"],
        "truth_vs_grid_ms": {
            "mean": round(float(matched.mean()) * 1000, 2),
            "median": round(float(np.median(matched)) * 1000, 2),
            "p95": round(float(np.percentile(matched, 95)) * 1000, 2),
            "max": round(float(matched.max()) * 1000, 2),
        },
        "grid_points": len(a["grid"]),
        "bpm_curve": {
            "points": len(a["bpm_curve"]),
            "start_bpm": round(float(bpm[0]), 2),
            "end_bpm": round(float(bpm[-1]), 2),
            "min_bpm": round(float(bpm.min()), 2),
            "max_bpm": round(float(bpm.max()), 2),
        },
        "diagnostics": a["diagnostics"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--audio-dir", default=os.path.join(os.path.dirname(__file__), "..", "audio"))
    args = ap.parse_args()
    rows = []
    for name in ("constant", "accelerando", "free"):
        rows.append(evaluate(
            os.path.join(args.data_dir, f"{name}.analysis.json"),
            os.path.join(args.audio_dir, f"{name}.truth.json"),
        ))
    out = os.path.join(args.data_dir, "evaluation.json")
    with open(out, "w") as f:
        json.dump(rows, f, indent=2)
    for r in rows:
        print(
            f"{r['scene']:10s} conf={r['confidence']:.3f} "
            f"gridMAE={r['mean_grid_error_ms']:6.2f}ms "
            f"truthMAE={r['truth_vs_grid_ms']['mean']:6.2f}ms "
            f"bpm {r['bpm_curve']['start_bpm']}->{r['bpm_curve']['end_bpm']}"
        )
    print("written", out)


if __name__ == "__main__":
    main()
