"""Validate the Python analysis against the programmed ground truth.

Exits non-zero if any check fails. Tolerances account for 16-bit quantization,
window crossfades and frame-grid (0.5 s) alignment.
"""

from __future__ import annotations

import json
import os

ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "artifacts")


def main() -> None:
    truth = json.load(open(os.path.join(ART, "ground_truth.json"), encoding="utf-8"))
    metrics = json.load(open(os.path.join(ART, "metrics.json"), encoding="utf-8"))
    exp = truth["expected"]
    s = metrics["summary"]
    failures = 0

    def check(name, ok, detail):
        nonlocal failures
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
        if not ok:
            failures += 1

    # 1. Maximum peak = unique full-scale blip at the programmed timestamp.
    check(
        "maximum peak is 0.0 dBFS",
        abs(s["global_peak_dbfs"] - exp["global_peak_dbfs"]) <= 0.01,
        f"{s['global_peak_dbfs']} dBFS",
    )
    check(
        "maximum peak located at the blip",
        abs(s["global_peak_time_s"] - exp["global_peak_time_s"]) <= 0.01,
        f"t={s['global_peak_time_s']} s (expected {exp['global_peak_time_s']})",
    )

    # 2. Highest loudness window overlaps the loudest programmed burst.
    hl = (s["max_loudness_frame_time_s"], s["max_loudness_frame_time_s"] + metrics["frame"]["window_s"])
    lo, hi = exp["highest_loudness_window_s"]
    check(
        "highest-loudness window overlaps loudest burst (400-403 s)",
        hl[0] < hi and hl[1] > lo,
        f"{s['max_loudness_lufs']} LUFS at frame {hl[0]}-{hl[1]} s",
    )

    # 3. Silence total matches the two programmed 20 s silent regions.
    check(
        "silence total equals 40 s",
        abs(s["silence_total_s"] - exp["silence_total_s"]) <= 1.0,
        f"{s['silence_total_s']} s (expected {exp['silence_total_s']})",
    )

    # 4. Both sudden-loud bursts detected with correct timing.
    sudden = metrics["regions"]["sudden_loud"]
    check("two sudden-loud regions", len(sudden) == 2, f"got {len(sudden)}")
    for expected_range in exp["sudden_loud_burst_s"]:
        match = any(
            abs(r["start_s"] - expected_range[0]) <= 1.0 and abs(r["end_s"] - expected_range[1]) <= 1.0
            for r in sudden
        )
        check(f"burst at {expected_range} detected", match, str(expected_range))

    # 5. Each sustained low-level bed detected.
    low = metrics["regions"]["sustained_low"]
    for expected_range in exp["sustained_low_s"]:
        match = any(
            r["start_s"] <= expected_range[0] + 1.0 and r["end_s"] >= expected_range[1] - 1.0 for r in low
        )
        check(f"low-level bed {expected_range} covered", match, str(expected_range))

    # 6. Both exact-silence regions detected with correct spans.
    sil = metrics["regions"]["silence"]
    check("two silence regions", len(sil) == 2, f"got {len(sil)}")
    for expected_range in exp["silence_s"]:
        match = any(
            abs(r["start_s"] - expected_range[0]) <= 1.0 and abs(r["end_s"] - expected_range[1]) <= 1.0
            for r in sil
        )
        check(f"silence {expected_range} detected", match, str(expected_range))

    print("\n" + ("ALL GROUND-TRUTH CHECKS PASSED" if not failures else f"{failures} CHECK(S) FAILED"))
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
