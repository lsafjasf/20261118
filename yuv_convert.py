"""10-bit <-> 8-bit YUV conversion with BT.709 / BT.2020 matrices.

Conventions
-----------
* Planes are float64 or integer numpy arrays of shape (H, W), one per
  channel (Y, U, V).  "10-bit" samples are integers in [0, 1023],
  "8-bit" samples in [0, 255].
* Limited (video) range:  Y in [16,235] / [64,940],  C in [16,240] / [64,960].
* Full range:             Y in [0,255]  / [0,1023],  C centred at 128 / 512.
* Bit-depth changes use MSB-aligned (left-justified) sample alignment:
    10 -> 8 :  y8  = (y10 + 2) >> 2      (round-to-nearest on the dropped LSBs)
    8 -> 10 :  y10 = y8 << 2             (zero-filled LSBs)
  The 8->10 direction is exact; 10->8 discards the two LSBs and is NOT
  losslessly reversible.
"""
from __future__ import annotations

import numpy as np

# Kr, Kb for each matrix (Kg = 1 - Kr - Kb)
MATRICES = {
    "bt709": (0.2126, 0.0722),
    "bt2020": (0.2627, 0.0593),
}

# (y_offset, y_scale, c_scale, c_offset) per (range, bitdepth)
_LEVELS = {
    ("limited", 8): (16.0, 219.0, 224.0, 128.0),
    ("full", 8): (0.0, 255.0, 255.0, 128.0),
    ("limited", 10): (64.0, 876.0, 896.0, 512.0),
    ("full", 10): (0.0, 1023.0, 1023.0, 512.0),
}

MAXVAL = {8: 255, 10: 1023}


def _levels(video_range: str, bitdepth: int):
    try:
        return _LEVELS[(video_range, bitdepth)]
    except KeyError:
        raise ValueError(f"bad range/bitdepth: {video_range}/{bitdepth}")


def rgb_to_yuv(rgb: np.ndarray, matrix: str, video_range: str, bitdepth: int):
    """rgb: (H, W, 3) float in [0, 1]. Returns (Y, U, V) float planes."""
    kr, kb = MATRICES[matrix]
    kg = 1.0 - kr - kb
    y_off, y_scale, c_scale, c_off = _levels(video_range, bitdepth)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = kr * r + kg * g + kb * b
    u = (b - y) / (2.0 * (1.0 - kb))
    v = (r - y) / (2.0 * (1.0 - kr))
    return (
        y * y_scale + y_off,
        u * c_scale + c_off,
        v * c_scale + c_off,
    )


def yuv_to_rgb(y, u, v, matrix: str, video_range: str, bitdepth: int):
    """Inverse of rgb_to_yuv. Returns (H, W, 3) float in [0, 1] (unclipped)."""
    kr, kb = MATRICES[matrix]
    kg = 1.0 - kr - kb
    y_off, y_scale, c_scale, c_off = _levels(video_range, bitdepth)
    yn = (y - y_off) / y_scale
    un = (u - c_off) / c_scale
    vn = (v - c_off) / c_scale
    b = un * 2.0 * (1.0 - kb) + yn
    r = vn * 2.0 * (1.0 - kr) + yn
    g = (yn - kr * r - kb * b) / kg
    return np.stack([r, g, b], axis=-1)


def quantize(plane: np.ndarray, bitdepth: int) -> np.ndarray:
    """Round float plane to nearest integer sample, clipped to valid codes."""
    return np.clip(np.rint(plane), 0, MAXVAL[bitdepth]).astype(np.int32)


def downconvert_10_to_8(plane10: np.ndarray) -> np.ndarray:
    """10-bit -> 8-bit, MSB-aligned, round-to-nearest on dropped LSBs.

    y8 = (y10 + 2) >> 2.  Lossy: the two LSBs cannot be recovered.
    """
    p = plane10.astype(np.int32)
    if p.min() < 0 or p.max() > 1023:
        raise ValueError("10-bit plane out of range")
    # clip: codes 1022..1023 round up to 256 and must saturate to 255
    return np.clip((p + 2) >> 2, 0, 255)


def upconvert_8_to_10(plane8: np.ndarray) -> np.ndarray:
    """8-bit -> 10-bit, MSB-aligned, zero-filled LSBs (y10 = y8 << 2).

    Exact, but note it does NOT restore information previously lost by a
    10->8 down-conversion.
    """
    p = plane8.astype(np.int32)
    if p.min() < 0 or p.max() > 255:
        raise ValueError("8-bit plane out of range")
    return p << 2
