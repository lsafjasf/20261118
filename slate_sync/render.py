"""按统一时间线渲染成片：只切三机位画面，音频全程来自独立录音主轨。"""

from __future__ import annotations

import os
import subprocess

from .generate_media import _ffmpeg_paths


def _run(cmd: list[str], cwd: str) -> None:
    subprocess.run(cmd, check=True, cwd=cwd,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def render_program(engine, full_report: dict, out_path: str) -> dict:
    ffmpeg, root = _ffmpeg_paths()
    work = os.path.join(os.path.dirname(out_path), "render_tmp")
    os.makedirs(work, exist_ok=True)

    offsets = {row["trackId"]: row["finalOffsetMs"] / 1000.0
               for row in full_report["matrix"]}
    entries = {entry["id"]: entry for entry in engine.manifest["tracks"]}
    segment_files = []

    for segment in full_report["programSegments"]:
        camera = segment["cameraId"]
        local_in = segment["timelineInSec"] - offsets[camera]
        duration = segment["durationSec"]
        video_rel = entries[camera]["video"]
        video_abs = os.path.join(root, "samples", video_rel)
        piece = os.path.join(work, f"seg_{segment['index']:02d}.mp4")
        # 关键：-ss 用各机本地时间，时间线本身是统一主时钟，切换不会重置音频
        _run([
            ffmpeg, "-y", "-ss", f"{local_in:.3f}", "-i", video_abs,
            "-t", f"{duration:.3f}", "-an",
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
                   "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            piece,
        ], root)
        segment_files.append(piece)

    concat_list = os.path.join(work, "concat.txt")
    with open(concat_list, "w", encoding="utf-8") as handle:
        for piece in segment_files:
            handle.write(f"file '{os.path.abspath(piece)}'\n")
    video_only = os.path.join(work, "video_only.mp4")
    _run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
          "-c", "copy", video_only], root)

    master_audio = os.path.join(root, "samples",
                                entries[engine.master_id]["audio"])
    in_sec = full_report["commonInSec"]
    duration = full_report["commonDurationSec"]
    # 主音轨按同一主时钟裁切一次，之后无论镜头怎么切都不再触碰音频
    _run([
        ffmpeg, "-y", "-i", video_only,
        "-ss", f"{in_sec:.3f}", "-t", f"{duration:.3f}", "-i", master_audio,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", out_path,
    ], root)

    return {"outPath": out_path, "segments": len(segment_files),
            "audioSource": engine.master_id,
            "timelineInSec": in_sec, "durationSec": duration}
