"""场（field）提取与重组。

约定：
- 帧高 H 为偶数。顶场（top field）取偶数行 0,2,4,...，底场（bottom field）
  取奇数行 1,3,5,...。
- TFF（top-field-first）时间顺序为 [top(t0), bottom(t0), top(t1), ...]。
- BFF（bottom-field-first）时间顺序为 [bottom(t0), top(t0), ...]。
"""

import numpy as np

TOP = "top"
BOTTOM = "bottom"


def split_fields(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """把一帧隔行图像拆成顶场、底场（高度减半）。"""
    top = frame[0::2, :, :].copy()
    bottom = frame[1::2, :, :].copy()
    return top, bottom


def weave_fields(top: np.ndarray, bottom: np.ndarray) -> np.ndarray:
    """把顶场放回偶数行、底场放回奇数行，融合成一帧。"""
    h = top.shape[0]
    out = np.empty((2 * h, top.shape[1], top.shape[2]), dtype=top.dtype)
    out[0::2, :, :] = top
    out[1::2, :, :] = bottom
    return out


def bob_upsample(field: np.ndarray, parity: str) -> np.ndarray:
    """行复制把单场放大回整帧高度，parity 决定该场占据的行位置。"""
    h, w, c = field.shape
    full = np.empty((2 * h, w, c), dtype=field.dtype)
    if parity == TOP:
        full[0::2, :, :] = field
        full[1::2, :, :] = field
    else:
        full[0::2, :, :] = field
        full[1::2, :, :] = field
    return full


def chronological_fields(
    frames: list[np.ndarray], order: str
) -> list[tuple[str, np.ndarray]]:
    """把连续帧拆成按时间排序的 (parity, field) 序列。"""
    seq: list[tuple[str, np.ndarray]] = []
    for frame in frames:
        top, bottom = split_fields(frame)
        if order == "tff":
            seq.extend(((TOP, top), (BOTTOM, bottom)))
        elif order == "bff":
            seq.extend(((BOTTOM, bottom), (TOP, top)))
        else:
            raise ValueError(f"未知场序: {order}（应为 tff 或 bff）")
    return seq
