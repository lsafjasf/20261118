#!/usr/bin/env python3
"""VFR -> CFR converter driven by an explicit per-frame PTS time map.

1. ffprobe every source video frame PTS.
2. Build a time map: for each output slot n at t = n / target_fps, pick a
   source frame (strategy: nearest | floor). The map records which source
   frames are duplicated (DUP) and which are skipped (SKIP).
3. Materialize the map by decoding source frames to PNG and re-assembling
   them with constant 1/fps durations via the concat demuxer, then
   re-encoding. This is a real frame-level rebuild, not re-timestamping.
4. Audio is stream-copied so the audio clock never drifts.
5. Emit timeline.csv / timeline.svg plus a verification report comparing
   durations, audio beep sync points and fast-segment frame intervals.

Optional --strategy mi uses ffmpeg minterpolate (motion interpolation)
instead of dup/drop, for comparison.
"""
import argparse
import bisect
import csv
import json
import math
import os
import shutil
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def probe_video_pts(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True).stdout
    pts = [float(l.split(",")[0]) for l in out.splitlines() if l.strip()]
    pts.sort()
    return pts


def probe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def probe_stream_duration(path, selector):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", selector,
         "-show_entries", "stream=duration", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True).stdout
    return float(out.strip().splitlines()[0])


def build_time_map(src_pts, fps, strategy="nearest", tail=None,
                   duration=None):
    """Map every output slot to a source frame index.

    Returns (mapping, src_end). mapping[n] = source frame index for output
    frame n. src_end extends the last source frame's visibility (defaults to
    the mean source frame interval) so total duration is preserved.
    """
    if tail is None:
        deltas = [b - a for a, b in zip(src_pts, src_pts[1:])]
        tail = sum(deltas) / len(deltas) if deltas else 1.0 / fps
    src_end = src_pts[-1] + tail
    if duration is not None:
        # container duration is authoritative: guarantees zero A/V drift
        n_out = max(1, round(duration * fps))
        src_end = duration
    else:
        n_out = max(1, round(src_end * fps))
    mapping = []
    for n in range(n_out):
        t = n / fps
        if strategy == "floor":
            idx = 0
            lo, hi = 0, len(src_pts) - 1
            while lo <= hi:
                mid = (lo + hi) // 2
                if src_pts[mid] <= t + 1e-9:
                    idx = mid
                    lo = mid + 1
                else:
                    hi = mid - 1
        else:  # nearest
            pos = bisect.bisect_left(src_pts, t)
            if pos == 0:
                idx = 0
            elif pos >= len(src_pts):
                idx = len(src_pts) - 1
            else:
                left, right = src_pts[pos - 1], src_pts[pos]
                idx = pos - 1 if (t - left) <= (right - t) else pos
        mapping.append(idx)
    # enforce monotonic non-decreasing output (no backward jumps)
    for n in range(1, n_out):
        if mapping[n] < mapping[n - 1]:
            mapping[n] = mapping[n - 1]
    return mapping, src_end


def analyze_mapping(mapping, n_src):
    used = {}
    for idx in mapping:
        used[idx] = used.get(idx, 0) + 1
    skipped = [i for i in range(n_src) if i not in used]
    dup_frames = {i: c for i, c in used.items() if c > 1}
    return used, skipped, dup_frames


def write_timeline_csv(path, mapping, src_pts, fps, used, skipped):
    skip_set = set(skipped)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["out_frame", "out_time", "src_frame", "src_pts",
                    "action", "src_use_count"])
        prev = None
        for n, idx in enumerate(mapping):
            action = "DUP" if idx == prev else "NEW"
            w.writerow([n, f"{n / fps:.6f}", idx, f"{src_pts[idx]:.6f}",
                        action, used[idx]])
            prev = idx
    print(f"timeline CSV: {path}  (skipped source frames: {len(skip_set)})")


def write_timeline_svg(path, mapping, src_pts, fps, used, skipped, src_end):
    """Two swimlanes: source frames (top) and output slots (bottom)."""
    width, row_h, pad = 1600, 46, 40
    height = 2 * row_h + 3 * pad
    n_src = len(src_pts)
    skip_set = set(skipped)

    def x(t):
        return pad + (width - 2 * pad) * (t / src_end)

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
             f'height="{height}" font-family="monospace" font-size="11">',
             f'<rect width="{width}" height="{height}" fill="#111"/>']
    parts.append(f'<text x="{pad}" y="{pad - 18}" fill="#bbb">'
                 f'source frames ({n_src}) — red = SKIPPED</text>')
    parts.append(f'<text x="{pad}" y="{pad + row_h + 28}" fill="#bbb">'
                 f'output slots @ {fps:g} fps ({len(mapping)}) — '
                 f'orange = DUPLICATED source frame</text>')
    for i, pts in enumerate(src_pts):
        color = "#e53935" if i in skip_set else "#43a047"
        parts.append(f'<circle cx="{x(pts):.1f}" cy="{pad + 12}" r="3" '
                     f'fill="{color}"><title>src {i} @ {pts:.4f}s'
                     f'{" SKIPPED" if i in skip_set else ""}</title></circle>')
    prev = None
    for n, idx in enumerate(mapping):
        t = n / fps
        dup = idx == prev
        color = "#fb8c00" if dup else "#1e88e5"
        parts.append(f'<rect x="{x(t):.1f}" y="{pad + row_h + 6}" width="2.5" '
                     f'height="12" fill="{color}"><title>out {n} @ {t:.4f}s '
                     f'&lt;- src {idx}{" DUP" if dup else ""}</title></rect>')
        prev = idx
    parts.append("</svg>")
    with open(path, "w") as fh:
        fh.write("\n".join(parts))
    print(f"timeline SVG: {path}")


def materialize(src, mapping, fps, out_path, workdir):
    """Rebuild video frame-by-frame per the map; audio is stream-copied.

    Each output frame is a hardlink to its mapped source PNG, so output
    slot n provably shows source frame mapping[n]; the image2 demuxer
    stamps them at exact n/fps. No re-timestamping of the source file.
    """
    frames_dir = os.path.join(workdir, "src_frames")
    seq_dir = os.path.join(workdir, "cfr_seq")
    os.makedirs(frames_dir, exist_ok=True)
    os.makedirs(seq_dir, exist_ok=True)
    run([FFMPEG, "-y", "-i", src, "-fps_mode", "passthrough",
         "-start_number", "0", os.path.join(frames_dir, "s%06d.png")])
    n_png = len([f for f in os.listdir(frames_dir) if f.endswith(".png")])
    assert n_png == max(mapping) + 1 or n_png >= max(mapping) + 1, \
        f"extracted {n_png} frames, need {max(mapping) + 1}"
    for n, idx in enumerate(mapping):
        link = os.path.join(seq_dir, f"o{n + 1:06d}.png")
        target = os.path.join(frames_dir, f"s{idx:06d}.png")
        if os.path.exists(link):
            os.remove(link)
        try:
            os.link(target, link)
        except OSError:
            shutil.copy(target, link)
    run([FFMPEG, "-y", "-framerate", f"{fps:g}", "-i",
         os.path.join(seq_dir, "o%06d.png"),
         "-i", src, "-map", "0:v", "-map", "1:a?",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "copy", out_path])
    shutil.rmtree(frames_dir)
    shutil.rmtree(seq_dir)


def materialize_mi(src, fps, out_path):
    """Alternative strategy: motion interpolation via minterpolate."""
    run([FFMPEG, "-y", "-i", src,
         "-vf", f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:"
                f"me_mode=bidir:vsbmc=1",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "copy", out_path])


def detect_beeps(path, noise="-40dB", min_silence=0.1):
    """Return beep onset times via silencedetect (beeps break silence)."""
    proc = subprocess.run(
        [FFMPEG, "-i", path, "-af",
         f"silencedetect=noise={noise}:d={min_silence}", "-f", "null", "-"],
        capture_output=True, text=True)
    onsets = []
    for line in proc.stderr.splitlines():
        if "silence_end:" in line:
            t = line.split("silence_end:")[1].split("|")[0].strip()
            onsets.append(float(t))
    return onsets


def interval_stats(pts, t0=None, t1=None):
    sel = [p for p in pts if (t0 is None or p >= t0) and (t1 is None or p < t1)]
    deltas = [b - a for a, b in zip(sel, sel[1:])]
    if not deltas:
        return None
    mean = sum(deltas) / len(deltas)
    var = sum((d - mean) ** 2 for d in deltas) / len(deltas)
    return {"n": len(deltas), "min": min(deltas), "max": max(deltas),
            "mean": mean, "std": math.sqrt(var)}


def fmt_stats(s):
    if s is None:
        return "  (no frames in window)"
    return (f"  n={s['n']:4d}  min={s['min']*1000:7.2f}ms  "
            f"max={s['max']*1000:7.2f}ms  mean={s['mean']*1000:7.2f}ms  "
            f"std={s['std']*1000:6.2f}ms")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--strategy", choices=["nearest", "floor", "mi"],
                    default="nearest")
    ap.add_argument("--workdir", default="vfr2cfr_work")
    ap.add_argument("--fast-window", default="4-8",
                    help="fast-motion window in seconds, e.g. 4-8")
    args = ap.parse_args()

    os.makedirs(args.workdir, exist_ok=True)
    src = args.input
    print(f"== probing source: {src}")
    src_pts = probe_video_pts(src)
    src_dur = probe_duration(src)
    print(f"source frames: {len(src_pts)}  container duration: {src_dur:.3f}s")

    if args.strategy == "mi":
        materialize_mi(src, args.fps, args.output)
        mapping, src_end = None, src_dur
    else:
        mapping, src_end = build_time_map(src_pts, args.fps, args.strategy,
                                          duration=src_dur)
        used, skipped, dups = analyze_mapping(mapping, len(src_pts))
        print(f"output frames: {len(mapping)}  | duplicated source frames: "
              f"{len(dups)}  | skipped source frames: {len(skipped)}")
        base = os.path.splitext(os.path.basename(args.output))[0]
        write_timeline_csv(os.path.join(args.workdir, f"{base}_timeline.csv"),
                           mapping, src_pts, args.fps, used, skipped)
        write_timeline_svg(os.path.join(args.workdir, f"{base}_timeline.svg"),
                           mapping, src_pts, args.fps, used, skipped, src_end)
        materialize(src, mapping, args.fps, args.output, args.workdir)

    print("\n== verification ==")
    out_pts = probe_video_pts(args.output)
    out_dur = probe_duration(args.output)
    print(f"durations: source={src_dur:.3f}s  output={out_dur:.3f}s  "
          f"drift={out_dur - src_dur:+.3f}s")
    try:
        a_src = probe_stream_duration(src, "a:0")
        a_out = probe_stream_duration(args.output, "a:0")
        print(f"audio stream: source={a_src:.3f}s  output={a_out:.3f}s  "
              f"drift={a_out - a_src:+.3f}s")
    except Exception:
        print("audio stream: none")

    t0, t1 = (float(v) for v in args.fast_window.split("-"))
    print(f"\nframe intervals, full timeline:")
    print("  source:", fmt_stats(interval_stats(src_pts)))
    print("  output:", fmt_stats(interval_stats(out_pts)))
    print(f"frame intervals, fast-motion window {t0:g}-{t1:g}s:")
    print("  source:", fmt_stats(interval_stats(src_pts, t0, t1)))
    print("  output:", fmt_stats(interval_stats(out_pts, t0, t1)))

    print("\naudio beep sync points (silence_end onsets):")
    b_src, b_out = detect_beeps(src), detect_beeps(args.output)
    print("  source:", " ".join(f"{t:.3f}" for t in b_src))
    print("  output:", " ".join(f"{t:.3f}" for t in b_out))
    if b_src and b_out and len(b_src) == len(b_out):
        worst = max(abs(a - b) for a, b in zip(b_src, b_out))
        print(f"  max |sync offset|: {worst*1000:.1f}ms")

    report = {"source": src, "output": args.output, "fps": args.fps,
              "strategy": args.strategy,
              "source_frames": len(src_pts), "output_frames": len(out_pts),
              "source_duration": src_dur, "output_duration": out_dur}
    rpt = os.path.join(args.workdir, "report.json")
    with open(rpt, "w") as fh:
        json.dump(report, fh, indent=2)
    print(f"\nreport: {rpt}")


if __name__ == "__main__":
    sys.exit(main())
