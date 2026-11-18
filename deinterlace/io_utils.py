"""图像序列导出、查看器素材落盘与 JSON 日志。"""

import json
import os

import numpy as np
from PIL import Image


def save_frame(frame: np.ndarray, path: str) -> None:
    Image.fromarray(frame, mode="RGB").save(path)


def export_sequence(
    frames: list[np.ndarray], directory: str, prefix: str, start_index: int = 0
) -> list[str]:
    """把帧序列导出为带零填充序号的 PNG，返回写入的相对路径列表。"""
    os.makedirs(directory, exist_ok=True)
    written: list[str] = []
    width = max(3, len(str(len(frames) + start_index)))
    for offset, frame in enumerate(frames):
        name = f"{prefix}_{offset + start_index:0{width}d}.png"
        path = os.path.join(directory, name)
        save_frame(frame, path)
        written.append(os.path.relpath(path))
    return written


def write_json(payload: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)
