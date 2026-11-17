"""Writers for re-importable chapter files and the human-readable report."""
import json
from pathlib import Path

from common import hms
from map_chapters import MappedChapter


def export_mkv_xml(chapters: list[MappedChapter], path: Path, fps: int) -> None:
    def ms(seconds: float) -> int:
        return int(round(seconds * 1000))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<Chapters>", '<EditionEntry>']
    for chapter in chapters:
        lines.append("<ChapterAtom>")
        lines.append(f"  <ChapterTimeStart>{hms(chapter.new_start)}</ChapterTimeStart>")
        lines.append(f"  <ChapterTimeEnd>{hms(chapter.new_end)}</ChapterTimeEnd>")
        lines.append("  <ChapterFlagHidden>0</ChapterFlagHidden>")
        lines.append("  <ChapterFlagEnabled>1</ChapterFlagEnabled>")
        for lang, title in chapter.titles.items():
            suffix = f" (P{chapter.part})" if chapter.part else ""
            lines.append("  <ChapterDisplay>")
            lines.append(f"    <ChapterString>{title}{suffix}</ChapterString>")
            lines.append(f"    <ChapterLanguage>{lang}</ChapterLanguage>")
            lines.append("  </ChapterDisplay>")
        lines.append("</ChapterAtom>")
    lines.append("</EditionEntry>")
    lines.append("</Chapters>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_ffmetadata(chapters: list[MappedChapter], path: Path) -> None:
    lines = [";FFMETADATA1", "; re-import with: ffmpeg -i video -i metadata.txt -map_metadata 1 -c copy out"]
    for chapter in chapters:
        suffix = f" (P{chapter.part})" if chapter.part else ""
        lines.extend(
            [
                "[CHAPTER]",
                "TIMEBASE=1/1000",
                f"START={int(round(chapter.new_start * 1000))}",
                f"END={int(round(chapter.new_end * 1000))}",
                f"title={chapter.titles.get('zh', next(iter(chapter.titles.values())))}{suffix}",
                f"title-en={chapter.titles.get('en', '')}",
                f"title-ja={chapter.titles.get('ja', '')}",
                "languages=" + ",".join(chapter.languages),
                f"source-chapter-id={chapter.source_id}",
            ]
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_json(chapters: list[MappedChapter], removed: list[dict], path: Path, fps: int) -> None:
    payload = {
        "format": "re-importable-chapter-map/v1",
        "fps": fps,
        "chapters": [
            {
                "index": c.index,
                "source_chapter_id": c.source_id,
                "part": c.part,
                "old_time": {
                    "start_sec": round(c.old_start, 6),
                    "end_sec": round(c.old_end, 6),
                    "start_frame": int(round(c.old_start * fps)),
                    "end_frame_exclusive": int(round(c.old_end * fps)),
                },
                "new_time": {
                    "start_sec": round(c.new_start, 6),
                    "end_sec": round(c.new_end, 6),
                    "start_frame": int(round(c.new_start * fps)),
                    "end_frame_exclusive": int(round(c.new_end * fps)),
                },
                "titles": c.titles,
                "languages": c.languages,
                "status": c.status,
                "change_reasons": c.reasons,
            }
            for c in chapters
        ],
        "removed_chapters_or_fragments": removed,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def export_markdown(
    chapters: list[MappedChapter],
    removed: list[dict],
    snapped_cuts: list[dict],
    path: Path,
    fps: int,
) -> None:
    lines = [
        "# 章节映射对照表",
        "",
        "## 剪辑点（输入秒数 → 吸附到最近合法帧）",
        "",
        "| 剪辑点 | 原始起止(s) | 吸附后源帧 | 吸附后时间 | 起始Δ(s) | 结束Δ(s) | 原因 |",
        "|---|---|---|---|---|---|---|",
    ]
    for cut in snapped_cuts:
        lines.append(
            f"| {cut['id']} | {cut['start']:.2f}–{cut['end']:.2f} | "
            f"{cut['start_frame']}–{cut['end_frame']} | "
            f"{hms(cut['start_snapped'])}–{hms(cut['end_snapped'])} | "
            f"{cut['start_delta']:+.3f} | {cut['end_delta']:+.3f} | {cut['reason']} |"
        )
    lines += [
        "",
        "## 存活章节：旧时间 → 新时间",
        "",
        "| # | 源章节 | 旧时间(源帧) | 新时间(成片帧) | 标题(zh/en/ja) | 状态 | 变更原因 |",
        "|---|---|---|---|---|---|---|",
    ]
    for c in chapters:
        part = f"#{c.source_id}" + (f" P{c.part}" if c.part else "")
        old = f"{hms(c.old_start)}–{hms(c.old_end)} ({int(round(c.old_start * fps))}–{int(round(c.old_end * fps))})"
        new = f"{hms(c.new_start)}–{hms(c.new_end)} ({int(round(c.new_start * fps))}–{int(round(c.new_end * fps))})"
        titles = " / ".join(c.titles.values())
        lines.append(
            f"| {c.index} | {part} | {old} | {new} | {titles} | {c.status} | {'；'.join(c.reasons)} |"
        )
    lines += ["", "## 已删除章节 / 碎片", "", "| 源章节 | 旧时间 | 原因 |", "|---|---|---|"]
    for item in removed:
        old = f"{hms(item['old_start'])}–{hms(item['old_end'])}"
        title = item["titles"].get("zh", "")
        lines.append(f"| #{item['source_id']} {title} | {old} | {item['reason']} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
