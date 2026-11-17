"""Generate the 60s/30fps source clip with per-frame source timecode burn-in."""
from common import FFMPEG, WORK, ass_time, run

FPS = 30
DURATION = 60
TOTAL_FRAMES = FPS * DURATION
FONT = "Noto Sans CJK SC"


def write_timecode_ass(path) -> None:
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TC,{FONT},44,&H00FFFFFF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,3,2,1,5,40,40,20,1
Style: LB,{FONT},30,&H0000FFFF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,3,2,1,7,40,40,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for frame in range(TOTAL_FRAMES):
        start = frame / FPS
        end = (frame + 1) / FPS
        tc = f"SOURCE TC 00:00:{frame // FPS:02d}.{frame % FPS:02d}   FRAME {frame:04d}   f=30"
        label = "SOURCE VIDEO"
        lines.append(
            f"Dialogue: 0,{ass_time(start)},{ass_time(end)},TC,,0,0,0,,{tc}\n"
            f"Dialogue: 0,{ass_time(start)},{ass_time(end)},LB,,0,0,0,,{label}\n"
        )
    path.write_text("".join(lines), encoding="utf-8")


def main() -> None:
    ass_path = WORK / "timecode.ass"
    write_timecode_ass(ass_path)
    fonts_dir = WORK / "fonts"
    vf = f"subtitles={ass_path.name}:fontsdir={fonts_dir}"
    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "smptebars=size=1280x720:rate=30:duration=60",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=60",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
        str(WORK / "source.mp4"),
    ]
    run(cmd, cwd=WORK)
    print("source.mp4 generated")


if __name__ == "__main__":
    main()
