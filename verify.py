#!/usr/bin/env python3
"""Verify analyzer output against injected ground truth.

For each test segment, rebuilds the expected detections from tsgen's
ground-truth data (independent of tsanalyze's CC arithmetic) and compares
them with the analyzer's JSON report.
"""
import json
import sys

import tsgen


def expected_cc_errors(mode: str) -> list:
    """Recompute expected (output_index, pid, lost) from generator state."""
    rollback_frame = 25 if mode == "pcr-rollback" else None
    seq, _ = tsgen.generate(2000, rollback_frame)
    kept, _ = tsgen.inject_faults(seq, mode)
    kept_ids = {id(e["pkt"]) for e in kept}

    # map: position in seq -> output index (for kept packets)
    expected = []
    last_seen = {}  # pid -> (seq_pos, dropped_since)
    out_index = 0
    dropped_run = {}  # pid -> count of consecutive drops
    for entry in seq:
        pid = entry["pid"]
        if id(entry["pkt"]) in kept_ids:
            if dropped_run.get(pid):
                expected.append({
                    "packet_index": out_index,
                    "pid": pid,
                    "lost_packets": dropped_run[pid],
                })
                dropped_run[pid] = 0
            out_index += 1
        else:
            dropped_run[pid] = dropped_run.get(pid, 0) + 1
    return expected


def check_segment(name: str, mode: str) -> bool:
    ok = True
    with open(f"testdata/{name}.truth.json") as fh:
        truth = json.load(fh)
    with open(f"reports/{name}.json") as fh:
        report = json.load(fh)

    # --- CC loss events ---
    detected = []
    for pid_str, info in report["pids"].items():
        for err in info["cc_errors"]:
            detected.append({
                "packet_index": err["packet_index"],
                "pid": int(pid_str),
                "lost_packets": err["lost_packets"],
            })
    expected = expected_cc_errors(mode)
    if sorted(detected, key=str) == sorted(expected, key=str):
        print(f"  [{name}] CC 丢包事件一致: {len(detected)} 处 "
              f"(共丢 {sum(e['lost_packets'] for e in detected)} 包)")
    else:
        ok = False
        print(f"  [{name}] FAIL: CC 事件不一致\n    期望: {expected}\n"
              f"    实际: {detected}")

    # --- dropped packet count from truth must equal detected loss ---
    truth_dropped = len(truth["dropped"])
    detected_lost = sum(e["lost_packets"] for e in detected)
    if truth_dropped != detected_lost:
        ok = False
        print(f"  [{name}] FAIL: 真值丢 {truth_dropped} 包, "
              f"检出 {detected_lost} 包")

    # --- PCR rollback ---
    rollbacks = [
        (int(pid_str), rb)
        for pid_str, info in report["pids"].items()
        for rb in info["pcr_rollbacks"]
    ]
    if "pcr_rollback_at" in truth:
        want = truth["pcr_rollback_at"]
        match = any(
            pid == want["pid"] and rb["packet_index"] == want["output_index"]
            and abs(rb["backwards_ms"] - 1960.0) < 80
            for pid, rb in rollbacks)
        if match and len(rollbacks) == 1:
            print(f"  [{name}] PCR 回退一致: 1 处 "
                  f"@#{rollbacks[0][1]['packet_index']} "
                  f"(-{rollbacks[0][1]['backwards_ms']:.0f} ms)")
        else:
            ok = False
            print(f"  [{name}] FAIL: PCR 回退不符, 检出 {rollbacks}")
    elif rollbacks:
        ok = False
        print(f"  [{name}] FAIL: 误报 PCR 回退 {rollbacks}")
    else:
        print(f"  [{name}] 无 PCR 回退 (符合预期)")

    # --- interleave segment must be completely clean ---
    if mode == "interleave":
        if not detected and not rollbacks:
            print(f"  [{name}] 正常交错无误报 ✓")
        else:
            ok = False
            print(f"  [{name}] FAIL: 正常交错被误报")
    return ok


def main():
    segments = [
        ("single_loss", "single-loss"),
        ("burst_loss", "burst-loss"),
        ("interleave", "interleave"),
        ("pcr_rollback", "pcr-rollback"),
    ]
    all_ok = True
    for name, mode in segments:
        all_ok &= check_segment(name, mode)
    print("VERIFY:", "PASS" if all_ok else "FAIL")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
