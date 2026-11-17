"""10-bit RGB test pattern: color bars + gradients + out-of-range strips."""
from __future__ import annotations

import numpy as np

# 75% amplitude bars (R, G, B) in [0, 1]
_BARS_75 = [
    (0.75, 0.75, 0.75),
    (0.75, 0.75, 0.00),
    (0.00, 0.75, 0.75),
    (0.00, 0.75, 0.00),
    (0.75, 0.00, 0.75),
    (0.75, 0.00, 0.00),
    (0.00, 0.00, 0.75),
    (0.00, 0.00, 0.00),
]


def make_test_pattern(width: int = 640, height: int = 360) -> np.ndarray:
    """Return float64 RGB in nominal [0, 1] (strips may exceed it).

    Layout (top to bottom): 75% colour bars; full-range R/G/B and luma
    gradients at 10-bit resolution; super-white (109%) and super-black
    (-3%) strips; a 1-LSB 10-bit checkerboard to stress LSB rounding.
    """
    img = np.zeros((height, width, 3), dtype=np.float64)
    h_bars = height // 2
    h_grad = height // 4
    h_strip = int(height * 0.15)

    bar_w = width // len(_BARS_75)
    for i, (r, g, b) in enumerate(_BARS_75):
        x0 = i * bar_w
        x1 = (i + 1) * bar_w if i < len(_BARS_75) - 1 else width
        img[:h_bars, x0:x1] = (r, g, b)

    y0, y1 = h_bars, h_bars + h_grad
    ramp = np.linspace(0.0, 1.0, width)
    section = (y1 - y0) // 4
    img[y0:y0 + section, :, 0] = ramp
    img[y0 + section:y0 + 2 * section, :, 1] = ramp
    img[y0 + 2 * section:y0 + 3 * section, :, 2] = ramp
    img[y0 + 3 * section:y1, :, :] = ramp[:, None]

    y2 = y1 + h_strip
    img[y1:y2, : width // 2] = 1.09
    img[y1:y2, width // 2:] = -0.03

    yy, xx = np.mgrid[y2:height, 0:width]
    lsb = ((xx + yy) % 2) / 1023.0
    img[y2:height, :, :] = (0.5 + lsb)[..., None]

    return img
