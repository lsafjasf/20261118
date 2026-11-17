"""Sanity tests for alignment, rounding and round-trip behaviour."""
import numpy as np

import yuv_convert as yc


def test_downconvert_rounding():
    # (x + 2) >> 2: 1->0, 2->1 (round half up), 3->1, 5->1, 6->2
    src = np.array([[0, 1, 2, 3, 5, 6, 1021, 1022, 1023]], dtype=np.int32)
    out = yc.downconvert_10_to_8(src)
    assert out.tolist() == [[0, 0, 1, 1, 1, 2, 255, 255, 255]]


def test_upconvert_alignment():
    src = np.array([[0, 1, 128, 255]], dtype=np.int32)
    out = yc.upconvert_8_to_10(src)
    assert out.tolist() == [[0, 4, 512, 1020]]


def test_8_10_8_is_exact():
    src = np.arange(256, dtype=np.int32).reshape(16, 16)
    rt = yc.downconvert_10_to_8(yc.upconvert_8_to_10(src))
    assert np.array_equal(rt, src)


def test_10_8_10_is_not_lossless():
    rng = np.random.default_rng(0)
    src = rng.integers(0, 1024, size=(64, 64), dtype=np.int32)
    rt = yc.upconvert_8_to_10(yc.downconvert_10_to_8(src))
    assert not np.array_equal(rt, src)
    assert np.abs(rt - src).max() <= 3  # only the 2 LSBs (+clip) are lost


def test_rgb_yuv_inverse_all_modes():
    rng = np.random.default_rng(1)
    rgb = rng.random((8, 8, 3))
    for matrix in yc.MATRICES:
        for video_range in ("limited", "full"):
            for bitdepth in (8, 10):
                yuv = yc.rgb_to_yuv(rgb, matrix, video_range, bitdepth)
                back = yc.yuv_to_rgb(*yuv, matrix, video_range, bitdepth)
                assert np.abs(back - rgb).max() < 1e-9


def test_limited_range_levels():
    black = np.zeros((1, 1, 3))
    white = np.ones((1, 1, 3))
    y0, _, _ = yc.rgb_to_yuv(black, "bt709", "limited", 10)
    y1, _, _ = yc.rgb_to_yuv(white, "bt709", "limited", 10)
    assert abs(y0[0, 0] - 64.0) < 1e-9
    assert abs(y1[0, 0] - 940.0) < 1e-9


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_"):
            fn()
            print(f"ok {name}")
