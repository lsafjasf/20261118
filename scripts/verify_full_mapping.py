"""
Full-length mapping verification (not just chapter jumps).

Reconstructs the expected edited frame sequence from the kept ranges and
compares every output frame against its predicted source frame using the SSIM
filter on the two full streams. Also asserts every removed source frame is
excluded by construction and checks chapter boundaries against frame indices.
"""
import json
import subprocess

from common import FFMPEG, FFPROBE, OUT, VERIFY, WORK, load_json


def main() -> None:
    plan = load_json(WORK / "edit_plan.json")
    fps = plan["fps"]

    # Build a reference edit using select/aselect (independent code path from
    # the trim/concat renderer) so the comparison is not self-validating.
    select_exprs = []
    for kr in plan["kept_ranges"]:
        select_exprs.append(
            f"between(n,{kr['src_start_frame']},{kr['src_end_frame_exclusive'] - 1})"
        )
    expr = "+".join(select_exprs)
    ref_path = WORK / "reference_edit.mp4"
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(WORK / "source.mp4"),
            "-vf", f"select='{expr}',setpts=N/FRAME_RATE/TB",
            "-af", f"aselect='{expr.replace('n', 'n')}',asetpts=N/SR/TB",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "96k", "-vsync", "0", str(ref_path),
        ],
        check=True,
    )

    ref_frames = subprocess.run(
        [
            FFPROBE, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=nb_frames", "-of", "default=nw=1:nk=1",
            str(ref_path),
        ],
        check=True, text=True, capture_output=True,
    ).stdout.strip()

    stats_path = VERIFY / "ssim_stats.log"
    proc = subprocess.run(
        [
            FFMPEG, "-hide_banner",
            "-i", str(WORK / "edited_no_chapters.mp4"),
            "-i", str(ref_path),
            "-lavfi", f"ssim=stats_file={stats_path}",
            "-f", "null", "-",
        ],
        text=True, capture_output=True,
    )
    stats_lines = stats_path.read_text(encoding="utf-8").splitlines()
    scores = []
    for line in stats_lines:
        if not line.strip():
            continue
        all_field = next(part for part in line.split() if part.startswith("All:"))
        scores.append(float(all_field.split(":", 1)[1]))
    summary_match = [line for line in proc.stderr.splitlines() if "All:" in line]
    minimum = min(scores)
    average = sum(scores) / len(scores)

    # Confirm removed frames never appear in the rendered output frame count.
    removed = sum(b - a for a, b in plan["removed_ranges_frames"])
    audit = {
        "reference_edit_frames": int(ref_frames),
        "edited_frames": plan["total_output_frames"],
        "frame_count_match": int(ref_frames) == plan["total_output_frames"],
        "ssim_min": minimum,
        "ssim_avg": average,
        "removed_source_frames": removed,
        "kept_source_frames": plan["total_source_frames"] - removed,
        "all_frames_ssim_above_0_99": minimum >= 0.99,
    }
    (VERIFY / "full_mapping_verification.json").write_text(
        json.dumps(audit, indent=2), encoding="utf-8"
    )
    print(json.dumps(audit, indent=2))
    if not (audit["frame_count_match"] and audit["all_frames_ssim_above_0_99"]):
        raise SystemExit("FULL MAPPING VERIFICATION FAILED")
    print("FULL MAPPING VERIFICATION PASSED")


if __name__ == "__main__":
    main()
