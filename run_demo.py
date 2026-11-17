"""End-to-end demo: 10-bit YUV down/up conversion on test colour bars."""
from __future__ import annotations

import json
import os

import numpy as np

import yuv_analysis as ya
import yuv_convert as yc
from test_pattern import make_test_pattern

ARTIFACTS = "artifacts"


def error_metrics(ref: np.ndarray, test: np.ndarray) -> dict:
    diff = test.astype(np.float64) - ref.astype(np.float64)
    return {
        "max_abs": float(np.abs(diff).max()),
        "mean_abs": float(np.abs(diff).mean()),
        "rmse": float(np.sqrt((diff ** 2).mean())),
        "num_different": int((diff != 0).sum()),
    }


def psnr(ref: np.ndarray, test: np.ndarray, peak: float = 1.0) -> float:
    mse = float(((ref - test) ** 2).mean())
    if mse == 0.0:
        return float("inf")
    return 10.0 * np.log10(peak * peak / mse)


def run_combination(rgb: np.ndarray, matrix: str, video_range: str) -> dict:
    """Run the 4-step pipeline for one (matrix, range) combination."""
    tag = f"{matrix}_{video_range}"
    outdir = os.path.join(ARTIFACTS, tag)
    os.makedirs(outdir, exist_ok=True)
    report: dict = {"matrix": matrix, "range": video_range, "steps": {}}

    yuv10 = tuple(yc.quantize(p, 10)
                  for p in yc.rgb_to_yuv(rgb, matrix, video_range, 10))
    yuv8_direct = tuple(yc.downconvert_10_to_8(p) for p in yuv10)
    yuv10_rt = tuple(yc.upconvert_8_to_10(p) for p in yuv8_direct)
    yuv8_rt = tuple(yc.downconvert_10_to_8(p) for p in yuv10_rt)

    steps = [
        ("step1_yuv10", yuv10, 10),
        ("step2_yuv8_direct", yuv8_direct, 8),
        ("step3_yuv10_roundtrip", yuv10_rt, 10),
        ("step4_yuv8_roundtrip", yuv8_rt, 8),
    ]
    for name, planes, bitdepth in steps:
        hist_path = os.path.join(outdir, f"{name}_hist.png")
        ya.save_histogram(planes, bitdepth, f"{tag} {name}", hist_path)
        summary = ya.texture_summary(name, planes, video_range, bitdepth,
                                     matrix, extra={"histogram": hist_path})
        summary_path = os.path.join(outdir, f"{name}_summary.json")
        ya.save_summary(summary, summary_path)
        report["steps"][name] = {
            "violations": summary["violations"],
            "summary_json": summary_path,
            "histogram": hist_path,
        }

    report["comparison"] = build_comparison(
        rgb, matrix, video_range, yuv10, yuv8_direct, yuv10_rt, yuv8_rt)
    return report


def build_comparison(rgb, matrix, video_range,
                     yuv10, yuv8_direct, yuv10_rt, yuv8_rt) -> dict:
    """Quantify round-trip loss (10->8->10 is NOT lossless)."""
    comp: dict = {}

    # (a) round-trip 10-bit vs original 10-bit: the lost 2 LSBs
    comp["roundtrip10_vs_orig10"] = {
        c: error_metrics(ref, rt)
        for c, ref, rt in zip(ya.CHANNELS, yuv10, yuv10_rt)
    }

    # (b) direct 8-bit output vs round-trip 8-bit output
    comp["roundtrip8_vs_direct8"] = {
        c: error_metrics(ref, rt)
        for c, ref, rt in zip(ya.CHANNELS, yuv8_direct, yuv8_rt)
    }

    # (c) RGB-domain PSNR: original 10-bit YUV vs round-tripped 10-bit YUV
    rgb_ref = np.clip(yc.yuv_to_rgb(*yuv10, matrix, video_range, 10), 0, 1)
    rgb_rt = np.clip(yc.yuv_to_rgb(*yuv10_rt, matrix, video_range, 10), 0, 1)
    comp["rgb_psnr_roundtrip_db"] = psnr(rgb_ref, rgb_rt)
    comp["note"] = (
        "10-bit -> 8-bit -> 10-bit discards the 2 LSBs and is NOT "
        "lossless; 8-bit -> 10-bit -> 8-bit is exact."
    )
    return comp


def main() -> None:
    rgb = make_test_pattern()
    os.makedirs(ARTIFACTS, exist_ok=True)
    reports = []
    for matrix in ("bt709", "bt2020"):
        for video_range in ("limited", "full"):
            report = run_combination(rgb, matrix, video_range)
            reports.append(report)
            print_report(report)

    report_path = os.path.join(ARTIFACTS, "report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(reports, fh, indent=2, ensure_ascii=False)
    print(f"\nfull report: {report_path}")


def print_report(report: dict) -> None:
    tag = f"{report['matrix']}_{report['range']}"
    print(f"\n=== {tag} ===")
    for name, info in report["steps"].items():
        v = info["violations"]
        print(f"  {name:26s} super_black={v['super_black_y']:6d} "
              f"super_white={v['super_white_y']:6d} "
              f"chroma_low={v['chroma_below_min']:6d} "
              f"chroma_high={v['chroma_above_max']:6d}")
    comp = report["comparison"]
    rt10 = comp["roundtrip10_vs_orig10"]["Y"]
    rt8 = comp["roundtrip8_vs_direct8"]["Y"]
    print(f"  roundtrip10 vs orig10 (Y): max_abs={rt10['max_abs']:.0f} "
          f"mean_abs={rt10['mean_abs']:.4f} rmse={rt10['rmse']:.4f} "
          f"diff_px={rt10['num_different']}")
    print(f"  roundtrip8 vs direct8 (Y): max_abs={rt8['max_abs']:.0f} "
          f"diff_px={rt8['num_different']}")
    print(f"  RGB PSNR (orig10 vs roundtrip10): "
          f"{comp['rgb_psnr_roundtrip_db']:.2f} dB")


if __name__ == "__main__":
    main()
