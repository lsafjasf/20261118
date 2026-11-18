"""端到端去隔行评估管线。"""

import os
from dataclasses import asdict

import numpy as np
from PIL import Image

from .fields import chronological_fields
from .generator import generate_progressive, simulate_interlace, SCENES
from .methods import deinterlace_adaptive, deinterlace_bob, deinterlace_weave
from .metrics import (
    combing_error,
    mean_abs_error,
    psnr,
    timed_run,
    vertical_resolution_score,
)
from .selector import choose_strategy
from .io_utils import export_sequence, write_json

METHOD_LABELS = {
    "bob": "简单行复制",
    "weave": "两场融合",
    "adaptive": "运动自适应",
}


def load_interlaced_frames(directory: str) -> list[np.ndarray]:
    """从目录按文件名排序读取 PNG/JPG 帧序列作为隔行输入。"""
    names = sorted(
        name
        for name in os.listdir(directory)
        if name.lower().endswith((".png", ".jpg", ".jpeg"))
    )
    if not names:
        raise FileNotFoundError(f"目录 {directory} 中没有图像帧")
    frames = [np.asarray(Image.open(os.path.join(directory, n)).convert("RGB"))
              for n in names]
    heights = {frame.shape[0] for frame in frames}
    if any(height % 2 for height in heights):
        raise ValueError("输入帧高度必须为偶数才能拆场")
    return frames


def _mean_metric(references, frames, metric_func) -> float:
    values = [metric_func(ref, cand) for ref, cand in zip(references, frames)]
    finite = [value for value in values if np.isfinite(value)]
    return float(np.mean(finite)) if finite else float("inf")


def evaluate_scene(
    scene: str,
    order: str,
    frame_count: int,
    output_root: str,
    source_fps: float = 25.0,
) -> dict:
    progressive = generate_progressive(scene, frame_count + 1)
    interlaced, references = simulate_interlace(progressive, order)
    fields = chronological_fields(interlaced, order)

    (bob_frames, bob_timing) = timed_run("bob", deinterlace_bob, fields)
    (weave_frames, weave_timing) = timed_run("weave", deinterlace_weave, fields)
    adaptive_result, adaptive_timing = timed_run(
        "adaptive", deinterlace_adaptive, fields
    )
    adaptive_frames, adaptive_diags = adaptive_result

    method_frames = {
        "bob": bob_frames,
        "weave": weave_frames,
        "adaptive": adaptive_frames,
    }
    timings = {
        "bob": asdict(bob_timing),
        "weave": asdict(weave_timing),
        "adaptive": asdict(adaptive_timing),
    }

    reference_for_fields = [
        references[min(index // 2, len(references) - 1)]
        for index in range(len(fields))
    ]
    psnr_scores = {
        name: _mean_metric(reference_for_fields, frames, psnr)
        for name, frames in method_frames.items()
    }
    mae_scores = {
        name: _mean_metric(reference_for_fields, frames, mean_abs_error)
        for name, frames in method_frames.items()
    }
    vres_scores = {
        name: float(np.mean([vertical_resolution_score(frame) for frame in frames]))
        for name, frames in method_frames.items()
    }
    combing_scores = {
        name: float(
            np.mean(
                [
                    combing_error(ref, frame)
                    for ref, frame in zip(reference_for_fields, frames)
                ]
            )
        )
        for name, frames in method_frames.items()
    }

    report = choose_strategy(
        scene, order, adaptive_diags, psnr_scores, mae_scores, combing_scores
    )

    scene_dir = os.path.join(output_root, f"{scene}_{order}")
    paths: dict[str, dict] = {}
    paths["input_interlaced"] = {
        "dir": export_sequence(
            interlaced, os.path.join(scene_dir, "input"), "interlaced"
        )
    }
    for name, frames in method_frames.items():
        paths[name] = {
            "dir": export_sequence(
                frames, os.path.join(scene_dir, name), name
            )
        }
    paths["reference"] = {
        "dir": export_sequence(
            references, os.path.join(scene_dir, "reference"), "ref"
        )
    }

    summary = {
        "scene": scene,
        "field_order": order,
        "source_fps": source_fps,
        "output_fps": source_fps * 2,
        "input_interlaced_frames": len(interlaced),
        "field_count": len(fields),
        "output_frames_per_method": len(bob_frames),
        "frame_size": list(interlaced[0].shape),
        "timing": timings,
        "vertical_resolution_score": vres_scores,
        "combing_artifact": combing_scores,
        "selection": report.to_dict(),
        "adaptive_motion_diag": adaptive_diags,
        "exported_sequences": paths,
        "method_labels": METHOD_LABELS,
    }
    write_json(summary, os.path.join(scene_dir, "report.json"))
    return summary


def run_all(
    output_root: str,
    frame_count: int = 16,
    source_fps: float = 25.0,
) -> list[dict]:
    jobs = [
        ("pan", "tff"),
        ("hline", "tff"),
        ("mixed", "tff"),
        ("pan", "bff"),
    ]
    summaries = []
    for scene, order in jobs:
        summaries.append(
            evaluate_scene(
                scene, order, frame_count, output_root, source_fps
            )
        )
    write_json(
        {"scenes": [summary["selection"] for summary in summaries]},
        os.path.join(output_root, "selection_overview.json"),
    )
    return summaries
