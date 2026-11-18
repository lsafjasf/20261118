"""统一声音时间线上的节目 EDL：只切画面，音频始终走主音轨时钟。"""

from __future__ import annotations


# 以设计切点 7.10s 为基准的相对秒数与机位。构建时整体平移到共同段落起点，
# 保证 EDL 严格落在共同段落内；切换只换画面，音频走统一主时钟、不重置。
_BASE_FIRST = 7.10
_RELATIVE_CUTS = [
    (0.0, "cam_b"),
    (3.65, "cam_a"),
    (6.55, "cam_c"),
    (9.25, "cam_b"),
    (12.75, "cam_a"),
]


def program_cuts(common_in: float) -> list[dict]:
    """根据共同段落起点生成绝对时间切点（保持原 3.65/2.9/2.7/3.5 节奏）。"""
    cuts = []
    for relative_sec, camera_id in _RELATIVE_CUTS:
        cuts.append({
            "at": round(common_in + relative_sec, 3),
            "cameraId": camera_id,
        })
    return cuts


def build_segments(cuts: list[dict], out_sec: float) -> list[dict]:
    """把切点展开成带持续时间的片段，时钟连续（每段 out = 下一段 in）。"""
    boundaries = cuts + [{"at": out_sec, "cameraId": None}]
    segments = []
    for index, cut in enumerate(cuts):
        segments.append({
            "index": index + 1,
            "cameraId": cut["cameraId"],
            "timelineInSec": cut["at"],
            "timelineOutSec": round(boundaries[index + 1]["at"], 3),
        })
    for segment in segments:
        segment["durationSec"] = round(
            segment["timelineOutSec"] - segment["timelineInSec"], 3)
    return segments


def validate_segments(segments: list[dict], offsets: dict[str, float],
                      durations: dict[str, float], common_in: float,
                      common_out: float) -> list[str]:
    """校验：切点连续、每段素材在其本地时间范围内、整体落在共同段落内。"""
    problems = []
    if not segments:
        return ["节目时间线为空"]
    if abs(segments[0]["timelineInSec"] - common_in) > 1e-6:
        problems.append("首个片段起点与共同段落起点不一致")
    for previous, current in zip(segments, segments[1:]):
        if abs(previous["timelineOutSec"] - current["timelineInSec"]) > 1e-6:
            problems.append(
                f"切点不连续：{previous['cameraId']} -> {current['cameraId']}")
    if abs(segments[-1]["timelineOutSec"] - common_out) > 1e-6:
        problems.append("末段终点与共同段落终点不一致")
    for segment in segments:
        camera = segment["cameraId"]
        offset = offsets[camera]
        local_in = segment["timelineInSec"] - offset
        local_out = segment["timelineOutSec"] - offset
        if local_in < -1e-6 or local_out > durations[camera] + 1e-6:
            problems.append(
                f"{camera} 片段超出素材范围（本地 {local_in:.3f}~{local_out:.3f}s）")
    return problems
