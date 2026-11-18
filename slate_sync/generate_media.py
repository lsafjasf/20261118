"""生成多机位测试素材：1 条独立录音 + 3 条带机内录音的摄像机视频。

所有轨道共享同一条主时间线，场记板脉冲固定在主时间线 7.997s。
各机位起止不同，因此不能假设首帧对齐；真实偏移在 GROUND_TRUTH 中声明。
"""

from __future__ import annotations

import math
import os
import random
import subprocess

from .wavio import write_wav

SAMPLE_RATE = 48000
SLATE_MASTER_SEC = 7.997

# (轨道, 时长秒, 主时间线起点秒) —— 决定真实偏移
GROUND_TRUTH = [
    ("recorder", 27.4, 0.0),
    ("cam_a", 18.0, 6.65),
    ("cam_b", 19.5, 7.10),
    ("cam_c", 17.2, 5.90),
]

# 主时间线上的节目内容起音（说话/敲击等），场记板之外的可比对事件
CONTENT_EVENTS = [9.18, 10.51, 11.89, 13.23, 14.59, 15.95, 17.31, 18.11]


def _build_master_timeline(duration_sec: float, sample_rate: int) -> list[float]:
    rng = random.Random(20261118)
    total = int(duration_sec * sample_rate)
    samples = [0.0] * total

    # 底噪
    for index in range(total):
        samples[index] = rng.gauss(0.0, 0.0028)

    # 低频环境床，避免完全平直
    for index in range(total):
        t = index / sample_rate
        samples[index] += 0.004 * math.sin(2 * math.pi * 55 * t)

    def add_blob(center_sec: float, amp: float, freq: float, decay_ms: float):
        center = int(center_sec * sample_rate)
        decay_len = int(sample_rate * decay_ms / 1000.0)
        for offset in range(-200, decay_len):
            index = center + offset
            if 0 <= index < total and offset >= 0:
                decay = math.exp(-offset / decay_len)
                samples[index] += amp * decay * math.cos(2 * math.pi * freq * offset / sample_rate)

    # 场记板脉冲（主时间线 7.997s）
    add_blob(SLATE_MASTER_SEC, 0.85, 1700.0, 7.0)
    # 节目内容事件：多为中等强度，明显弱于场记板
    for serial, event_sec in enumerate(CONTENT_EVENTS):
        add_blob(event_sec, 0.10 + 0.01 * (serial % 3), 220.0 + 40 * serial, 90.0)
        add_blob(event_sec + 0.12, 0.05, 440.0, 55.0)
    return samples


def _slice_track(master: list[float], sample_rate: int, start_sec: float,
                 duration_sec: float, gain: float, seed: int) -> list[float]:
    rng = random.Random(seed)
    start = round(start_sec * sample_rate)
    length = round(duration_sec * sample_rate)
    track = [0.0] * length
    for offset in range(length):
        source = master[start + offset] if start + offset < len(master) else 0.0
        track[offset] = source * gain + rng.gauss(0.0, 0.0022)
    return track


def _ffmpeg_paths() -> tuple[str, str]:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ffmpeg = os.path.join(root, "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg")
    return ffmpeg, root


def _render_video(camera_id: str, duration_sec: float, clap_local_sec: float,
                  color: str, out_path: str, wav_path: str) -> None:
    ffmpeg, root = _ffmpeg_paths()
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
    frames = int(round(duration_sec * 24))
    # 场记板瞬间白闪 + 角标；时间码为各机本地时间，明确不假设首帧对齐
    flash = (
        f"between(t,{max(0, clap_local_sec - 0.02):.3f},{clap_local_sec + 0.10:.3f})")
    vf = (
        f"drawbox=x=0:y=0:w=iw:h=ih:color={color}:t=fill,"
        f"drawtext=fontfile={font}:text='{camera_id.upper()} TAKE 04':fontcolor=white:"
        f"fontsize=64:x=80:y=70,"
        f"drawtext=fontfile={font}:text='LOCAL TC %{{pts\\:hms}}':fontcolor=white@0.85:"
        f"fontsize=40:x=80:y=h-140,"
        f"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=fill:enable='{flash}',"
        f"drawtext=fontfile={font}:text='CLAP':fontcolor=black:fontsize=120:"
        f"x=(w-tw)/2:y=(h-th)/2:enable='{flash}'"
    )
    cmd = [
        ffmpeg, "-y", "-f", "lavfi", "-i",
        f"color=c=0x101418:s=1920x1080:r=24:d={duration_sec}",
        "-i", wav_path, "-vf", vf, "-frames:v", str(frames),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", out_path,
    ]
    subprocess.run(cmd, check=True, cwd=root,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def generate(media_dir: str) -> dict:
    os.makedirs(media_dir, exist_ok=True)
    master = _build_master_timeline(GROUND_TRUTH[0][1], SAMPLE_RATE)
    colors = {"cam_a": "0x1d2b46", "cam_b": "0x2a1d3d", "cam_c": "0x1d3d34"}
    manifest = {"sampleRate": SAMPLE_RATE, "slateMasterSec": SLATE_MASTER_SEC,
                "tracks": []}
    gains = {"recorder": 1.0, "cam_a": 0.92, "cam_b": 0.88, "cam_c": 0.95}
    for serial, (track_id, duration, start) in enumerate(GROUND_TRUTH):
        wav_path = os.path.join(media_dir, f"{track_id}.wav")
        if track_id == "recorder":
            write_wav(wav_path, master, SAMPLE_RATE)
        else:
            audio = _slice_track(master, SAMPLE_RATE, start, duration,
                                 gains[track_id], 1000 + serial)
            write_wav(wav_path, audio, SAMPLE_RATE)
            clap_local = SLATE_MASTER_SEC - start
            video_path = os.path.join(media_dir, f"{track_id}.mp4")
            _render_video(track_id, duration, clap_local, colors[track_id],
                          video_path, wav_path)
        manifest["tracks"].append({
            "id": track_id,
            "durationSec": duration,
            "masterStartSec": start,
            "trueOffsetMs": round(start * 1000),
            "audio": os.path.relpath(wav_path, os.path.dirname(media_dir)),
            "video": (None if track_id == "recorder"
                      else os.path.relpath(os.path.join(media_dir, f"{track_id}.mp4"),
                                           os.path.dirname(media_dir))),
        })
    return manifest
