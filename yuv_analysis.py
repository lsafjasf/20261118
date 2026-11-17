"""Histogram, range-violation counts and per-step texture summaries."""
from __future__ import annotations

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# legal luma/chroma code limits per (range, bitdepth)
LEGAL = {
    ("limited", 8): {"y": (16, 235), "c": (16, 240)},
    ("full", 8): {"y": (0, 255), "c": (0, 255)},
    ("limited", 10): {"y": (64, 940), "c": (64, 960)},
    ("full", 10): {"y": (0, 1023), "c": (0, 1023)},
}

CHANNELS = ("Y", "U", "V")


def plane_stats(plane: np.ndarray) -> dict:
    p = plane.astype(np.float64)
    return {
        "min": float(p.min()),
        "max": float(p.max()),
        "mean": float(p.mean()),
        "std": float(p.std()),
    }


def range_violations(y, u, v, video_range: str, bitdepth: int) -> dict:
    """Count super-black / super-white luma and out-of-range chroma pixels."""
    lim = LEGAL[(video_range, bitdepth)]
    ylo, yhi = lim["y"]
    clo, chi = lim["c"]
    return {
        "super_black_y": int((y < ylo).sum()),
        "super_white_y": int((y > yhi).sum()),
        "chroma_below_min": int(((u < clo) | (v < clo)).sum()),
        "chroma_above_max": int(((u > chi) | (v > chi)).sum()),
    }


def save_histogram(planes, bitdepth: int, title: str, path: str) -> None:
    """Save a 3-panel (Y/U/V) histogram figure."""
    maxval = (1 << bitdepth) - 1
    bins = 256 if bitdepth == 8 else 512
    fig, axes = plt.subplots(1, 3, figsize=(15, 4))
    for ax, plane, name in zip(axes, planes, CHANNELS):
        ax.hist(plane.ravel(), bins=bins, range=(0, maxval + 1),
                color="0.3", linewidth=0)
        ax.set_title(name)
        ax.set_xlim(0, maxval + 1)
        ax.set_yscale("log")
        ax.set_ylabel("count (log)")
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def texture_summary(name: str, planes, video_range: str, bitdepth: int,
                    matrix: str, extra: dict | None = None) -> dict:
    """Build the per-step texture summary dict."""
    summary = {
        "step": name,
        "matrix": matrix,
        "range": video_range,
        "bitdepth": bitdepth,
        "shape": list(planes[0].shape),
        "channels": {c: plane_stats(p) for c, p in zip(CHANNELS, planes)},
        "violations": range_violations(*planes, video_range, bitdepth),
    }
    if extra:
        summary["extra"] = extra
    return summary


def save_summary(summary: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, ensure_ascii=False)
