"""同步矩阵与校验报告导出（JSON 全量报告 + CSV 矩阵）。"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timezone

from .engine import THRESHOLD_MS
from .timeline import build_segments, program_cuts


def build_report(engine, project: str = "SLATE PULSE / DEMO 0067") -> dict:
    verification = engine.verify()
    common_in = verification["commonInSec"]
    common_out = verification["commonOutSec"]
    cuts = program_cuts(common_in)
    segments = build_segments(cuts, common_out)

    offsets = {track_id: engine.final_offset_sec(track_id)
               for track_id in engine.tracks}
    durations = {track_id: record["durationSec"]
                 for track_id, record in engine.tracks.items()}

    matrix = []
    tracks_payload = []
    order = [engine.master_id] + [
        entry["id"] for entry in engine.manifest["tracks"]
        if entry["id"] != engine.master_id]
    for track_id in order:
        record = engine.tracks[track_id]
        final_ms = round(engine.final_offset_sec(track_id) * 1000, 3)
        auto_ms = round(record.get("autoOffsetSec", 0.0) * 1000, 3)
        matrix.append({
            "trackId": track_id,
            "name": record["name"],
            "role": record["role"],
            "type": record["kind"],
            "file": record["audioPath"],
            "videoReference": record["videoPath"] or "",
            "durationMs": round(record["durationSec"] * 1000),
            "sampleRateHz": record["sampleRate"],
            "slateLocalMs": round(record["slatePeakSec"] * 1000, 3),
            "autoOffsetMs": auto_ms,
            "manualNudgeMs": record["manualNudgeMs"],
            "finalOffsetMs": final_ms,
            "correlation": round(record.get("correlation", 1.0), 5),
            "confidencePct": round(record.get("confidence", 1.0) * 100, 1),
            "commonInMs": round(common_in * 1000),
            "commonOutMs": round(common_out * 1000),
            "status": "master" if track_id == engine.master_id else "auto",
        })
        tracks_payload.append(_track_payload(record, engine, track_id))

    return {
        "project": project,
        "masterTrackId": engine.master_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sampleRate": engine.sample_rate,
        "thresholdMs": THRESHOLD_MS,
        "commonInSec": common_in,
        "commonOutSec": common_out,
        "commonDurationSec": verification["commonDurationSec"],
        "programCuts": cuts,
        "programSegments": segments,
        "timelinePolicy": "统一主音轨时钟；切换机位仅替换画面参考，音频不重置、不重放",
        "tracks": tracks_payload,
        "verification": verification,
        "matrix": matrix,
    }


def _track_payload(record: dict, engine, track_id: str) -> dict:
    payload = {
        "id": track_id,
        "name": record["name"],
        "role": record["role"],
        "kind": record["kind"],
        "duration": record["durationSec"],
        "sampleRate": record["sampleRate"],
        "audioPath": record["audioPath"],
        "videoPath": record["videoPath"],
        "finalOffsetSec": round(engine.final_offset_sec(track_id), 6),
        "autoOffsetSec": round(record.get("autoOffsetSec", 0.0), 6),
        "manualNudgeMs": record["manualNudgeMs"],
        "correlation": round(record.get("correlation", 1.0), 6),
        "confidence": round(record.get("confidence", 1.0), 6),
        "analysis": {
            "slateLocalSec": record["slateLocalSec"],
            "slatePeakSec": round(record["slatePeakSec"], 6),
            "slateStrength": record["slateStrength"],
            "onsetEventCount": len(record["onsetEvents"]),
            "onsetEvents": record["onsetEvents"],
        },
    }
    if "peakOffsetSec" in record:
        payload["analysis"]["peakOffsetSec"] = round(record["peakOffsetSec"], 6)
    return payload


def write_json(report: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)


MATRIX_COLUMNS = [
    ("trackId", "轨道"),
    ("name", "名称"),
    ("role", "角色"),
    ("type", "类型"),
    ("file", "音频文件"),
    ("videoReference", "视频参考"),
    ("durationMs", "时长(ms)"),
    ("slateLocalMs", "场记板本地(ms)"),
    ("autoOffsetMs", "自动偏移(ms)"),
    ("manualNudgeMs", "手动微调(ms)"),
    ("finalOffsetMs", "最终偏移(ms)"),
    ("correlation", "相关系数"),
    ("confidencePct", "置信度(%)"),
    ("commonInMs", "共同段入(ms)"),
    ("commonOutMs", "共同段出(ms)"),
    ("status", "状态"),
]


def write_csv_matrix(report: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([label for _, label in MATRIX_COLUMNS])
        for row in report["matrix"]:
            writer.writerow([row[key] for key, _ in MATRIX_COLUMNS])
