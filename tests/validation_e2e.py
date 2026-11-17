#!/usr/bin/env python3
"""End-to-end validation for portrait/rotated, no-audio, and corrupt inputs."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ffmpeg_batch.py"


def require_tool(env_name: str, default_name: str) -> str:
    value = os.environ.get(env_name) or shutil.which(default_name)
    if not value:
        raise SystemExit(f"缺少 {default_name}；请安装 FFmpeg 或设置 {env_name}")
    path = shutil.which(value) or value
    if not Path(path).is_file() or not os.access(path, os.X_OK):
        raise SystemExit(f"{env_name} 不是可执行文件：{path}")
    return str(Path(path).resolve())


def run_command(command: list[str], expect: int = 0) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command), flush=True)
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode != expect:
        raise AssertionError(
            f"命令退出码 {result.returncode}，期望 {expect}: {' '.join(command)}"
        )
    return result


def ffprobe_json(ffprobe: str, media: Path) -> dict:
    result = run_command(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(media),
        ]
    )
    return json.loads(result.stdout)


def generate_fixtures(ffmpeg: str, input_dir: Path) -> dict[str, Path]:
    input_dir.mkdir(parents=True, exist_ok=True)
    base_portrait = input_dir.parent / "portrait-base.mp4"
    portrait = input_dir / "01_portrait_rotated.mp4"
    no_audio = input_dir / "02_no_audio.mp4"
    corrupt = input_dir / "03_corrupt.mp4"
    run_command(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(base_portrait),
        ]
    )
    run_command(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(base_portrait),
            "-c",
            "copy",
            str(portrait),
        ]
    )
    run_command(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=25",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "ultrafast",
            str(no_audio),
        ]
    )
    corrupt.write_text("this is not a valid video file\n", encoding="utf-8")
    return {"portrait": portrait, "no_audio": no_audio, "corrupt": corrupt}


def assert_no_rotation(stream: dict) -> None:
    rotations = [
        item.get("rotation")
        for item in stream.get("side_data_list") or []
        if item.get("rotation") is not None
    ]
    assert not rotations, f"输出仍有旋转元数据：{rotations}"


def main() -> int:
    ffmpeg = require_tool("FFMPEG", "ffmpeg")
    ffprobe = require_tool("FFPROBE", "ffprobe")
    root = Path(tempfile.mkdtemp(prefix="ffmpeg-batch-validation-"))
    input_dir = root / "input"
    output_dir = root / "output"
    plan_dir = root / "plan"
    work_dir = root / "work"
    print(f"验证目录：{root}", flush=True)
    fixtures = generate_fixtures(ffmpeg, input_dir)

    scan_command = [
        sys.executable,
        str(SCRIPT),
        "scan",
        str(input_dir),
        str(output_dir),
        "--plan-dir",
        str(plan_dir),
        "--work-dir",
        str(work_dir),
        "--width",
        "360",
        "--height",
        "640",
        "--fps",
        "30",
        "--fit",
        "pad",
        "--fps-mode",
        "resample",
        "--rate-control",
        "two-pass",
        "--video-bitrate",
        "1M",
        "--preset",
        "ultrafast",
        "--audio-mode",
        "keep",
        "--ffmpeg",
        ffmpeg,
        "--ffprobe",
        ffprobe,
    ]
    run_command(scan_command)
    manifest = json.loads((plan_dir / "manifest.json").read_text(encoding="utf-8"))
    tasks = {task["relative_path"]: task for task in manifest["tasks"]}

    assert manifest["summary"] == {"total": 3, "ready": 2, "probe_failed": 1}
    portrait_task = tasks["01_portrait_rotated.mp4"]
    portrait_video = portrait_task["source"]["video"]
    assert portrait_video["rotation_degrees"] == 90
    assert (
        portrait_video["display_width"],
        portrait_video["display_height"],
    ) == (360, 640)
    assert len(portrait_task["source"]["audio_streams"]) == 1

    no_audio_task = tasks["02_no_audio.mp4"]
    assert not no_audio_task["source"]["audio_streams"]
    assert "黑边" in no_audio_task["transform"]["size_action"]
    assert "复制/丢弃帧" in no_audio_task["transform"]["fps_action"]
    assert tasks["03_corrupt.mp4"]["status"] == "probe_failed"
    assert "Invalid data" in tasks["03_corrupt.mp4"]["probe_error"]

    assert (plan_dir / "manifest.csv").stat().st_size > 0
    markdown = (plan_dir / "manifest.md").read_text(encoding="utf-8")
    assert "画幅动作" in markdown and "补帧动作" in markdown
    assert "03_corrupt.mp4" in markdown
    print("scan 清单验证通过", flush=True)

    run_result = run_command(
        [sys.executable, str(SCRIPT), "run", str(plan_dir / "manifest.json")],
        expect=1,
    )
    assert "失败 1" in run_result.stdout

    portrait_output = output_dir / "01_portrait_rotated.mp4"
    no_audio_output = output_dir / "02_no_audio.mp4"
    for media in (portrait_output, no_audio_output):
        assert media.is_file(), f"缺少输出：{media}"
        probe = ffprobe_json(ffprobe, media)
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        assert (video["width"], video["height"]) == (360, 640)
        assert video["avg_frame_rate"] == "30/1"
        assert_no_rotation(video)

    portrait_probe = ffprobe_json(ffprobe, portrait_output)
    portrait_audio = [
        stream for stream in portrait_probe["streams"] if stream["codec_type"] == "audio"
    ]
    assert len(portrait_audio) == 1
    no_audio_probe = ffprobe_json(ffprobe, no_audio_output)
    assert not [
        stream for stream in no_audio_probe["streams"] if stream["codec_type"] == "audio"
    ]

    summary = json.loads((work_dir / "summary.json").read_text(encoding="utf-8"))
    assert summary["totals"]["success"] == 2
    assert summary["totals"]["failed"] == 1
    results = {item["relative_path"]: item for item in summary["results"]}
    for name in ("01_portrait_rotated.mp4", "02_no_audio.mp4"):
        result = results[name]
        assert result["status"] == "success"
        assert result["input_bitrate_bps"] > 0
        assert result["output_bitrate_bps"] > 0
        assert result["input_size_bytes"] > 0
        assert result["output_size_bytes"] > 0
        assert result["elapsed_seconds"] > 0
        assert result["pass1_seconds"] is not None
        assert result["pass2_seconds"] is not None
        log_text = Path(result["log"]).read_text(encoding="utf-8", errors="replace")
        assert "pass 1/2" in log_text and "pass 2/2" in log_text
        assert Path(result["log"]).stat().st_size > 0

    corrupt_result = results["03_corrupt.mp4"]
    assert corrupt_result["status"] == "failed"
    corrupt_log = Path(corrupt_result["log"])
    assert corrupt_log.stat().st_size > 0
    assert "Invalid data" in corrupt_log.read_text(encoding="utf-8", errors="replace")
    assert (work_dir / "summary.csv").stat().st_size > 0
    summary_md = (work_dir / "summary.md").read_text(encoding="utf-8")
    assert "输入码率" in summary_md and "输出码率" in summary_md
    assert "总墙钟耗时" in summary_md

    print("\n全部验证通过：", flush=True)
    print(f"- 竖屏+旋转+音轨：{portrait_output}", flush=True)
    print(f"- 无音轨：{no_audio_output}", flush=True)
    print(f"- 损坏文件独立日志：{corrupt_log}", flush=True)
    print(f"- 汇总：{work_dir / 'summary.md'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
