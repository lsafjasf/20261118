"""不依赖测试框架的最小自检：python -m deinterlace.selftest。"""

import numpy as np

from .fields import (
    BOTTOM,
    TOP,
    bob_upsample,
    chronological_fields,
    split_fields,
    weave_fields,
)
from .generator import generate_progressive, simulate_interlace
from .methods import deinterlace_adaptive, deinterlace_bob, deinterlace_weave
from .metrics import combing_error, psnr


def test_field_roundtrip() -> None:
    frame = np.arange(240 * 320 * 3, dtype=np.uint8).reshape(240, 320, 3)
    top, bottom = split_fields(frame)
    assert top.shape == (120, 320, 3) and bottom.shape == (120, 320, 3)
    rebuilt = weave_fields(top, bottom)
    assert np.array_equal(rebuilt, frame), "拆场/编织往返不一致"


def test_chronological_order() -> None:
    frames = [np.zeros((4, 2, 3), dtype=np.uint8) for _ in range(2)]
    tff = chronological_fields(frames, "tff")
    bff = chronological_fields(frames, "bff")
    assert [parity for parity, _ in tff] == [TOP, BOTTOM, TOP, BOTTOM]
    assert [parity for parity, _ in bff] == [BOTTOM, TOP, BOTTOM, TOP]


def test_bob_duplicates_rows() -> None:
    field = np.random.randint(0, 255, (10, 8, 3), dtype=np.uint8)
    up = bob_upsample(field, TOP)
    assert np.array_equal(up[0], up[1]) and np.array_equal(up[2], up[3])


def test_static_weave_is_perfect() -> None:
    progressive = generate_progressive("hline", 4)
    interlaced, reference = simulate_interlace(progressive, "tff")
    fields = chronological_fields(interlaced, "tff")
    woven = deinterlace_weave(fields)
    scores = [psnr(reference[min(i // 2, 3)], frame)
              for i, frame in enumerate(woven)]
    assert all(np.isinf(score) for score in scores), "静态素材融合应无损"


def test_motion_weave_combs_more_than_bob() -> None:
    progressive = generate_progressive("pan", 6)
    interlaced, reference = simulate_interlace(progressive, "tff")
    fields = chronological_fields(interlaced, "tff")
    bob = deinterlace_bob(fields)
    woven = deinterlace_weave(fields)
    refs = [reference[min(i // 2, len(reference) - 1)] for i in range(len(fields))]
    bob_combing = np.mean([combing_error(r, f) for r, f in zip(refs, bob)])
    weave_combing = np.mean([combing_error(r, f) for r, f in zip(refs, woven)])
    assert weave_combing > 10 * bob_combing, "横移时融合梳齿应远高于行复制"


def test_adaptive_returns_diagnostics() -> None:
    progressive = generate_progressive("mixed", 6)
    interlaced, _ = simulate_interlace(progressive, "tff")
    fields = chronological_fields(interlaced, "tff")
    frames, diag = deinterlace_adaptive(fields)
    assert len(frames) == len(fields) == len(diag)
    assert all(0.0 <= d["moving_row_ratio"] <= 1.0 for d in diag)


def main() -> None:
    tests = [
        test_field_roundtrip,
        test_chronological_order,
        test_bob_duplicates_rows,
        test_static_weave_is_perfect,
        test_motion_weave_combs_more_than_bob,
        test_adaptive_returns_diagnostics,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\n全部 {len(tests)} 项自检通过")


if __name__ == "__main__":
    main()
