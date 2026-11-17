"""Round-trip test: re-import the generated chapter files into a clean video."""
import json
import subprocess

from common import FFMPEG, FFPROBE, OUT, VERIFY, WORK, load_json


def probe_chapters(video: str) -> list[dict]:
    proc = subprocess.run(
        [
            FFPROBE, "-v", "error",
            "-show_entries", "chapter=start_time,end_time:chapter_tags=title",
            "-of", "json", video,
        ],
        check=True, text=True, capture_output=True,
    )
    return json.loads(proc.stdout).get("chapters", [])


def main() -> None:
    clean = WORK / "edited_no_chapters.mp4"
    metadata = OUT / "edited_chapters_ffmetadata.txt"
    roundtrip_mp4 = VERIFY / "roundtrip_reimported.mp4"
    roundtrip_mkv = VERIFY / "roundtrip_reimported.mkv"

    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(clean), "-i", str(metadata),
            "-map_metadata", "1", "-c", "copy", str(roundtrip_mp4),
        ],
        check=True,
    )
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(clean), "-i", str(metadata),
            "-map", "0", "-map_metadata", "1",
            "-c:v", "copy", "-c:a", "flac", str(roundtrip_mkv),
        ],
        check=True,
    )

    expected = load_json(OUT / "chapter_map.json")["chapters"]
    report = {}
    for name, path in (("mp4", roundtrip_mp4), ("mkv", roundtrip_mkv)):
        actual = probe_chapters(str(path))
        checks = []
        for exp, got in zip(expected, actual):
            checks.append(
                {
                    "index": exp["index"],
                    "expected_start_sec": exp["new_time"]["start_sec"],
                    "imported_start_sec": float(got["start_time"]),
                    "start_match": abs(
                        float(got["start_time"]) - exp["new_time"]["start_sec"]
                    ) <= 0.002,
                    "title": got["tags"].get("title", ""),
                }
            )
        report[name] = {
            "chapter_count": len(actual),
            "count_match": len(actual) == len(expected),
            "checks": checks,
        }

    (VERIFY / "reimport_verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    ok = True
    for name, data in report.items():
        starts_ok = all(item["start_match"] for item in data["checks"])
        ok = ok and data["count_match"] and starts_ok
        print(f"{name}: chapters={data['chapter_count']} starts_ok={starts_ok}")
    print("RE-IMPORT ROUND TRIP PASSED" if ok else "RE-IMPORT ROUND TRIP FAILED")
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
