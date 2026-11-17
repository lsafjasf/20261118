"""极简 SRT 解析器（零依赖）。"""

from __future__ import annotations

from pathlib import Path

from .model import Cue


def _parse_timestamp(value: str) -> int:
    """把 ``HH:MM:SS,mmm`` 或 ``HH:MM:SS.mmm`` 转成毫秒。"""
    value = value.strip().replace(",", ".")
    head, _, fraction = value.partition(".")
    parts = head.split(":")
    if len(parts) != 3:
        raise ValueError(f"无法解析时间戳: {value!r}")
    hours, minutes, seconds = (int(part) for part in parts)
    millis = int(fraction.ljust(3, "0")[:3]) if fraction else 0
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def parse_srt(content: str) -> list[Cue]:
    """解析 SRT 文本，返回按开始时间排序的字幕块列表。"""
    cues: list[Cue] = []
    for block in content.replace("\r\n", "\n").replace("\r", "\n").split("\n\n"):
        lines = [line for line in block.split("\n") if line.strip() != ""]
        if not lines:
            continue
        if lines[0].strip().isdigit() and "-->" in lines[1]:
            cue_id = lines[0].strip()
            timing = lines[1]
            text_lines = lines[2:]
        elif "-->" in lines[0]:
            cue_id = str(len(cues) + 1)
            timing = lines[0]
            text_lines = lines[1:]
        else:
            raise ValueError(f"无法识别的 SRT 块: {block!r}")
        start_text, _, end_text = timing.partition("-->")
        start_ms = _parse_timestamp(start_text)
        end_ms = _parse_timestamp(end_text)
        if end_ms <= start_ms:
            raise ValueError(f"字幕 {cue_id} 结束时间不晚于开始时间")
        cues.append(Cue(cue_id, start_ms, end_ms, "\n".join(text_lines).strip()))
    cues.sort(key=lambda cue: cue.start_ms)
    return cues


def load_srt(path: str | Path) -> list[Cue]:
    return parse_srt(Path(path).read_text(encoding="utf-8-sig"))
