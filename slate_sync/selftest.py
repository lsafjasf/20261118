"""端到端自检：用生成素材时的已知真实偏移，断言检测、微调、验证全链路。"""

from __future__ import annotations

import json
import os

from .engine import SyncEngine
from .report import build_report
from .timeline import validate_segments

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run() -> int:
    manifest_path = os.path.join(ROOT, "samples", "media_manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        truth = {item["id"]: item["trueOffsetMs"]
                 for item in json.load(handle)["tracks"]}

    engine = SyncEngine(os.path.join(ROOT, "samples", "media"))
    engine.analyze()
    failures = []
    for track_id, true_ms in truth.items():
        got_ms = engine.final_offset_sec(track_id) * 1000.0
        if abs(got_ms - true_ms) > 0.5:
            failures.append(
                f"{track_id} 偏移 {got_ms:.2f}ms 与真实 {true_ms}ms 不符")

    # 手动微调必须线性叠加，且主轨拒绝微调
    engine.set_nudge("cam_a", -10.0)
    if abs(engine.final_offset_sec("cam_a") * 1000.0 - (truth["cam_a"] - 10)) > 0.5:
        failures.append("手动微调未正确叠加到最终偏移")
    try:
        engine.set_nudge("recorder", 5.0)
        failures.append("主音轨不应允许微调")
    except ValueError:
        pass
    engine.set_nudge("cam_a", 0.0)

    full_report = build_report(engine)
    verification = full_report["verification"]
    if not verification["passed"]:
        failures.append("共同段落验证未通过")
    if verification["comparedWindows"] != 9:
        failures.append("比对窗口数量应为 9")
    if verification["maxErrorMs"] > 5.0:
        failures.append("最大残差超过 5ms 阈值")

    offsets = {row["trackId"]: row["finalOffsetMs"] / 1000.0
               for row in full_report["matrix"]}
    durations = {row["trackId"]: row["durationMs"] / 1000.0
                 for row in full_report["matrix"]}
    problems = validate_segments(
        full_report["programSegments"], offsets, durations,
        full_report["commonInSec"], full_report["commonOutSec"])
    if problems:
        failures.append(f"时间线校验失败: {problems}")

    # 微调超阈值必须能被验证捕捉
    engine.set_nudge("cam_b", 12.0)
    bad_report = build_report(engine)
    cam_b = next(item for item in bad_report["verification"]["perTrack"]
                 if item["trackId"] == "cam_b")
    if cam_b["status"] != "fail":
        failures.append("12ms 微调应被判定为 fail")

    if failures:
        print("自检失败:")
        for item in failures:
            print(" -", item)
        return 1
    print("自检通过：")
    print(f"  4 轨偏移与真实值偏差 ≤0.5ms；共同段 "
          f"{verification['commonInSec']}~{verification['commonOutSec']}s "
          f"({verification['commonDurationSec']}s)")
    print(f"  {verification['comparedWindows']} 个验证窗口，最大残差 "
          f"{verification['maxErrorMs']}ms（阈值 {verification['thresholdMs']}ms）")
    print("  手动微调叠加正确、主轨锁定、超阈值微调可被拦截、EDL 切点连续")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
