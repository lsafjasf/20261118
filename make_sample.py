#!/usr/bin/env python3
"""Generate a synthetic VFR clip with irregular frame intervals.

Pipeline: render a CFR 60 fps master (moving box with varying speed plus
audio beeps), dump frames, then re-assemble a deterministic subset with
irregular durations via the concat demuxer -> true VFR (irregular PTS).

Audio beeps (1 kHz, 200 ms) start at t = 1.8, 3.8, 5.8, 7.8, 9.8, 11.8 s
and act as A/V sync checkpoints. The 4-8 s window is the fast-motion part.
"""
import os
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
MASTER_FPS = 60
DURATION = 12.0
W, H = 640, 360


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def build_keep_list():
    """Deterministic irregular keep-pattern over 720 master frames."""
    n_total = int(MASTER_FPS * DURATION)
    keep = []
    state = 12345

    def rnd():
        nonlocal state
        state = (1103515245 * state + 12345) % (2**31)
        return state / (2**31)

    i = 0
    while i < n_total:
        keep.append(i)
        t = i / MASTER_FPS
        if t < 4.0:            # mild jitter, ~30-60 fps
            step = 1 + int(rnd() * 2)
        elif t < 8.0:          # fast-motion segment, wild swings 12-60 fps
            step = 1 + int(rnd() * 5)
        else:                  # low-fps tail, ~15-20 fps
            step = 3 + int(rnd() * 2)
        i += step
    return keep


def main():
    outdir = "sample"
    os.makedirs(outdir, exist_ok=True)
    master = os.path.join(outdir, "master_cfr60.mp4")
    vfr = os.path.join(outdir, "vfr_source.mp4")

    # 1) CFR master: box moves slowly, then fast (4-8 s), then slowly again.
    box_x = (r"if(lt(t\,4)\, 50+100*t\, "
             r"if(lt(t\,8)\, 450+500*(t-4)\, "
             r"min(2450+100*(t-8)\, 600)))")
    vf = (f"testsrc2=size={W}x{H}:rate={MASTER_FPS}:duration={DURATION},"
          f"drawbox=x='{box_x}':y=150:w=40:h=40:c=red:t=fill")
    beep = r"sin(2*PI*1000*t)*between(mod(t\,2)\,1.8\,2.0)"
    run([FFMPEG, "-y", "-f", "lavfi", "-i", vf,
         "-f", "lavfi", "-i", f"aevalsrc={beep}:s=48000:d={DURATION}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", master])

    # 2) VFR assembly: keep an irregular subset of frames; kept frames
    #    retain their original 1/60 s-grid PTS -> true VFR timestamps.
    keep = build_keep_list()
    expr = "+".join(f"eq(n\\,{fr})" for fr in keep)
    run([FFMPEG, "-y", "-i", master,
         "-vf", f"select='{expr}'", "-fps_mode", "passthrough",
         "-map", "0:v", "-map", "0:a",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", vfr])
    print(f"kept {len(keep)} of {int(MASTER_FPS*DURATION)} master frames")
    print("VFR sample:", vfr)


if __name__ == "__main__":
    sys.exit(main())

