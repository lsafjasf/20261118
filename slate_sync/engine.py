"""同步引擎：起音检测 -> 场记板峰对齐 -> 包络相关复核 -> 手动微调 -> 验证。"""

from __future__ import annotations

import json
import os

from . import dsp
from .wavio import read_wav

THRESHOLD_MS = 5.0

ROLES = {
    "recorder": "独立录音 / 主音轨",
    "cam_a": "广角机位",
    "cam_b": "左侧中景",
    "cam_c": "右侧特写",
}


def load_manifest(media_dir: str) -> dict:
    path = os.path.join(os.path.dirname(media_dir), "media_manifest.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    raise FileNotFoundError("缺少 media_manifest.json，请先生成测试素材")


class SyncEngine:
    def __init__(self, media_dir: str, master_id: str = "recorder"):
        self.media_dir = media_dir
        self.manifest = load_manifest(media_dir)
        self.sample_rate = self.manifest["sampleRate"]
        self.master_id = master_id
        self.tracks: dict[str, dict] = {}
        self._audio_cache: dict[str, list[float]] = {}

    def _audio(self, track_id: str) -> list[float]:
        if track_id not in self._audio_cache:
            entry = self._entry(track_id)
            path = os.path.join(os.path.dirname(self.media_dir), entry["audio"])
            samples, rate = read_wav(path)
            if rate != self.sample_rate:
                raise ValueError(f"{track_id} 采样率 {rate} 与工程 {self.sample_rate} 不一致")
            self._audio_cache[track_id] = samples
        return self._audio_cache[track_id]

    def _entry(self, track_id: str) -> dict:
        for entry in self.manifest["tracks"]:
            if entry["id"] == track_id:
                return entry
        raise KeyError(track_id)

    def analyze(self) -> dict:
        """检测全部轨道：主轨定基准，其余轨道按场记板峰求偏移并做包络复核。"""
        master_pick = dsp.pick_slate(self._audio(self.master_id), self.sample_rate)
        master_peak = master_pick["slatePeakSec"]
        for entry in self.manifest["tracks"]:
            track_id = entry["id"]
            audio = self._audio(track_id)
            pick = dsp.pick_slate(audio, self.sample_rate)
            record = {
                "id": track_id,
                "name": track_id.upper().replace("_", " "),
                "role": ROLES.get(track_id, entry.get("role", "")),
                "kind": "audio" if entry.get("video") is None else "camera",
                "durationSec": entry["durationSec"],
                "audioPath": entry["audio"],
                "videoPath": entry.get("video"),
                "sampleRate": self.sample_rate,
                "onsetEvents": pick["onsets"],
                "slateLocalSec": pick["slate"]["time"],
                "slateStrength": pick["slate"]["strength"],
                "slatePeakSec": pick["slatePeakSec"],
                "manualNudgeMs": 0.0,
            }
            if track_id == self.master_id:
                record.update({
                    "autoOffsetSec": 0.0,
                    "correlation": 1.0,
                    "confidence": 1.0,
                    "masterSlateSec": master_peak,
                })
            else:
                # 第一阶段（权威结果）：场记板脉冲峰样本级对齐
                peak_offset = master_peak - pick["slatePeakSec"]
                # 第二阶段（置信度复核）：包络网格相关，限定在峰对齐附近 ±40ms
                coarse_lag = round(peak_offset * self.sample_rate)
                lag, correlation = dsp.envelope_lag(
                    self._audio(self.master_id), audio, self.sample_rate,
                    coarse_lag, search_ms=40.0)
                record.update({
                    "autoOffsetSec": peak_offset,
                    "peakOffsetSec": peak_offset,
                    "envelopeLagSec": lag / self.sample_rate,
                    "correlation": correlation,
                    "confidence": min(1.0, 0.95 + 0.05 * correlation),
                })
            self.tracks[track_id] = record
        self._compute_base_segment()
        return self.tracks

    def set_nudge(self, track_id: str, nudge_ms: float) -> None:
        """手动微调（毫秒），最终偏移 = 自动偏移 + 微调；主轨不允许移动。"""
        if track_id == self.master_id:
            raise ValueError("主音轨是统一时间线基准，不能微调")
        self.tracks[track_id]["manualNudgeMs"] = float(nudge_ms)

    def final_offset_sec(self, track_id: str) -> float:
        record = self.tracks[track_id]
        if track_id == self.master_id:
            return 0.0
        return record["autoOffsetSec"] + record["manualNudgeMs"] / 1000.0

    def _compute_base_segment(self) -> None:
        """自动对齐后的轨道交集，即锁定的成片共同段落（微调不改变它）。"""
        starts, ends = [], []
        for record in self.tracks.values():
            offset = record.get("autoOffsetSec", 0.0)
            starts.append(offset)
            ends.append(offset + record["durationSec"])
        self.common_in = max(starts)
        self.common_out = min(ends)

    def _apply_common_segment(self) -> None:
        """共同段落在分析阶段已锁定；保留空实现以表达微调不移动时间线。"""
        return

    def verify(self, windows_per_track: int = 3) -> dict:
        """在共同段落内对每个机位做多点包络延迟验证。"""
        self._apply_common_segment()
        master = self._audio(self.master_id)
        span = self.common_out - self.common_in
        # 优先围绕主轨检测到的真实节目起音取窗，保证窗内有可对齐瞬态
        master_record = self.tracks[self.master_id]
        event_times = [event["time"] for event in master_record["onsetEvents"]
                       if self.common_in + 0.5 < event["time"] < self.common_out - 0.5]
        if len(event_times) >= windows_per_track:
            pick_index = [int((i + 1) * len(event_times) / (windows_per_track + 1))
                          for i in range(windows_per_track)]
            centers = [event_times[index] for index in pick_index]
        else:
            centers = [self.common_in + span * fraction
                       for fraction in (0.25, 0.5, 0.75)][:windows_per_track]
        per_track = []
        all_errors = []
        window_sec = 1.0
        for track_id, record in self.tracks.items():
            if track_id == self.master_id:
                continue
            target = self._audio(track_id)
            final_lag = round(self.final_offset_sec(track_id) * self.sample_rate)
            errors = []
            for center in centers:
                ref_lo = int((center - window_sec / 2) * self.sample_rate)
                ref_hi = int((center + window_sec / 2) * self.sample_rate)
                ref_window = master[max(0, ref_lo):ref_hi]
                tgt_lo = ref_lo - final_lag
                tgt_hi = ref_hi - final_lag
                if tgt_lo < 0 or tgt_hi > len(target):
                    continue
                tgt_window = target[tgt_lo:tgt_hi]
                residual = dsp.residual_lag_ms(ref_window, tgt_window,
                                                self.sample_rate, 0,
                                                search_ms=25.0)
                errors.append(abs(residual))
            if not errors:
                continue
            mean_error = sum(errors) / len(errors)
            max_error = max(errors)
            all_errors.extend(errors)
            per_track.append({
                "trackId": track_id,
                "name": record["name"],
                "comparedWindows": len(errors),
                "meanErrorMs": round(mean_error, 3),
                "maxErrorMs": round(max_error, 3),
                "status": "pass" if max_error <= THRESHOLD_MS else "fail",
            })
        longest = max(self.tracks.values(), key=lambda item: item["durationSec"])
        passed = bool(all_errors) and max(all_errors) <= THRESHOLD_MS
        ordered = sorted(all_errors)
        p95_index = min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))
        return {
            "longestTrackId": longest["id"],
            "longestTrackName": longest["name"],
            "longestDurationSec": longest["durationSec"],
            "commonInSec": round(self.common_in, 3),
            "commonOutSec": round(self.common_out, 3),
            "commonDurationSec": round(self.common_out - self.common_in, 3),
            "comparedWindows": len(all_errors),
            "meanErrorMs": round(sum(all_errors) / len(all_errors), 3),
            "p95ErrorMs": round(ordered[p95_index], 3),
            "maxErrorMs": round(max(all_errors), 3),
            "thresholdMs": THRESHOLD_MS,
            "passed": passed,
            "perTrack": per_track,
        }
