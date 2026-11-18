"""合成已知真值（ground truth）的隔行测试片。

先生成逐行（progressive）参考帧，再模拟隔行采集：每个输出帧由两帧
相邻参考帧的异极性场编织而成，因此能客观评估各策略相对真值的误差。
"""

import numpy as np

from .fields import weave_fields, split_fields

HEIGHT = 240
WIDTH = 320


def _canvas(color: tuple[int, int, int] = (24, 24, 28)) -> np.ndarray:
    frame = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:, :] = color
    return frame


def _rect(frame: np.ndarray, x0: int, y0: int, w: int, h: int,
          color: tuple[int, int, int]) -> None:
    x1 = min(WIDTH, max(0, x0 + w))
    y1 = min(HEIGHT, max(0, y0 + h))
    x0 = max(0, x0)
    y0 = max(0, y0)
    if x1 > x0 and y1 > y0:
        frame[y0:y1, x0:x1] = color


def _pan_frame(t: int) -> np.ndarray:
    """快速横向移动：高对比竖条与移动方块，运动幅度大、水平细节少。"""
    frame = _canvas()
    offset = (t * 14) % (WIDTH + 80) - 40
    for stripe in range(-2, WIDTH // 24 + 2):
        x = stripe * 24 + offset
        _rect(frame, int(x), 0, 10, HEIGHT, (230, 220, 60))
    _rect(frame, int(offset + 60), 70, 46, 100, (60, 170, 255))
    _rect(frame, int(offset + 150), 40, 26, 160, (255, 90, 120))
    return frame


def _hline_frame(t: int) -> np.ndarray:
    """细横线静态分辨率板：单像素横线、楔形线对，完全静止。"""
    frame = _canvas((232, 232, 228))
    for row in range(8, 200, 4):
        _rect(frame, 16, row, 120, 1, (20, 20, 20))
    for idx, gap in enumerate((2, 3, 4, 6, 8)):
        base_y = 20 + idx * 40
        for row in range(base_y, base_y + 24, gap):
            _rect(frame, 180, row, 120, 1, (15, 15, 90))
    _rect(frame, 0, 220, WIDTH, 2, (0, 0, 0))
    return frame


def _mixed_frame(t: int) -> np.ndarray:
    """混合场景：上半区静态细横线，下半区快速横移，考验自适应的逐行判断。"""
    frame = _canvas((200, 200, 196))
    for row in range(10, 112, 3):
        _rect(frame, 20, row, 280, 1, (30, 30, 30))
    offset = (t * 12) % (WIDTH + 80) - 40
    _rect(frame, int(offset), 140, 70, 80, (200, 40, 40))
    for stripe in range(-1, WIDTH // 30 + 1):
        x = stripe * 30 + offset
        _rect(frame, int(x), 132, 8, 108, (40, 90, 220))
    return frame


SCENES = {
    "pan": _pan_frame,
    "hline": _hline_frame,
    "mixed": _mixed_frame,
}


def generate_progressive(scene: str, count: int) -> list[np.ndarray]:
    if scene not in SCENES:
        raise ValueError(f"未知场景 {scene}，可选：{sorted(SCENES)}")
    return [SCENES[scene](t) for t in range(count)]


def simulate_interlace(
    progressive: list[np.ndarray], order: str = "tff"
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """从逐行序列模拟隔行序列。

    返回 (interlaced_frames, reference_frames)：
    - interlaced_frames 中每帧由相邻两个时刻的异极性场编织；
    - reference_frames 是与每个输出帧时间中点对齐的参考真值帧。
    """
    interlaced: list[np.ndarray] = []
    reference: list[np.ndarray] = []
    count = len(progressive) - 1
    for index in range(count):
        first_top, first_bottom = split_fields(progressive[index])
        second_top, second_bottom = split_fields(progressive[index + 1])
        if order == "tff":
            frame = weave_fields(first_top, second_bottom)
        else:
            frame = weave_fields(second_top, first_bottom)
        interlaced.append(frame)
        reference.append(progressive[index + 1])
    return interlaced, reference
