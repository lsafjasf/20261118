"""Shared helpers for frame extraction using output-side (accurate) seeking."""
import subprocess

from common import FFMPEG


def extract_frame_output_seek(video: str, seconds: float, out_png: str) -> None:
    """Emulate a player chapter jump: decode then seek on the output side."""
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", video, "-ss", f"{seconds:.6f}",
            "-frames:v", "1", "-vsync", "0", out_png,
        ],
        check=True,
    )


def extract_source_frame(video: str, frame_index: int, fps: int, out_png: str) -> None:
    seconds = frame_index / fps
    subprocess.run(
        [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{seconds:.6f}", "-i", video,
            "-frames:v", "1", "-vsync", "0", out_png,
        ],
        check=True,
    )


def metric_pair(png_a: str, png_b: str, metric: str = "psnr") -> str:
    proc = subprocess.run(
        [
            FFMPEG, "-hide_banner", "-i", png_a, "-i", png_b,
            "-lavfi", metric, "-f", "null", "-",
        ],
        text=True, capture_output=True,
    )
    return proc.stderr
