import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
OUT = ROOT / "out"
VERIFY = ROOT / "verification"
FFMPEG = str(Path.home() / "bin" / "ffmpeg")
FFPROBE = str(Path.home() / "bin" / "ffprobe")


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kwargs)


def ass_time(seconds: float) -> str:
    """Format seconds as ASS timestamp H:MM:SS.cc (centiseconds)."""
    cs = int(round(seconds * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def hms(seconds: float, frac_digits: int = 3) -> str:
    """Human readable H:MM:SS.mmm."""
    if seconds < 0:
        return "-" + hms(-seconds, frac_digits)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:0{frac_digits + 3}.{frac_digits}f}"


def frame_to_time(frame: int, fps: int) -> float:
    return frame / fps


def time_to_nearest_frame(seconds: float, fps: int) -> int:
    """Round half up to the nearest legal frame index."""
    scaled = seconds * fps
    return int(scaled + 0.5)
