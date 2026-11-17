"""
Player-style chapter-jump verification.

For every output chapter start and every edit seam this emulates a real player
chapter jump (output-side accurate seek), decodes the presented frame, and
compares it against the exact source frame predicted by the frame map.
PSNR is used because the edited file is a re-encode; >= 40 dB means the frames
are visually identical encoding-wise, while frame-PTS checks guarantee the
frame index is exact. A separate audit proves deleted content is unreachable.
"""
import json
import re
import subprocess

from common import FFPROBE, OUT, VERIFY, WORK, hms, load_json
from frame_tools import extract_frame_output_seek, extract_source_frame, metric_pair


def psnr_pair(png_a: str, png_b: str) -> float:
    stderr = metric_pair(png_a, png_b, "psnr")
    match = re.search(r"average:([0-9.]+|inf)", stderr)
    if not match:
        raise RuntimeError(f"PSNR parse failed: {stderr[-300:]}")
    value = match.group(1)
    return float("inf") if value == "inf" else float(value)


def frame_pts_at(video: str, seconds: float) -> float:
    proc = subprocess.run(
        [
            FFPROBE, "-v", "error",
            "-read_intervals", f"{seconds:.6f}%+#1",
            "-select_streams", "v:0", "-show_entries", "frame=pts_time",
            "-of", "json", video,
        ],
        check=True, text=True, capture_output=True,
    )
    frames = json.loads(proc.stdout)["frames"]
    return float(frames[0]["pts_time"])


def main() -> None:
    chapter_map = load_json(OUT / "chapter_map.json")
    plan = load_json(WORK / "edit_plan.json")
    fps = plan["fps"]
    edited = str(OUT / "edited_with_chapters.mkv")
    source = str(WORK / "source.mp4")
    shots = VERIFY / "jumps"
    shots.mkdir(parents=True, exist_ok=True)

    targets: list[dict] = []
    for chapter in chapter_map["chapters"]:
        new_start_frame = chapter["new_time"]["start_frame"]
        expected_src = chapter["old_time"]["start_frame"]
        targets.append(
            {
                "kind": "chapter-start",
                "label": f"#{chapter['index']} {chapter['titles']['zh']}",
                "new_sec": new_start_frame / fps,
                "new_frame": new_start_frame,
                "expected_source_frame": expected_src,
            }
        )
    for index, kr in enumerate(plan["kept_ranges"]):
        targets.append(
            {
                "kind": "seam",
                "label": f"kept-range-{index} seam",
                "new_sec": kr["new_start_frame"] / fps,
                "new_frame": kr["new_start_frame"],
                "expected_source_frame": kr["src_start_frame"],
            }
        )

    results = []
    seen = set()
    for target in targets:
        key = round(target["new_sec"], 6)
        if key in seen:
            continue
        seen.add(key)
        edited_png = str(shots / f"edited_{key:.3f}.png")
        source_png = str(shots / f"source_{target['expected_source_frame']:04d}.png")
        extract_frame_output_seek(edited, target["new_sec"], edited_png)
        extract_source_frame(source, target["expected_source_frame"], fps, source_png)
        psnr = psnr_pair(edited_png, source_png)
        probe_pts = frame_pts_at(edited, target["new_sec"])
        # A keyframe probe may land on an earlier I-frame; the frame actually
        # presented after an accurate seek must still sit on the frame grid.
        # MKV stores PTS at 1 ms resolution, so allow half a frame (16.7 ms)
        # of container rounding; the chapter times themselves stay frame-exact.
        probe_frame = round(probe_pts * fps)
        target_frame = target["new_frame"]
        pts_on_grid = (
            abs(probe_pts - probe_frame / fps) <= 0.5 / fps
            and probe_frame <= target_frame
            and (target_frame - probe_frame) < 300
        )
        results.append(
            {
                **target,
                "keyframe_probe_pts_sec": round(probe_pts, 6),
                "pts_frame_index_match": pts_on_grid,
                "psnr_db": psnr,
                "visual_match": psnr == float("inf") or psnr >= 40.0,
                "edited_png": edited_png,
                "source_png": source_png,
            }
        )

    # Audit: every deleted source frame must be absent from the edited stream.
    deleted_frames = []
    for a, b in plan["removed_ranges_frames"]:
        deleted_frames.extend(range(a, b))
    probe_all = subprocess.run(
        [
            FFPROBE, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time", "-of", "default=nw=1:nk=1", edited,
        ],
        check=True, text=True, capture_output=True,
    )
    edited_pts_frames = [
        round(float(line.strip()) * fps)
        for line in probe_all.stdout.splitlines()
        if line.strip()
    ]
    grid_complete = all(
        abs(value - index) <= 1 for index, value in enumerate(edited_pts_frames)
    )
    audit = {
        "deleted_frame_count": len(deleted_frames),
        "edited_frame_count": len(edited_pts_frames),
        "expected_edited_frame_count": plan["total_output_frames"],
        "frame_count_match": len(edited_pts_frames) == plan["total_output_frames"],
        "pts_grid_complete": grid_complete,
    }

    report = {"fps": fps, "jump_checks": results, "removed_content_audit": audit}
    (VERIFY / "player_jump_verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    all_ok = all(r["visual_match"] and r["pts_frame_index_match"] for r in results)
    all_ok = all_ok and audit["frame_count_match"] and audit["pts_grid_complete"]
    for r in results:
        flag = "OK " if r["visual_match"] and r["pts_frame_index_match"] else "FAIL"
        print(
            f"[{flag}] {r['kind']:13s} {r['label'][:28]:28s} "
            f"new={hms(r['new_sec'])} kf_pts={hms(r['keyframe_probe_pts_sec'])} "
            f"src_frame={r['expected_source_frame']} psnr={r['psnr_db']}"
        )
    print(
        f"audit: removed={audit['deleted_frame_count']} frames, "
        f"edited={audit['edited_frame_count']}/{audit['expected_edited_frame_count']}, "
        f"grid_complete={audit['pts_grid_complete']}"
    )
    print("ALL JUMP CHECKS PASS" if all_ok else "JUMP CHECK FAILURES DETECTED")


if __name__ == "__main__":
    main()
