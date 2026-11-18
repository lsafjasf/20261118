"""三种去隔行策略的具体实现。

所有函数输入为按时间排序的场序列（每项是 (parity, field)），
输出与场等长的整帧列表：每个输入场产生一帧，因此输出帧率是输入帧率的 2 倍。
"""

import numpy as np

from .fields import TOP, weave_fields, bob_upsample


def _neighbors(index: int, length: int) -> tuple[int, int]:
    prev_index = max(0, index - 2)
    next_index = min(length - 1, index + 2)
    return prev_index, next_index


def _motion_row_strength(
    current: np.ndarray, prev_same: np.ndarray, next_same: np.ndarray
) -> np.ndarray:
    """逐行运动强度。当前场与前后同极性场比较，返回每行一个 0..1 的值。"""
    prev_diff = np.mean(np.abs(current.astype(np.int16) - prev_same.astype(np.int16)))
    next_diff = np.mean(np.abs(current.astype(np.int16) - next_same.astype(np.int16)))
    per_row = (
        np.abs(current.astype(np.int16) - prev_same.astype(np.int16)).mean(axis=(1, 2))
        + np.abs(current.astype(np.int16) - next_same.astype(np.int16)).mean(
            axis=(1, 2)
        )
    ) / 2.0
    strength = per_row / 255.0
    return strength, float(min(prev_diff, next_diff) / 255.0)


def deinterlace_bob(fields: list[tuple[str, np.ndarray]]) -> list[np.ndarray]:
    """简单行复制：单场垂直翻倍，不使用另一场，无重影但垂直分辨率减半。"""
    return [bob_upsample(field, parity) for parity, field in fields]


def deinterlace_weave(fields: list[tuple[str, np.ndarray]]) -> list[np.ndarray]:
    """两场融合：与时间上相邻的异极性场编织，全垂直分辨率，运动处产生梳齿/重影。"""
    length = len(fields)
    output: list[np.ndarray] = []
    for index, (parity, field) in enumerate(fields):
        neighbor_index = index + 1 if index + 1 < length else index - 1
        other_parity, other = fields[neighbor_index]
        if parity == TOP:
            output.append(weave_fields(field, other))
        else:
            output.append(weave_fields(other, field))
    return output


def deinterlace_adaptive(
    fields: list[tuple[str, np.ndarray]], motion_threshold: float = 0.18
) -> tuple[list[np.ndarray], list[dict]]:
    """运动自适应：静态行用两场融合保分辨率，运动行退回行复制抑制梳齿。

    返回 (帧列表, 每帧的运动诊断信息)。
    """
    length = len(fields)
    output: list[np.ndarray] = []
    diagnostics: list[dict] = []
    for index, (parity, field) in enumerate(fields):
        prev_index, next_index = _neighbors(index, length)
        prev_same = fields[prev_index][1]
        next_same = fields[next_index][1]
        strength, global_strength = _motion_row_strength(
            field, prev_same, next_same
        )

        bob = bob_upsample(field, parity)
        neighbor_index = index + 1 if index + 1 < length else index - 1
        other_parity, other = fields[neighbor_index]
        woven = weave_fields(field, other) if parity == TOP else weave_fields(
            other, field
        )

        row_weight = np.clip(strength / motion_threshold, 0.0, 1.0)
        moving_ratio = float(np.mean(strength > motion_threshold))
        full_weight = np.repeat(row_weight, 2).reshape(-1, 1, 1)
        frame = (
            woven.astype(np.float32) * (1.0 - full_weight)
            + bob.astype(np.float32) * full_weight
        ).astype(np.uint8)
        output.append(frame)
        diagnostics.append(
            {
                "field_index": index,
                "parity": parity,
                "global_motion": round(global_strength, 4),
                "moving_row_ratio": round(moving_ratio, 4),
            }
        )
    return output, diagnostics
