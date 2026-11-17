"""Regenerate representative frames (keyframes) and the timeline HTML
whenever the shot list changes. Used by shot_detector.py and review.py.
"""
import base64
import html
import io
import json
import os

import cv2


def load_shots(path):
    with open(path) as fh:
        return json.load(fh)


def save_shots(path, data):
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def _fmt_time(frame, fps):
    s = frame / fps
    return f"{int(s // 60):02d}:{s % 60:05.2f}"


def extract_keyframes(video_path, shots, out_dir):
    """Write one representative (middle) frame per shot. Returns filenames."""
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.startswith("shot_") and old.endswith(".jpg"):
            os.remove(os.path.join(out_dir, old))
    cap = cv2.VideoCapture(video_path)
    names = []
    for s in shots:
        mid = (s["start"] + s["end"]) // 2
        cap.set(cv2.CAP_PROP_POS_FRAMES, mid)
        ok, frame = cap.read()
        if not ok:
            frame = None
        name = f"shot_{s['id']:03d}.jpg"
        if frame is not None:
            cv2.imwrite(os.path.join(out_dir, name), frame)
        names.append(name)
    cap.release()
    return names


def _thumb_b64(path, width=160):
    img = cv2.imread(path)
    if img is None:
        return ""
    h, w = img.shape[:2]
    img = cv2.resize(img, (width, int(h * width / w)))
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return base64.b64encode(buf).decode() if ok else ""


def render_timeline(shots_path, video_path, keyframe_dir, out_html):
    """Render an HTML timeline: one block per shot with keyframe thumbnail,
    boundary markers colored by incoming transition type."""
    data = load_shots(shots_path)
    shots, fps = data["shots"], data["fps"]
    total = shots[-1]["end"] + 1 if shots else 1
    colors = {"hard_cut": "#e5484d", "gradual": "#f5a524", "start": "#46a758"}
    blocks = []
    for s in shots:
        kf = os.path.join(keyframe_dir, f"shot_{s['id']:03d}.jpg")
        b64 = _thumb_b64(kf)
        color = colors.get(s["transition_in"], "#888")
        width = max(4, 100 * (s["end"] - s["start"] + 1) / total)
        blocks.append(
            f'<div class="shot" style="width:{width:.2f}%">'
            f'<div class="marker" style="background:{color}" '
            f'title="{s["transition_in"]} @ frame {s["start"]} '
            f'(conf {s["confidence"]})"></div>'
            f'<img src="data:image/jpeg;base64,{b64}">'
            f'<div class="lbl">#{s["id"]} f{s["start"]}-{s["end"]}<br>'
            f'{_fmt_time(s["start"], fps)} - {_fmt_time(s["end"], fps)}<br>'
            f'{s["transition_in"]} ({s["confidence"]})</div></div>')
    page = (
        "<!doctype html><meta charset=utf-8><title>Shot timeline</title>"
        "<style>body{font-family:sans-serif;background:#1c1c1e;color:#eee}"
        ".tl{display:flex;gap:2px;align-items:flex-start}"
        ".shot{position:relative;min-width:60px}"
        ".marker{height:8px;border-radius:2px}"
        "img{width:100%;border-radius:4px;margin-top:4px}"
        ".lbl{font-size:11px;color:#bbb;margin-top:4px}</style>"
        f"<h3>Timeline &mdash; {html.escape(os.path.basename(video_path))} "
        f"({len(shots)} shots)</h3><div class=tl>"
        + "".join(blocks) + "</div>")
    with open(out_html, "w") as fh:
        fh.write(page)


def sync(video_path, shots_path, keyframe_dir="keyframes",
         timeline_html="timeline.html"):
    """Re-extract keyframes and re-render the timeline from shots.json."""
    data = load_shots(shots_path)
    extract_keyframes(video_path, data["shots"], keyframe_dir)
    render_timeline(shots_path, video_path, keyframe_dir, timeline_html)
    return len(data["shots"])
