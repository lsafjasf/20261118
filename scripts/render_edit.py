"""Render the edited video from explicit kept frame ranges and mux chapters."""
import json

from common import FFMPEG, OUT, WORK, load_json, run


def main() -> None:
    plan = load_json(WORK / "edit_plan.json")
    fps = plan["fps"]
    kept = plan["kept_ranges"]

    parts: list[str] = []
    filter_parts: list[str] = []
    for index, kr in enumerate(kept):
        start = kr["src_start_frame"] / fps
        end = kr["src_end_frame_exclusive"] / fps
        parts.append(f"[0:v]trim=start_frame={kr['src_start_frame']}:end_frame={kr['src_end_frame_exclusive']},setpts=PTS-STARTPTS[v{index}];")
        parts.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{index}];")
        filter_parts.append(f"[v{index}][a{index}]")
    parts.append(
        "".join(filter_parts)
        + f"concat=n={len(kept)}:v=1:a=1[vout][aout]"
    )
    filter_script = WORK / "trim_filter.txt"
    filter_script.write_text("".join(parts), encoding="utf-8")

    run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(WORK / "source.mp4"),
            "-filter_complex_script", str(filter_script),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", "96k",
            str(WORK / "edited_no_chapters.mp4"),
        ]
    )

    run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(WORK / "edited_no_chapters.mp4"),
            "-i", str(OUT / "edited_chapters_ffmetadata.txt"),
            "-map_metadata", "1", "-c", "copy",
            str(OUT / "edited_with_chapters.mp4"),
        ]
    )
    run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(WORK / "edited_no_chapters.mp4"),
            "-i", str(OUT / "edited_chapters_ffmetadata.txt"),
            "-map", "0", "-map_metadata", "1",
            "-c:v", "copy", "-c:a", "flac", "-compression_level", "8",
            str(OUT / "edited_with_chapters.mkv"),
        ]
    )
    print("rendered edited_no_chapters.mp4, edited_with_chapters.mp4/.mkv")
    print("note: edited_chapters_mkv.xml is the mkvmerge re-import format")


if __name__ == "__main__":
    main()
