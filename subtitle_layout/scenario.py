"""场景文件加载：画布、字幕轨、多语言组合。

场景 JSON 示例见 examples/。字幕内容可内联（cues）或引用外部 SRT 文件
（srt 路径相对场景文件解析）。
"""

from __future__ import annotations

import json
from pathlib import Path

from .model import Canvas, Cue, ReadingDirection, SafeMargin, Slot, Track, TrackStyle
from .srt import parse_srt

# ISO 639-1 语言代码 -> 默认阅读方向
LANGUAGE_DIRECTIONS: dict[str, ReadingDirection] = {
    "ar": ReadingDirection.RTL,
    "he": ReadingDirection.RTL,
    "fa": ReadingDirection.RTL,
    "ur": ReadingDirection.RTL,
    "yi": ReadingDirection.RTL,
    "ja": ReadingDirection.LTR,
    "zh": ReadingDirection.LTR,
    "zh_hans": ReadingDirection.LTR,
    "zh_hant": ReadingDirection.LTR,
    "ko": ReadingDirection.LTR,
}

RTL_LANGUAGES = set(LANGUAGE_DIRECTIONS)


def direction_for_language(language: str) -> ReadingDirection:
    return LANGUAGE_DIRECTIONS.get(language.lower().replace("-", "_"), ReadingDirection.LTR)


def _build_style(raw: dict | None) -> TrackStyle:
    if not raw:
        return TrackStyle()
    return TrackStyle(
        font_size=raw.get("font_size", 48),
        line_gap=raw.get("line_gap", 8),
        pad_x=raw.get("pad_x", 16),
        pad_y=raw.get("pad_y", 12),
        max_width_ratio=raw.get("max_width_ratio", 0.82),
    )


def _build_cues(raw: dict, base_dir: Path) -> list[Cue]:
    if "srt" in raw:
        srt_path = (base_dir / raw["srt"]).resolve()
        return parse_srt(srt_path.read_text(encoding="utf-8-sig"))
    cues = []
    for index, item in enumerate(raw.get("cues", []), start=1):
        cues.append(
            Cue(
                cue_id=str(item.get("id", index)),
                start_ms=item["start_ms"],
                end_ms=item["end_ms"],
                text=item["text"],
            )
        )
    cues.sort(key=lambda cue: cue.start_ms)
    return cues


def _build_track(raw: dict, base_dir: Path) -> Track:
    direction_raw = raw.get("direction")
    direction = (
        ReadingDirection(direction_raw)
        if direction_raw
        else direction_for_language(raw["language"])
    )
    return Track(
        name=raw["name"],
        language=raw["language"],
        direction=direction,
        style=_build_style(raw.get("style")),
        cues=_build_cues(raw, base_dir),
    )


def load_canvas(raw: dict | None) -> Canvas:
    if not raw:
        return Canvas()
    margin_raw = raw.get("safe_margin", {})
    margin = SafeMargin(
        top=margin_raw.get("top", 80),
        right=margin_raw.get("right", 96),
        bottom=margin_raw.get("bottom", 120),
        left=margin_raw.get("left", 96),
    )
    return Canvas(
        width=raw.get("width", 1920),
        height=raw.get("height", 1080),
        safe_margin=margin,
    )


def load_scenario(path: str | Path) -> dict:
    """加载场景文件，返回可直接交给分析流程的结构化字典。"""
    scenario_path = Path(path).resolve()
    data = json.loads(scenario_path.read_text(encoding="utf-8"))
    base_dir = scenario_path.parent
    canvas = load_canvas(data.get("canvas"))
    primary = _build_track(data["primary"], base_dir)

    combinations: list[dict] = []
    for combo in data.get("combinations", []):
        translation_raw = combo["translation"]
        translation = _build_track(translation_raw, base_dir)
        lock_primary = combo.get("lock_primary", data.get("lock_primary", False))
        preferred_slot = Slot(
            combo.get(
                "primary_slot",
                data.get("primary_slot", "bottom"),
            )
        )
        combinations.append(
            {
                "name": combo["name"],
                "translation": translation,
                "lock_primary": lock_primary,
                "primary_slot": preferred_slot,
            }
        )
    return {
        "name": data.get("name", scenario_path.stem),
        "canvas": canvas,
        "slot_gap": data.get("canvas", {}).get("slot_gap", 24),
        "max_stagger_ms": data.get("max_stagger_ms", 1500),
        "primary": primary,
        "combinations": combinations,
    }
