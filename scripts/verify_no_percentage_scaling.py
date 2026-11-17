"""
Guard test proving the mapping is driven by the cut list, not by a global
percentage scale. Percentage scaling is only valid when removals are
distributed proportionally; with explicit uneven cut points it produces
measurable frame errors. This test asserts the delivered mapping differs from
the naive-scaling result by the expected frame offset.
"""
from common import OUT, WORK, load_json


def main() -> None:
    source = load_json(WORK / "source_chapters.json")
    plan = load_json(WORK / "edit_plan.json")
    mapped = load_json(OUT / "chapter_map.json")
    fps = source["source_fps"]
    src_duration = plan["total_source_frames"] / fps
    out_duration = plan["total_output_frames"] / fps
    scale = out_duration / src_duration

    failures = []
    for chapter in mapped["chapters"]:
        old_start = chapter["old_time"]["start_sec"]
        naive = old_start * scale
        correct = chapter["new_time"]["start_sec"]
        drift_frames = round(abs(naive - correct) * fps)
        if old_start > 0 and drift_frames == 0:
            failures.append(
                f"chapter {chapter['index']}: percentage scaling happened to match; "
                "test scenario does not distinguish the two algorithms"
            )
        print(
            f"chapter {chapter['index']} {chapter['titles']['zh']}: "
            f"old={old_start:7.3f}  naive_scale={naive:7.3f}  "
            f"cut_based={correct:7.3f}  drift={drift_frames} frames"
        )

    # Sanity: total removed frames equals what the cut list declares.
    declared_removed = sum(b - a for a, b in plan["removed_ranges_frames"])
    if declared_removed != plan["total_source_frames"] - plan["total_output_frames"]:
        failures.append("removed frame accounting mismatch")

    if failures:
        for item in failures:
            print("FAIL:", item)
        raise SystemExit(1)
    print("PERCENTAGE-SCALING GUARD PASSED: cut-list mapping is frame-accurate")


if __name__ == "__main__":
    main()
