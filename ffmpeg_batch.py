#!/usr/bin/env python3
"""Two-stage FFmpeg batch transcoder with reviewable manifests and per-file logs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = 1
VIDEO_EXTENSIONS = {
    ".3gp",
    ".avi",
    ".flv",
    ".m2ts",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".ogv",
    ".ts",
    ".webm",
    ".wmv",
}


class BatchError(RuntimeError):
    """A configuration or environment error that should stop the command."""


class ProbeError(RuntimeError):
    """A source-specific probe error that should not stop the batch."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def format_bytes(value: int | float | None) -> str:
    if value is None:
        return "n/a"
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(size) < 1024 or unit == "TiB":
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} TiB"


def format_bitrate(value: int | float | None) -> str:
    if value is None:
        return "n/a"
    return f"{float(value) / 1_000_000:.3f} Mb/s"


def format_seconds(value: int | float | None) -> str:
    if value is None:
        return "n/a"
    seconds = max(0.0, float(value))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours >= 1:
        return f"{int(hours)}h {int(minutes)}m {seconds:.2f}s"
    if minutes >= 1:
        return f"{int(minutes)}m {seconds:.2f}s"
    return f"{seconds:.2f}s"


def to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_fraction(value: Any) -> float | None:
    if value in (None, "", "0/0"):
        return None
    text = str(value)
    if "/" not in text:
        return to_float(text)
    numerator, denominator = text.split("/", 1)
    top = to_float(numerator)
    bottom = to_float(denominator)
    if top is None or bottom in (None, 0):
        return None
    return top / bottom


def clean_text(value: Any) -> str:
    return re.sub(r"[\r\n]+", " ", str(value or "")).strip()


def safe_task_id(relative_path: str) -> str:
    digest = hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:8]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(relative_path).stem).strip("._-")
    return f"{(stem or 'video')[:42]}-{digest}"


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def write_json_atomic(path: Path, payload: Any) -> None:
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def resolve_tool(explicit: str | None, env_name: str, default_name: str) -> str:
    candidate = explicit or os.environ.get(env_name) or shutil.which(default_name)
    if not candidate:
        raise BatchError(
            f"找不到 {default_name}；请安装 FFmpeg，或用 --{default_name} / "
            f"环境变量 {env_name} 指定路径。"
        )
    resolved = shutil.which(candidate) or (
        candidate if Path(candidate).is_file() and os.access(candidate, os.X_OK) else None
    )
    if not resolved:
        raise BatchError(f"{default_name} 路径不可执行：{candidate}")
    return str(Path(resolved).resolve())


@dataclass
class VideoInfo:
    codec_name: str
    width: int
    height: int
    display_width: int
    display_height: int
    rotation_degrees: int
    fps: float | None
    avg_frame_rate: str
    r_frame_rate: str
    pixel_format: str
    sample_aspect_ratio: str
    bit_rate_bps: int | None
    duration_seconds: float | None
    frame_count: int | None


@dataclass
class AudioInfo:
    index: int
    codec_name: str
    channels: int | None
    channel_layout: str
    sample_rate_hz: int | None
    bit_rate_bps: int | None
    language: str
    title: str


@dataclass
class SourceInfo:
    path: str
    size_bytes: int
    mtime_ns: int
    format_name: str
    format_long_name: str
    duration_seconds: float
    bit_rate_bps: int
    video: VideoInfo
    audio_streams: list[AudioInfo] = field(default_factory=list)


@dataclass
class EncodeConfig:
    width: int
    height: int
    fps: float
    fit: str
    fps_mode: str
    video_codec: str
    rate_control: str
    video_bitrate: str
    crf: int
    preset: str
    pixel_format: str
    audio_mode: str
    audio_codec: str
    audio_bitrate: str


def probe_source(ffprobe: str, source: Path, log_path: Path) -> SourceInfo:
    command = [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(source),
    ]
    result = subprocess.run(command, capture_output=True, text=True, errors="replace")
    log_body = (
        f"# command: {shlex.join(command)}\n"
        f"# exit_code: {result.returncode}\n"
        f"# stdout:\n{result.stdout}\n"
        f"# stderr:\n{result.stderr}\n"
    )
    write_text_atomic(log_path, log_body)
    if result.returncode != 0:
        detail = clean_text(result.stderr.splitlines()[-1] if result.stderr.splitlines() else "")
        raise ProbeError(detail or f"ffprobe 退出码 {result.returncode}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe 返回了无效 JSON：{exc}") from exc

    streams = payload.get("streams") or []
    video_streams = [
        stream
        for stream in streams
        if stream.get("codec_type") == "video"
        and not bool((stream.get("disposition") or {}).get("attached_pic"))
    ]
    if not video_streams:
        raise ProbeError("未找到可转码的视频流")
    video_stream = video_streams[0]
    format_info = payload.get("format") or {}

    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ProbeError("视频流缺少有效宽高")

    rotation = 0
    for side_data in video_stream.get("side_data_list") or []:
        if side_data.get("rotation") is not None:
            rotation = int(round(float(side_data["rotation"])))
            break
    else:
        tags = video_stream.get("tags") or {}
        if tags.get("rotate") is not None:
            rotation = int(round(float(tags["rotate"])))
    rotation %= 360

    display_width, display_height = width, height
    if rotation in (90, 270):
        display_width, display_height = height, width

    avg_fps = parse_fraction(video_stream.get("avg_frame_rate"))
    r_fps = parse_fraction(video_stream.get("r_frame_rate"))
    fps = avg_fps or r_fps
    if not fps or fps <= 0:
        raise ProbeError("无法读取有效帧率")

    duration = to_float(format_info.get("duration"))
    if duration is None:
        duration = to_float(video_stream.get("duration"))
    if duration is None or duration <= 0:
        raise ProbeError("无法读取有效时长")

    size_bytes = source.stat().st_size
    bit_rate = to_float(format_info.get("bit_rate"))
    if bit_rate is None or bit_rate <= 0:
        bit_rate = size_bytes * 8 / duration

    audio_streams: list[AudioInfo] = []
    for stream in streams:
        if stream.get("codec_type") != "audio":
            continue
        tags = stream.get("tags") or {}
        audio_streams.append(
            AudioInfo(
                index=int(stream.get("index") or 0),
                codec_name=str(stream.get("codec_name") or "unknown"),
                channels=int(stream["channels"]) if stream.get("channels") else None,
                channel_layout=str(stream.get("channel_layout") or ""),
                sample_rate_hz=int(stream["sample_rate"]) if stream.get("sample_rate") else None,
                bit_rate_bps=int(stream["bit_rate"]) if stream.get("bit_rate") else None,
                language=str(tags.get("language") or ""),
                title=str(tags.get("title") or ""),
            )
        )

    video = VideoInfo(
        codec_name=str(video_stream.get("codec_name") or "unknown"),
        width=width,
        height=height,
        display_width=display_width,
        display_height=display_height,
        rotation_degrees=rotation,
        fps=fps,
        avg_frame_rate=str(video_stream.get("avg_frame_rate") or ""),
        r_frame_rate=str(video_stream.get("r_frame_rate") or ""),
        pixel_format=str(video_stream.get("pix_fmt") or ""),
        sample_aspect_ratio=str(video_stream.get("sample_aspect_ratio") or ""),
        bit_rate_bps=int(video_stream["bit_rate"]) if video_stream.get("bit_rate") else None,
        duration_seconds=to_float(video_stream.get("duration")),
        frame_count=int(video_stream["nb_frames"]) if video_stream.get("nb_frames") else None,
    )
    return SourceInfo(
        path=str(source.resolve()),
        size_bytes=size_bytes,
        mtime_ns=source.stat().st_mtime_ns,
        format_name=str(format_info.get("format_name") or ""),
        format_long_name=str(format_info.get("format_long_name") or ""),
        duration_seconds=duration,
        bit_rate_bps=int(round(bit_rate)),
        video=video,
        audio_streams=audio_streams,
    )


def ratio_value(value: str) -> float | None:
    if not value or value in ("0:1", "0/1"):
        return None
    separator = ":" if ":" in value else "/"
    if separator not in value:
        return to_float(value)
    left, right = value.split(separator, 1)
    numerator = to_float(left)
    denominator = to_float(right)
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def even_floor(value: float) -> int:
    return max(2, int(math.floor(value / 2.0)) * 2)


def even_ceil(value: float) -> int:
    return max(2, int(math.ceil(value / 2.0)) * 2)


def fps_text(fps: float) -> str:
    return str(int(fps)) if abs(fps - round(fps)) < 0.0001 else f"{fps:.6g}"


def audio_field(audio: Any, name: str, default: Any = None) -> Any:
    if isinstance(audio, dict):
        return audio.get(name, default)
    return getattr(audio, name, default)


def audio_summary(audio_streams: Sequence[AudioInfo | dict[str, Any]]) -> str:
    if not audio_streams:
        return "无音轨"
    parts: list[str] = []
    for audio in audio_streams:
        sample_rate = audio_field(audio, "sample_rate_hz")
        channel_count = audio_field(audio, "channels")
        channel_layout = audio_field(audio, "channel_layout", "")
        bit_rate = audio_field(audio, "bit_rate_bps")
        codec_name = audio_field(audio, "codec_name", "unknown")
        rate = f"{sample_rate / 1000:g} kHz" if sample_rate else "采样率未知"
        channels = f"{channel_count}ch" if channel_count else (channel_layout or "声道未知")
        bitrate = f" {format_bitrate(bit_rate)}" if bit_rate else ""
        parts.append(f"{codec_name} {rate} {channels}{bitrate}")
    suffix = f" ×{len(parts)}" if len(parts) > 1 else ""
    return "; ".join(parts) + suffix


def build_transform(source: SourceInfo, config: EncodeConfig) -> dict[str, Any]:
    video = source.video
    target_width, target_height = config.width, config.height
    display_width, display_height = video.display_width, video.display_height
    filters: list[str] = []
    warnings: list[str] = []

    source_ratio = display_width / display_height
    target_ratio = target_width / target_height
    exact_ratio = abs(source_ratio - target_ratio) < 0.0005
    scaled_width = target_width
    scaled_height = target_height
    bars_horizontal = 0
    bars_vertical = 0
    crop_horizontal = 0
    crop_vertical = 0

    source_sar = ratio_value(video.sample_aspect_ratio)
    if source_sar is not None and abs(source_sar - 1.0) > 0.0005:
        filters.append("scale=trunc(iw*sar/2)*2:ih")
        filters.append("setsar=1")
        warnings.append(
            f"源像素宽高比 SAR={video.sample_aspect_ratio or 'unknown'}，先归一化为方形像素。"
        )

    if exact_ratio:
        filters.append(f"scale={target_width}:{target_height}:flags=lanczos")
        filters.append("setsar=1")
        size_action = (
            f"等比缩放 {display_width}x{display_height} → {target_width}x{target_height}；"
            "不裁切、不留黑边"
        )
    elif config.fit == "pad":
        factor = min(target_width / display_width, target_height / display_height)
        scaled_width = even_floor(display_width * factor)
        scaled_height = even_floor(display_height * factor)
        scaled_width = min(scaled_width, target_width)
        scaled_height = min(scaled_height, target_height)
        bars_horizontal = max(0, target_width - scaled_width)
        bars_vertical = max(0, target_height - scaled_height)
        filters.append(
            f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease:"
            "force_divisible_by=2:flags=lanczos"
        )
        filters.append("setsar=1")
        filters.append(
            f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
        bar_side = "左右" if bars_horizontal else "上下"
        bar_pixels = bars_horizontal or bars_vertical
        size_action = (
            f"等比缩放至约 {scaled_width}x{scaled_height} 后留黑边填充到 "
            f"{target_width}x{target_height}；{bar_side}黑边合计 {bar_pixels}px"
        )
        if bar_pixels:
            warnings.append(f"为保持原画幅会留{bar_side}黑边（合计 {bar_pixels}px），不会裁切。")
    elif config.fit == "crop":
        factor = max(target_width / display_width, target_height / display_height)
        scaled_width = even_ceil(display_width * factor)
        scaled_height = even_ceil(display_height * factor)
        scaled_width = max(scaled_width, target_width)
        scaled_height = max(scaled_height, target_height)
        crop_horizontal = max(0, scaled_width - target_width)
        crop_vertical = max(0, scaled_height - target_height)
        filters.append(
            f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase:"
            "force_divisible_by=2:flags=lanczos"
        )
        filters.append("setsar=1")
        filters.append(
            f"crop={target_width}:{target_height}:(in_w-out_w)/2:(in_h-out_h)/2"
        )
        crop_axis = "左右" if crop_horizontal else "上下"
        crop_pixels = crop_horizontal or crop_vertical
        size_action = (
            f"等比放大至约 {scaled_width}x{scaled_height} 后中心裁切到 "
            f"{target_width}x{target_height}；{crop_axis}裁去合计 {crop_pixels}px"
        )
        warnings.append(f"为填满目标画幅会中心裁切{crop_axis}内容（合计 {crop_pixels}px）。")
    else:
        raise BatchError(f"不支持的画幅策略：{config.fit}")

    target_fps = config.fps
    target_fps_text = fps_text(target_fps)
    if config.fps_mode == "resample":
        filters.append(f"fps={target_fps_text}")
        fps_filter = f"fps={target_fps_text}"
        fps_action = (
            f"{fps_text(video.fps or 0)} fps → {target_fps_text} fps；"
            "按时间重采样并复制/丢弃帧，不做运动插值"
        )
    elif config.fps_mode == "interpolate":
        filters.append(
            f"minterpolate=fps={target_fps_text}:mi_mode=mci:mc_mode=aobmc:"
            "me_mode=bidir:vsbmc=1"
        )
        fps_filter = (
            f"minterpolate=fps={target_fps_text}:mi_mode=mci:mc_mode=aobmc:"
            "me_mode=bidir:vsbmc=1"
        )
        fps_action = f"{fps_text(video.fps or 0)} fps → {target_fps_text} fps；使用运动估计补帧"
        warnings.append("启用 minterpolate 运动补帧：计算量大，快速运动处可能出现伪影。")
    else:
        raise BatchError(f"不支持的帧率策略：{config.fps_mode}")

    if video.fps and abs(video.fps - target_fps) > 0.001 and config.fps_mode == "resample":
        warnings.append(
            f"帧率从 {fps_text(video.fps)} fps 改为 {target_fps_text} fps（复制/丢弃帧，不补运动帧）。"
        )

    if video.rotation_degrees:
        rotation_action = (
            f"源旋转 {video.rotation_degrees}°；FFmpeg 在滤镜前自动旋转并清除输出旋转元数据，"
            f"显示画幅 {display_width}x{display_height}"
        )
    else:
        rotation_action = f"源无旋转；显示画幅 {display_width}x{display_height}，输出旋转角 0°"

    if source.audio_streams:
        audio_action = (
            f"将 {len(source.audio_streams)} 条音轨转码为 {config.audio_codec} "
            f"{config.audio_bitrate}，保留原声道数与采样率"
        )
    elif config.audio_mode == "silence":
        audio_action = (
            "源文件无音轨；添加 48 kHz 双声道 AAC 静音轨，使输出含音轨"
        )
        warnings.append("源文件缺少音轨，将注入静音轨（并非恢复原声音）。")
    else:
        audio_action = "源文件无音轨；输出保持无音轨，不注入静音"
        warnings.append("源文件缺少音轨，输出将保持无音轨。")

    return {
        "target": {
            "width": target_width,
            "height": target_height,
            "resolution": f"{target_width}x{target_height}",
            "fps": target_fps,
            "pixel_format": config.pixel_format,
        },
        "fit_mode": config.fit,
        "size_action": size_action,
        "fps_action": fps_action,
        "rotation_action": rotation_action,
        "audio_action": audio_action,
        "fps_filter": fps_filter,
        "audio_codec": config.audio_codec,
        "audio_bitrate": config.audio_bitrate,
        "filter_chain": ",".join(filters),
        "warnings": warnings,
        "geometry": {
            "source_display_width": display_width,
            "source_display_height": display_height,
            "scaled_width": scaled_width,
            "scaled_height": scaled_height,
            "horizontal_black_bars_px": bars_horizontal,
            "vertical_black_bars_px": bars_vertical,
            "horizontal_cropped_px": crop_horizontal,
            "vertical_cropped_px": crop_vertical,
        },
    }


def build_ffmpeg_commands(
    ffmpeg: str,
    source: SourceInfo,
    output_path: Path,
    passlog_prefix: Path,
    config: EncodeConfig,
    transform: dict[str, Any],
) -> dict[str, Any]:
    needs_silence = not source.audio_streams and config.audio_mode == "silence"
    base = [ffmpeg, "-hide_banner", "-y", "-i", source.path]
    if needs_silence:
        base.extend(
            [
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
            ]
        )

    common: list[str] = ["-map", "0:v:0", "-map_metadata", "0"]
    if transform["filter_chain"]:
        common.extend(["-vf", transform["filter_chain"]])
    common.extend(
        [
            "-c:v",
            config.video_codec,
            "-preset",
            config.preset,
            "-pix_fmt",
            config.pixel_format,
            "-metadata:s:v:0",
            "rotate=0",
            "-sn",
            "-dn",
            "-fps_mode",
            "cfr",
        ]
    )

    if config.rate_control == "two-pass":
        common.extend(["-b:v", config.video_bitrate])
        pass1 = base + common + [
            "-pass",
            "1",
            "-passlogfile",
            str(passlog_prefix),
            "-an",
            "-f",
            "null",
            os.devnull,
        ]
        first_pass: list[list[str]] = [pass1]
    elif config.rate_control == "crf":
        first_pass = []
        common.extend(["-crf", str(config.crf)])
    else:
        raise BatchError(f"不支持的码率控制方式：{config.rate_control}")

    second = base + common
    if config.rate_control == "two-pass":
        second.extend(["-pass", "2", "-passlogfile", str(passlog_prefix)])

    if needs_silence:
        second.extend(
            [
                "-map",
                "1:a:0",
                "-c:a",
                config.audio_codec,
                "-b:a",
                config.audio_bitrate,
                "-shortest",
            ]
        )
    elif source.audio_streams:
        second.extend(
            [
                "-map",
                "0:a?",
                "-c:a",
                config.audio_codec,
                "-b:a",
                config.audio_bitrate,
            ]
        )
    else:
        second.append("-an")

    second.extend(
        [
            "-movflags",
            "+faststart",
            "-max_muxing_queue_size",
            "4096",
            str(output_path),
        ]
    )
    all_commands = first_pass + [second]
    return {
        "inputs": [source.path] + (["lavfi:anullsrc"] if needs_silence else []),
        "pass1": first_pass[0] if first_pass else None,
        "pass2": second,
        "commands": all_commands,
        "commands_shell": [shlex.join(command) for command in all_commands],
        "passlog_prefix": str(passlog_prefix) if first_pass else None,
        "partial_output": str(output_path),
    }


def make_ready_task(
    task_id: str,
    relative_path: str,
    source_path: Path,
    output_path: Path,
    probe_log: Path,
    ffmpeg: str,
    ffprobe: str,
    work_dir: Path,
    config: EncodeConfig,
) -> dict[str, Any]:
    source = probe_source(ffprobe, source_path, probe_log)
    transform = build_transform(source, config)
    partial_path = output_path.with_name(f"{output_path.stem}.part.mp4")
    commands = build_ffmpeg_commands(
        ffmpeg,
        source,
        partial_path,
        work_dir / "passlogs" / task_id,
        config,
        transform,
    )
    if config.rate_control == "two-pass":
        rate_control_text = (
            f"libx264 两遍编码，目标视频码率 {config.video_bitrate}，preset {config.preset}"
        )
    else:
        rate_control_text = f"libx264 CRF {config.crf}，preset {config.preset}"
    return {
        "id": task_id,
        "status": "ready",
        "relative_path": relative_path,
        "input": str(source_path.resolve()),
        "output": str(output_path.resolve()),
        "probe_log": str(probe_log),
        "source": asdict(source),
        "transform": transform,
        "rate_control": {
            "mode": config.rate_control,
            "video_bitrate": config.video_bitrate,
            "crf": config.crf,
            "preset": config.preset,
            "description": rate_control_text,
        },
        "commands": commands,
        "warnings": transform["warnings"],
    }


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def discover_videos(
    input_root: Path, excluded_directories: Sequence[Path]
) -> list[Path]:
    videos: list[Path] = []
    for current, directory_names, file_names in os.walk(input_root, followlinks=False):
        current_path = Path(current)
        directory_names[:] = sorted(
            name
            for name in directory_names
            if not any(
                path_is_within(current_path / name, excluded)
                for excluded in excluded_directories
            )
        )
        for file_name in sorted(file_names):
            path = current_path / file_name
            if path.suffix.lower() in VIDEO_EXTENSIONS and path.is_file():
                videos.append(path)
    return sorted(videos, key=lambda item: item.relative_to(input_root).as_posix())


def choose_output_path(
    relative_path: str, output_dir: Path, task_id: str, used: set[str]
) -> Path:
    candidate = output_dir / Path(relative_path).with_suffix(".mp4")
    key = str(candidate).casefold()
    if key in used:
        candidate = candidate.with_name(f"{candidate.stem}--{task_id}.mp4")
        key = str(candidate).casefold()
    used.add(key)
    return candidate


def scan_directory(
    input_root: Path,
    output_dir: Path,
    plan_dir: Path,
    work_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    config: EncodeConfig,
) -> dict[str, Any]:
    input_root = input_root.resolve()
    output_dir = output_dir.resolve()
    plan_dir = plan_dir.resolve()
    work_dir = work_dir.resolve()
    if not input_root.is_dir():
        raise BatchError(f"输入目录不存在或不可读：{input_root}")

    excluded = [output_dir, plan_dir, work_dir]
    videos = discover_videos(input_root, excluded)
    if not videos:
        extensions = ", ".join(sorted(VIDEO_EXTENSIONS))
        raise BatchError(f"输入目录内没有找到视频文件。支持的扩展名：{extensions}")

    plan_logs = plan_dir / "probe-logs"
    plan_logs.mkdir(parents=True, exist_ok=True)
    used_outputs: set[str] = set()
    tasks: list[dict[str, Any]] = []

    for index, source_path in enumerate(videos, start=1):
        relative = source_path.relative_to(input_root).as_posix()
        task_id = safe_task_id(relative)
        output_path = choose_output_path(relative, output_dir, task_id, used_outputs)
        probe_log = plan_logs / f"{task_id}.ffprobe.log"
        print(f"[{index}/{len(videos)}] 探测 {relative}", flush=True)
        try:
            task = make_ready_task(
                task_id=task_id,
                relative_path=relative,
                source_path=source_path,
                output_path=output_path,
                probe_log=probe_log,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                work_dir=work_dir,
                config=config,
            )
        except (ProbeError, OSError) as exc:
            try:
                size_bytes = source_path.stat().st_size
                mtime_ns = source_path.stat().st_mtime_ns
            except OSError:
                size_bytes = 0
                mtime_ns = 0
            task = {
                "id": task_id,
                "status": "probe_failed",
                "relative_path": relative,
                "input": str(source_path.resolve()),
                "output": str(output_path.resolve()),
                "input_size_bytes": size_bytes,
                "input_mtime_ns": mtime_ns,
                "probe_log": str(probe_log),
                "probe_error": str(exc),
                "source": None,
                "transform": None,
                "rate_control": None,
                "commands": None,
                "warnings": [f"探测失败：{exc}"],
            }
        tasks.append(task)

    ready_count = sum(task["status"] == "ready" for task in tasks)
    failed_count = len(tasks) - ready_count
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": utc_now(),
        "stage": "review",
        "input_root": str(input_root),
        "output_dir": str(output_dir),
        "plan_dir": str(plan_dir),
        "work_dir": str(work_dir),
        "tools": {"ffmpeg": ffmpeg, "ffprobe": ffprobe},
        "config": asdict(config),
        "summary": {
            "total": len(tasks),
            "ready": ready_count,
            "probe_failed": failed_count,
        },
        "tasks": tasks,
    }
    write_manifest_files(plan_dir, manifest)
    return manifest


def manifest_csv_row(task: dict[str, Any]) -> dict[str, Any]:
    source = task.get("source") or {}
    video = source.get("video") or {}
    transform = task.get("transform") or {}
    target = transform.get("target") or {}
    audio = source.get("audio_streams") or []
    rate_control = task.get("rate_control") or {}
    display_resolution = (
        f"{video.get('display_width')}x{video.get('display_height')}" if video else ""
    )
    coded_resolution = f"{video.get('width')}x{video.get('height')}" if video else ""
    return {
        "task_id": task["id"],
        "status": task["status"],
        "input": task["input"],
        "output": task["output"],
        "duration_seconds": (
            f"{source.get('duration_seconds', 0):.3f}" if source else ""
        ),
        "video_codec": video.get("codec_name", ""),
        "coded_resolution": coded_resolution,
        "display_resolution": display_resolution,
        "rotation_degrees": video.get("rotation_degrees", ""),
        "source_fps": f"{video['fps']:.6g}" if video.get("fps") else "",
        "audio_summary": audio_summary(audio),
        "target_resolution": target.get("resolution", ""),
        "fit_mode": transform.get("fit_mode", ""),
        "size_action": transform.get("size_action", ""),
        "fps_action": transform.get("fps_action", ""),
        "audio_action": transform.get("audio_action", ""),
        "rate_control": rate_control.get("description", ""),
        "review_note": task.get("probe_error", ""),
    }


def render_manifest_markdown(manifest: dict[str, Any], manifest_path: Path) -> str:
    summary = manifest["summary"]
    config = manifest["config"]
    lines = [
        "# FFmpeg 批量转码任务清单",
        "",
        f"- 生成时间：`{manifest['generated_at']}`",
        f"- 输入目录：`{manifest['input_root']}`",
        f"- 输出目录：`{manifest['output_dir']}`",
        f"- 工作目录：`{manifest['work_dir']}`",
        f"- 任务数：**{summary['total']}**，可执行 **{summary['ready']}**，探测失败 **{summary['probe_failed']}**",
        f"- 目标画幅：`{config['width']}x{config['height']}`，策略 `{config['fit']}`",
        f"- 目标帧率：`{config['fps']}`，策略 `{config['fps_mode']}`",
        f"- 码率控制：`{config['rate_control']}`，视频码率 `{config['video_bitrate']}`，CRF `{config['crf']}`，preset `{config['preset']}`",
        "",
        "> 先审查本清单，尤其是“画幅动作”“补帧动作”和警告。正式执行：",
        "",
        "```bash",
        f"{shlex.quote(sys.argv[0])} run {shlex.quote(str(manifest_path))}",
        "```",
        "",
        "## 任务总览",
        "",
        "| # | 状态 | 输入 | 时长 | 源画幅 / 旋转 | 源 fps | 音频 | 目标画幅 | 画幅动作 | 补帧动作 |",
        "|---:|---|---|---:|---|---:|---|---|---|---|",
    ]
    for index, task in enumerate(manifest["tasks"], start=1):
        source = task.get("source") or {}
        video = source.get("video") or {}
        transform = task.get("transform") or {}
        target = transform.get("target") or {}
        display = (
            f"{video.get('display_width')}x{video.get('display_height')} / {video.get('rotation_degrees')}°"
            if video
            else "n/a"
        )
        fps = f"{video['fps']:.4g}" if video.get("fps") else "n/a"
        duration = (
            f"{source['duration_seconds']:.2f}s" if source else "n/a"
        )
        lines.append(
            "| "
            + " | ".join(
                [
                    str(index),
                    task["status"],
                    f"`{task['relative_path']}`",
                    duration,
                    display,
                    fps,
                    audio_summary(source.get("audio_streams") or []),
                    target.get("resolution", "n/a"),
                    (transform.get("size_action") or "n/a").replace("|", "\\|"),
                    (transform.get("fps_action") or "n/a").replace("|", "\\|"),
                ]
            )
            + " |"
        )

    lines.extend(["", "## 任务详情", ""])
    for index, task in enumerate(manifest["tasks"], start=1):
        lines.extend([f"### {index}. `{task['relative_path']}`", ""])
        lines.append(f"- 状态：`{task['status']}`")
        lines.append(f"- 任务 ID：`{task['id']}`")
        lines.append(f"- 输入：`{task['input']}`")
        lines.append(f"- 输出：`{task['output']}`")
        if task["status"] != "ready":
            lines.append(f"- 探测错误：`{task.get('probe_error', 'unknown')}`")
            lines.append(f"- 独立探测日志：`{task['probe_log']}`")
            lines.append("")
            continue

        source = task["source"]
        video = source["video"]
        transform = task["transform"]
        lines.extend(
            [
                f"- 时长 / 源码率 / 大小：`{format_seconds(source['duration_seconds'])}` / "
                f"`{format_bitrate(source['bit_rate_bps'])}` / `{format_bytes(source['size_bytes'])}`",
                f"- 编码画幅：`{video['width']}x{video['height']}`；显示画幅："
                f"`{video['display_width']}x{video['display_height']}`；旋转：`{video['rotation_degrees']}°`",
                f"- 源帧率：avg `{video['avg_frame_rate']}`，r `{video['r_frame_rate']}`；"
                f"视频编码 `{video['codec_name']}` / `{video['pixel_format']}`",
                f"- 音频：{audio_summary(source['audio_streams'])}",
                f"- 旋转处理：{transform['rotation_action']}",
                f"- 画幅动作：**{transform['size_action']}**",
                f"- 帧率动作：**{transform['fps_action']}**",
                f"- 音频动作：{transform['audio_action']}",
                f"- 码率控制：{task['rate_control']['description']}",
                f"- 像素格式 / 容器：`{transform['target']['pixel_format']}` / MP4 (H.264 + AAC)",
            ]
        )
        if transform["warnings"]:
            lines.append("- 审查警告：")
            for warning in transform["warnings"]:
                lines.append(f"  - {warning}")
        lines.extend(["- 实际滤镜链：", "", "```text", transform["filter_chain"], "```", ""])
        lines.append("- 实际 FFmpeg 命令（按顺序执行）：")
        lines.extend(["", "```bash"])
        lines.extend(task["commands"]["commands_shell"])
        lines.extend(["```", ""])
    return "\n".join(lines).rstrip() + "\n"


def write_manifest_files(plan_dir: Path, manifest: dict[str, Any]) -> None:
    plan_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = plan_dir / "manifest.json"
    write_json_atomic(manifest_path, manifest)

    fieldnames = list(manifest_csv_row(manifest["tasks"][0]).keys())
    csv_buffer = io.StringIO()
    writer = csv.DictWriter(csv_buffer, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for task in manifest["tasks"]:
        writer.writerow(manifest_csv_row(task))
    write_text_atomic(plan_dir / "manifest.csv", "\ufeff" + csv_buffer.getvalue())
    write_text_atomic(
        plan_dir / "manifest.md", render_manifest_markdown(manifest, manifest_path)
    )


class TaskFailure(RuntimeError):
    """A file-specific failure. The batch must continue with other files."""


def append_log(log_file: Any, text: str) -> None:
    log_file.write(text.encode("utf-8", "backslashreplace"))
    if not text.endswith("\n"):
        log_file.write(b"\n")
    log_file.flush()


def tail_error(log_path: Path, fallback: str, limit: int = 5) -> str:
    if not log_path.exists():
        return fallback
    try:
        lines = [
            line.strip()
            for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.strip()
        ]
    except OSError:
        return fallback
    useful = [
        line
        for line in lines
        if re.search(r"(?i)(error|invalid|failed|no such|could not|conversion)", line)
    ]
    chosen = useful[-limit:] if useful else lines[-limit:]
    return " | ".join(chosen)[-1200:] if chosen else fallback


def cleanup_passlogs(prefix: Path) -> None:
    for path in prefix.parent.glob(f"{prefix.name}*"):
        try:
            path.unlink()
        except OSError:
            pass


def rewrite_command_for_run(
    command: list[str], ffmpeg: str, work_dir: Path, task_id: str
) -> list[str]:
    rewritten = list(command)
    if rewritten:
        rewritten[0] = ffmpeg
    for index, value in enumerate(rewritten[:-1]):
        if value == "-passlogfile":
            rewritten[index + 1] = str(work_dir / "passlogs" / task_id)
    return rewritten


def output_summary(
    ffprobe: str, output_path: Path, log_path: Path
) -> dict[str, Any]:
    info = probe_source(ffprobe, output_path, log_path)
    return {
        "size_bytes": info.size_bytes,
        "bit_rate_bps": info.bit_rate_bps,
        "duration_seconds": info.duration_seconds,
        "width": info.video.width,
        "height": info.video.height,
        "fps": info.video.fps,
        "rotation_degrees": info.video.rotation_degrees,
        "video_codec": info.video.codec_name,
        "audio_streams": len(info.audio_streams),
        "audio_summary": audio_summary(info.audio_streams),
    }


def validate_output(
    ffprobe: str,
    partial_path: Path,
    probe_log: Path,
    task: dict[str, Any],
    config: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    actual = output_summary(ffprobe, partial_path, probe_log)
    target = task["transform"]["target"]
    source = task["source"]
    problems: list[str] = []
    warnings: list[str] = []

    if (actual["width"], actual["height"]) != (target["width"], target["height"]):
        problems.append(
            f"输出画幅 {actual['width']}x{actual['height']}，"
            f"期望 {target['width']}x{target['height']}"
        )
    if actual["fps"] is None or abs(actual["fps"] - target["fps"]) > 0.05:
        problems.append(f"输出帧率 {actual['fps']}，期望 {target['fps']}")
    if actual["rotation_degrees"] != 0:
        problems.append(f"输出仍带旋转元数据 {actual['rotation_degrees']}°")

    expected_audio = bool(source["audio_streams"]) or config["audio_mode"] == "silence"
    if expected_audio and actual["audio_streams"] == 0:
        problems.append("输出缺少预期音轨")
    if not expected_audio and actual["audio_streams"] != 0:
        problems.append("源无音轨且 audio_mode=keep，但输出出现了音轨")
    if source["audio_streams"] and actual["audio_streams"] != len(source["audio_streams"]):
        warnings.append(
            f"源有 {len(source['audio_streams'])} 条音轨，输出有 {actual['audio_streams']} 条"
        )

    tolerance = max(2.0, float(source["duration_seconds"]) * 0.05)
    duration_delta = abs(
        float(actual["duration_seconds"]) - float(source["duration_seconds"])
    )
    if duration_delta > tolerance:
        warnings.append(
            f"输出时长与源相差 {duration_delta:.2f}s，超过容差 {tolerance:.2f}s"
        )
    if problems:
        raise TaskFailure("输出校验失败：" + "；".join(problems))
    return actual, warnings


def render_summary_markdown(summary: dict[str, Any]) -> str:
    totals = summary["totals"]
    lines = [
        "# FFmpeg 批量转码汇总",
        "",
        f"- 生成时间：`{summary['generated_at']}`",
        f"- 清单：`{summary['manifest']}`",
        f"- 工作目录：`{summary['work_dir']}`",
        f"- 任务：成功 **{totals['success']}**，失败 **{totals['failed']}**，跳过 **{totals['skipped']}**",
        f"- 总墙钟耗时：`{format_seconds(totals['wall_seconds'])}`",
        f"- 成功任务输入大小 / 输出大小：`{format_bytes(totals['input_size_bytes'])}` / "
        f"`{format_bytes(totals['output_size_bytes'])}`",
        f"- 成功任务加权输入 / 输出码率：`{format_bitrate(totals['input_bitrate_bps'])}` / "
        f"`{format_bitrate(totals['output_bitrate_bps'])}`",
        "",
        "| # | 状态 | 输入 | 时长 | 输入码率 | 输出码率 | 输入大小 | 输出大小 | 耗时 | 独立日志 |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for index, result in enumerate(summary["results"], start=1):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(index),
                    result["status"],
                    f"`{result['relative_path']}`",
                    format_seconds(result.get("input_duration_seconds")),
                    format_bitrate(result.get("input_bitrate_bps")),
                    format_bitrate(result.get("output_bitrate_bps")),
                    format_bytes(result.get("input_size_bytes")),
                    format_bytes(result.get("output_size_bytes")),
                    format_seconds(result.get("elapsed_seconds")),
                    f"`{result['log']}`",
                ]
            )
            + " |"
        )
    failures = [item for item in summary["results"] if item["status"] == "failed"]
    if failures:
        lines.extend(["", "## 失败详情", ""])
        for result in failures:
            lines.append(
                f"- `{result['relative_path']}`：{result.get('error') or 'unknown'}"
                f"（日志：`{result['log']}`）"
            )
    return "\n".join(lines).rstrip() + "\n"


def write_summary_files(work_dir: Path, summary: dict[str, Any]) -> None:
    work_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(work_dir / "summary.json", summary)
    fieldnames = [
        "task_id",
        "relative_path",
        "status",
        "input",
        "output",
        "error",
        "input_duration_seconds",
        "input_bitrate_bps",
        "input_size_bytes",
        "output_duration_seconds",
        "output_bitrate_bps",
        "output_size_bytes",
        "elapsed_seconds",
        "pass1_seconds",
        "pass2_seconds",
        "log",
        "warnings",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer, fieldnames=fieldnames, lineterminator="\n", extrasaction="ignore"
    )
    writer.writeheader()
    for result in summary["results"]:
        row = dict(result)
        row["warnings"] = " | ".join(result.get("warnings") or [])
        writer.writerow(row)
    write_text_atomic(work_dir / "summary.csv", "\ufeff" + buffer.getvalue())
    write_text_atomic(work_dir / "summary.md", render_summary_markdown(summary))


def process_task(
    task: dict[str, Any],
    config: dict[str, Any],
    ffmpeg: str,
    ffprobe: str,
    work_dir: Path,
    overwrite: bool,
) -> dict[str, Any]:
    started = time.monotonic()
    log_path = work_dir / "logs" / f"{task['id']}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    source = task.get("source") or {}
    result: dict[str, Any] = {
        "task_id": task["id"],
        "relative_path": task["relative_path"],
        "status": "failed",
        "input": task["input"],
        "output": task["output"],
        "error": None,
        "input_duration_seconds": source.get("duration_seconds"),
        "input_bitrate_bps": source.get("bit_rate_bps"),
        "input_size_bytes": source.get("size_bytes", task.get("input_size_bytes")),
        "output_duration_seconds": None,
        "output_bitrate_bps": None,
        "output_size_bytes": None,
        "elapsed_seconds": None,
        "pass1_seconds": None,
        "pass2_seconds": None,
        "log": str(log_path),
        "warnings": list(task.get("warnings") or []),
    }
    partial_path = (
        Path(task["commands"]["partial_output"])
        if task.get("commands")
        else Path(task["output"]).with_name(f"{Path(task['output']).stem}.part.mp4")
    )
    passlog_prefix = work_dir / "passlogs" / task["id"]

    try:
        with log_path.open("wb") as log:
            append_log(log, f"# task: {task['id']}")
            append_log(log, f"# input: {task['input']}")
            append_log(log, f"# output: {task['output']}")
            append_log(log, f"# started: {utc_now()}")
            if task["status"] != "ready":
                append_log(
                    log,
                    f"# probe failed: {task.get('probe_error') or 'unknown'}\n"
                    f"# probe log: {task.get('probe_log')}",
                )
                result["error"] = f"探测失败：{task.get('probe_error') or 'unknown'}"
                return result

            source_path = Path(task["input"])
            try:
                stat = source_path.stat()
            except OSError as exc:
                raise TaskFailure(f"无法读取源文件：{exc}") from exc
            if (
                stat.st_size != source["size_bytes"]
                or stat.st_mtime_ns != source["mtime_ns"]
            ):
                raise TaskFailure("源文件在 scan 后已变化；请重新生成并审查任务清单")
            if not task.get("commands") or not task["commands"].get("commands"):
                raise TaskFailure("清单中没有可执行命令；请重新 scan")

            output_path = Path(task["output"])
            if output_path.exists() and not overwrite:
                append_log(log, "# output exists; --overwrite not set, skipping encode")
                try:
                    actual = output_summary(
                        ffprobe,
                        output_path,
                        work_dir / "logs" / f"{task['id']}.output-probe.log",
                    )
                    result.update(
                        {
                            "status": "skipped",
                            "output_duration_seconds": actual["duration_seconds"],
                            "output_bitrate_bps": actual["bit_rate_bps"],
                            "output_size_bytes": actual["size_bytes"],
                        }
                    )
                except Exception as exc:
                    result["status"] = "skipped"
                    result["warnings"].append(f"已有输出无法探测：{exc}")
                append_log(log, "# skipped existing output")
                return result

            output_path.parent.mkdir(parents=True, exist_ok=True)
            partial_path.parent.mkdir(parents=True, exist_ok=True)
            if partial_path.exists():
                partial_path.unlink()
            passlog_prefix.parent.mkdir(parents=True, exist_ok=True)

            commands = task["commands"]["commands"]
            for index, stored_command in enumerate(commands):
                command = rewrite_command_for_run(
                    stored_command, ffmpeg, work_dir, task["id"]
                )
                label = (
                    "pass 1/2"
                    if config["rate_control"] == "two-pass" and index == 0
                    else ("pass 2/2" if config["rate_control"] == "two-pass" else "encode")
                )
                append_log(log, f"\n# {label}: {shlex.join(command)}")
                command_started = time.monotonic()
                completed = subprocess.run(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
                command_elapsed = time.monotonic() - command_started
                if config["rate_control"] == "two-pass" and index == 0:
                    result["pass1_seconds"] = command_elapsed
                else:
                    result["pass2_seconds"] = command_elapsed
                append_log(log, f"# {label} exit_code: {completed.returncode}")
                if completed.returncode != 0:
                    detail = tail_error(
                        log_path,
                        f"FFmpeg {label} 退出码 {completed.returncode}",
                    )
                    raise TaskFailure(f"{label} 失败（退出码 {completed.returncode}）：{detail}")

            if not partial_path.is_file() or partial_path.stat().st_size == 0:
                raise TaskFailure("FFmpeg 未生成有效输出文件")
            probe_log = work_dir / "logs" / f"{task['id']}.output-probe.log"
            actual, output_warnings = validate_output(
                ffprobe, partial_path, probe_log, task, config
            )
            result["warnings"].extend(output_warnings)
            append_log(
                log,
                "# output validation: "
                + json.dumps(actual, ensure_ascii=False, sort_keys=True),
            )
            os.replace(partial_path, output_path)
            result.update(
                {
                    "status": "success",
                    "output_duration_seconds": actual["duration_seconds"],
                    "output_bitrate_bps": actual["bit_rate_bps"],
                    "output_size_bytes": actual["size_bytes"],
                    "warnings": result["warnings"],
                }
            )
            cleanup_passlogs(passlog_prefix)
            append_log(log, f"# completed: {utc_now()}")
            return result
    except TaskFailure as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        try:
            if partial_path.exists():
                partial_path.unlink()
        except OSError:
            pass
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
        try:
            with log_path.open("ab") as log:
                append_log(log, "\n# unexpected error\n" + traceback.format_exc())
            if partial_path.exists():
                partial_path.unlink()
        except OSError:
            pass
    finally:
        result["elapsed_seconds"] = time.monotonic() - started
        try:
            with log_path.open("ab") as log:
                append_log(
                    log,
                    f"# final_status: {result['status']}\n"
                    f"# elapsed_seconds: {result['elapsed_seconds']:.3f}\n",
                )
                if result.get("error"):
                    append_log(log, f"# error: {result['error']}")
        except OSError:
            pass
    return result


def run_manifest(
    manifest_path: Path,
    ffmpeg_override: str | None,
    ffprobe_override: str | None,
    work_dir_override: Path | None,
    overwrite: bool,
    only: Sequence[str] | None,
    limit: int | None,
) -> int:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BatchError(f"无法读取任务清单 {manifest_path}：{exc}") from exc
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise BatchError(
            f"任务清单 schema_version={manifest.get('schema_version')}，"
            f"脚本要求 {SCHEMA_VERSION}；请重新 scan"
        )
    stored_tools = manifest.get("tools") or {}
    ffmpeg = resolve_tool(
        ffmpeg_override or stored_tools.get("ffmpeg"), "FFMPEG", "ffmpeg"
    )
    ffprobe = resolve_tool(
        ffprobe_override or stored_tools.get("ffprobe"), "FFPROBE", "ffprobe"
    )
    work_dir = (
        work_dir_override.resolve()
        if work_dir_override
        else Path(manifest["work_dir"]).resolve()
    )
    tasks = list(manifest.get("tasks") or [])
    if only:
        wanted = set(only)
        known = {task["id"] for task in tasks}
        unknown = wanted - known
        if unknown:
            raise BatchError("未知任务 ID：" + ", ".join(sorted(unknown)))
        tasks = [task for task in tasks if task["id"] in wanted]
    if limit is not None:
        tasks = tasks[:limit]
    if not tasks:
        raise BatchError("没有选中任何任务")

    config = manifest.get("config") or {}
    if config.get("rate_control") not in ("two-pass", "crf"):
        raise BatchError("清单中的码率控制配置无效；请重新 scan")

    started = time.monotonic()
    results: list[dict[str, Any]] = []
    for index, task in enumerate(tasks, start=1):
        print(f"[{index}/{len(tasks)}] 转码 {task['relative_path']}", flush=True)
        result = process_task(task, config, ffmpeg, ffprobe, work_dir, overwrite)
        results.append(result)
        suffix = result.get("error") if result["status"] == "failed" else ""
        print(
            f"  {result['status']} ({format_seconds(result['elapsed_seconds'])})"
            + (f"：{suffix}" if suffix else ""),
            flush=True,
        )

    wall_seconds = time.monotonic() - started
    completed = [
        result for result in results if result["status"] in ("success", "skipped")
    ]
    input_size = sum(int(item.get("input_size_bytes") or 0) for item in completed)
    output_size = sum(int(item.get("output_size_bytes") or 0) for item in completed)
    input_duration = sum(
        float(item.get("input_duration_seconds") or 0) for item in completed
    )
    output_duration = sum(
        float(item.get("output_duration_seconds") or 0) for item in completed
    )
    totals = {
        "success": sum(item["status"] == "success" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "skipped": sum(item["status"] == "skipped" for item in results),
        "wall_seconds": wall_seconds,
        "input_size_bytes": input_size,
        "output_size_bytes": output_size,
        "input_duration_seconds": input_duration,
        "output_duration_seconds": output_duration,
        "input_bitrate_bps": (
            input_size * 8 / input_duration if input_duration > 0 else None
        ),
        "output_bitrate_bps": (
            output_size * 8 / output_duration if output_duration > 0 else None
        ),
    }
    summary = {
        "generated_at": utc_now(),
        "manifest": str(manifest_path.resolve()),
        "work_dir": str(work_dir),
        "tools": {"ffmpeg": ffmpeg, "ffprobe": ffprobe},
        "totals": totals,
        "results": results,
    }
    write_summary_files(work_dir, summary)
    print(
        f"\n完成：成功 {totals['success']}，失败 {totals['failed']}，"
        f"跳过 {totals['skipped']}；总耗时 {format_seconds(wall_seconds)}"
    )
    print(f"汇总：{work_dir / 'summary.md'}")
    return 1 if totals["failed"] else 0


def build_encode_config(args: argparse.Namespace) -> EncodeConfig:
    if args.width < 2 or args.height < 2:
        raise BatchError("目标宽高必须至少为 2")
    if args.width % 2 or args.height % 2:
        raise BatchError("目标宽高必须为偶数，以满足 yuv420p 编码要求")
    if not 0 < args.fps <= 240:
        raise BatchError("目标帧率必须大于 0 且不超过 240")
    if not re.fullmatch(r"\d+(?:\.\d+)?[kKmM]?", args.video_bitrate):
        raise BatchError("--video-bitrate 应类似 4M、3500k 或 800000")
    if not re.fullmatch(r"\d+(?:\.\d+)?[kKmM]?", args.audio_bitrate):
        raise BatchError("--audio-bitrate 应类似 192k 或 128000")
    if not 0 <= args.crf <= 51:
        raise BatchError("--crf 必须在 0..51")
    return EncodeConfig(
        width=args.width,
        height=args.height,
        fps=args.fps,
        fit=args.fit,
        fps_mode=args.fps_mode,
        video_codec="libx264",
        rate_control=args.rate_control,
        video_bitrate=args.video_bitrate,
        crf=args.crf,
        preset=args.preset,
        pixel_format="yuv420p",
        audio_mode=args.audio_mode,
        audio_codec="aac",
        audio_bitrate=args.audio_bitrate,
    )


def add_tool_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--ffmpeg", help="ffmpeg 可执行文件路径（默认读取 FFMPEG 或 PATH）")
    parser.add_argument("--ffprobe", help="ffprobe 可执行文件路径（默认读取 FFPROBE 或 PATH）")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="用 FFmpeg 批量转码，先生成可审查清单，再逐文件执行并汇总。"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="扫描视频并生成 manifest.json/csv/md")
    scan.add_argument("input", type=Path, help="输入视频目录（递归扫描）")
    scan.add_argument("output", type=Path, help="转码输出目录")
    scan.add_argument("--plan-dir", type=Path, help="清单目录（默认 <output>_plan）")
    scan.add_argument("--work-dir", type=Path, help="日志/汇总目录（默认 <output>_work）")
    scan.add_argument("--width", type=int, default=1920, help="目标宽度，必须为偶数")
    scan.add_argument("--height", type=int, default=1080, help="目标高度，必须为偶数")
    scan.add_argument("--fps", type=float, default=30.0, help="目标帧率")
    scan.add_argument(
        "--fit",
        choices=("pad", "crop"),
        default="pad",
        help="pad=等比缩放后留黑边；crop=等比放大后中心裁切",
    )
    scan.add_argument(
        "--fps-mode",
        choices=("resample", "interpolate"),
        default="resample",
        help="resample=复制/丢弃帧；interpolate=minterpolate 运动补帧",
    )
    scan.add_argument(
        "--rate-control",
        choices=("two-pass", "crf"),
        default="two-pass",
        help="two-pass=两遍目标码率；crf=单遍恒定质量（等价质量控制）",
    )
    scan.add_argument("--video-bitrate", default="4M", help="两遍编码目标视频码率")
    scan.add_argument("--crf", type=int, default=20, help="--rate-control crf 时的质量值")
    scan.add_argument(
        "--preset",
        choices=(
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
        ),
        default="medium",
        help="libx264 preset",
    )
    scan.add_argument(
        "--audio-mode",
        choices=("keep", "silence"),
        default="keep",
        help="keep=无音轨则保持无音轨；silence=无音轨时注入静音 AAC",
    )
    scan.add_argument("--audio-bitrate", default="192k", help="AAC 音频码率")
    add_tool_arguments(scan)

    run = subparsers.add_parser("run", help="读取清单并执行转码")
    run.add_argument("manifest", type=Path, help="scan 生成的 manifest.json")
    run.add_argument("--work-dir", type=Path, help="覆盖清单中的日志/汇总目录")
    run.add_argument("--overwrite", action="store_true", help="覆盖已存在的输出文件")
    run.add_argument(
        "--only",
        action="append",
        metavar="TASK_ID",
        help="只运行指定任务 ID，可重复",
    )
    run.add_argument("--limit", type=int, help="最多运行前 N 个选中任务")
    add_tool_arguments(run)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            config = build_encode_config(args)
            ffmpeg = resolve_tool(args.ffmpeg, "FFMPEG", "ffmpeg")
            ffprobe = resolve_tool(args.ffprobe, "FFPROBE", "ffprobe")
            output_dir = args.output.resolve()
            plan_dir = (
                args.plan_dir.resolve()
                if args.plan_dir
                else output_dir.parent / f"{output_dir.name}_plan"
            )
            work_dir = (
                args.work_dir.resolve()
                if args.work_dir
                else output_dir.parent / f"{output_dir.name}_work"
            )
            manifest = scan_directory(
                args.input,
                output_dir,
                plan_dir,
                work_dir,
                ffmpeg,
                ffprobe,
                config,
            )
            summary = manifest["summary"]
            print(
                f"\n清单已生成：{plan_dir / 'manifest.md'}\n"
                f"任务 {summary['total']}，可执行 {summary['ready']}，"
                f"探测失败 {summary['probe_failed']}。请先审查清单再运行。"
            )
            return 0

        if args.limit is not None and args.limit < 1:
            raise BatchError("--limit 必须大于 0")
        return run_manifest(
            manifest_path=args.manifest,
            ffmpeg_override=args.ffmpeg,
            ffprobe_override=args.ffprobe,
            work_dir_override=args.work_dir,
            overwrite=args.overwrite,
            only=args.only,
            limit=args.limit,
        )
    except BatchError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断；已完成任务的独立日志仍保留在 work 目录。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
