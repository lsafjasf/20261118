"""End-to-end chapter remapping driver."""
import json

from common import OUT, WORK, load_json
from exporters import export_ffmetadata, export_json, export_markdown, export_mkv_xml
from map_chapters import (
    build_frame_map,
    build_kept_ranges,
    map_all_chapters,
    merge_removed_frames,
    snap_cuts,
)


def main() -> None:
    source = load_json(WORK / "source_chapters.json")
    cut_doc = load_json(WORK / "cut_list.json")
    fps = source["source_fps"]
    total_frames = int(round(source["chapters"][-1]["end"] * fps))

    snapped = snap_cuts(cut_doc["cuts"], fps)
    removed = merge_removed_frames(snapped, total_frames)
    kept_ranges = build_kept_ranges(removed, total_frames)
    frame_map = build_frame_map(kept_ranges, total_frames)
    output_total_frames = sum(kr.src_end_frame - kr.src_start_frame for kr in kept_ranges)

    chapters, removed_log = map_all_chapters(
        source["chapters"],
        snapped,
        frame_map,
        fps,
        cut_doc["policy"]["min_kept_fragment_sec"],
        output_total_frames,
    )

    OUT.mkdir(exist_ok=True)
    export_mkv_xml(chapters, OUT / "edited_chapters_mkv.xml", fps)
    export_ffmetadata(chapters, OUT / "edited_chapters_ffmetadata.txt")
    export_json(chapters, removed_log, OUT / "chapter_map.json", fps)
    export_markdown(chapters, removed_log, snapped, OUT / "chapter_mapping_report.md", fps)

    edit_plan = {
        "fps": fps,
        "total_source_frames": total_frames,
        "total_output_frames": output_total_frames,
        "output_duration_sec": output_total_frames / fps,
        "snapped_cuts": snapped,
        "removed_ranges_frames": [[a, b] for a, b in removed],
        "kept_ranges": [
            {
                "src_start_frame": kr.src_start_frame,
                "src_end_frame_exclusive": kr.src_end_frame,
                "new_start_frame": kr.new_start_frame,
            }
            for kr in kept_ranges
        ],
    }
    (WORK / "edit_plan.json").write_text(
        json.dumps(edit_plan, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"source frames={total_frames}  output frames={output_total_frames}")
    print(f"surviving chapters={len(chapters)}  removed entries={len(removed_log)}")
    for c in chapters:
        print(
            f"  #{c.index} src#{c.source_id}"
            f"{(' P' + str(c.part)) if c.part else ''}  "
            f"{c.old_start:7.3f}-{c.old_end:7.3f} -> {c.new_start:7.3f}-{c.new_end:7.3f}  "
            f"{c.titles['zh']}"
        )
    for item in removed_log:
        print(f"  REMOVED src#{item['source_id']}: {item['reason']}")


if __name__ == "__main__":
    main()
