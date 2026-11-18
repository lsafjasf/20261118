"""客观画质指标与处理耗时统计。"""

import time
from dataclasses import dataclass, field

import numpy as np


def psnr(reference: np.ndarray, candidate: np.ndarray) -> float:
    """峰值信噪比，单位 dB；完全一致时返回 +inf。"""
    ref = reference.astype(np.float64)
    cand = candidate.astype(np.float64)
    mse = np.mean((ref - cand) ** 2)
    if mse == 0:
        return float("inf")
    return float(20.0 * np.log10(255.0) - 10.0 * np.log10(mse))


def mean_abs_error(reference: np.ndarray, candidate: np.ndarray) -> float:
    """平均绝对误差，0..255，越小越好。"""
    return float(
        np.mean(np.abs(reference.astype(np.float64) - candidate.astype(np.float64)))
    )


def vertical_resolution_score(frame: np.ndarray) -> float:
    """垂直高频能量代理指标：相邻行差异越大，垂直细节保留越多。"""
    diff = np.abs(
        frame[1:, :, :].astype(np.float32) - frame[:-1, :, :].astype(np.float32)
    )
    return float(np.mean(diff))


def combing_artifact(frame: np.ndarray) -> float:
    """梳齿/锯齿伪影强度。

    正常垂直边缘在行间平滑变化；编织错误会让相邻行出现 +d、-d 的反向跳变。
    用三行二阶差分的幅值度量这种锯齿，值越大说明梳齿越严重。
    行复制产生的是重复行，二阶差分接近 0，不会被误判。
    """
    f = frame.astype(np.float32)
    second_diff = f[2:, :, :] - 2.0 * f[1:-1, :, :] + f[:-2, :, :]
    return float(np.mean(np.abs(second_diff)))


def combing_error(reference: np.ndarray, candidate: np.ndarray) -> float:
    """相对真值的梳齿误差：只统计误差帧里的行间反向跳变。

    无参考的 combing_artifact 会把真实细横线误判成梳齿。这里对
    (输出 - 真值) 误差做二阶差分：静态融合误差为 0 时得 0 分，
    运动编织产生的隔行错位误差呈现 +d/-d 交替，得分显著升高。
    """
    error = candidate.astype(np.float32) - reference.astype(np.float32)
    second_diff = error[2:, :, :] - 2.0 * error[1:-1, :, :] + error[:-2, :, :]
    return float(np.mean(np.abs(second_diff)))


@dataclass
class Timing:
    """记录某策略在整段素材上的处理耗时。"""

    method: str
    elapsed_seconds: float
    frame_count: int
    per_frame_ms: float = field(init=False)

    def __post_init__(self) -> None:
        self.per_frame_ms = (
            1000.0 * self.elapsed_seconds / max(1, self.frame_count)
        )


def timed_run(method_name: str, func, *args, **kwargs):
    """执行去隔行函数并计时，返回 (结果, Timing)。"""
    start = time.perf_counter()
    result = func(*args, **kwargs)
    elapsed = time.perf_counter() - start
    frame_count = len(result[0]) if isinstance(result, tuple) else len(result)
    return result, Timing(method_name, elapsed, frame_count)
