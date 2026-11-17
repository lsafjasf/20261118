#!/usr/bin/env python3
"""Subtitle preflight gate for FFmpeg burn-in.

Pipeline:
  1. Parse subtitles (ASS/SSA/SRT): fonts, languages, styles, wrapping,
     character coverage against the resolved fonts.
  2. Render a preview collage containing the longest subtitle, the event
     with the highest punctuation density and the events touching the
     frame edges.
  3. Only when the preflight passes, run the FFmpeg burn-in.
  4. Compare frames at identical timestamps before/after the burn and
     verify the subtitle lands where the layout engine predicted.

Missing glyphs are never silently replaced with tofu boxes: the preflight
fails and reports the exact characters together with their timestamps.
"""

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
# Subtitle model + parsers
# ---------------------------------------------------------------------------

@dataclass
class Style:
    name: str
    font: str = "Arial"
    size: float = 48.0
    bold: bool = False
    italic: bool = False
    alignment: int = 2          # ASS numpad alignment
    margin_l: int = 10
    margin_r: int = 10
    margin_v: int = 10
    wrap_style: int = 0


@dataclass
class Event:
    start: float
    end: float
    text: str                   # plain text, override tags stripped
    style: str = "Default"
    layer: int = 0


@dataclass
class SubtitleDoc:
    fmt: str
    styles: dict = field(default_factory=dict)
    events: list = field(default_factory=list)
    play_res_x: int = 1280
    play_res_y: int = 720


def _ts_to_sec(ts: str) -> float:
    m = re.match(r"\s*(\d+):(\d+):(\d+)[.,](\d+)\s*", ts)
    if not m:
        raise ValueError(f"bad timestamp: {ts!r}")
    h, mnt, s, frac = m.groups()
    frac = frac.ljust(3, "0")[:3]
    return int(h) * 3600 + int(mnt) * 60 + int(s) + int(frac) / 1000.0


def sec_to_ts(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


_TAG_RE = re.compile(r"\{[^}]*\}")


def _strip_tags(text: str) -> str:
    text = _TAG_RE.sub("", text)
    return text.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")


def parse_ass(path: Path) -> SubtitleDoc:
    doc = SubtitleDoc(fmt="ass")
    section = None
    style_fmt, event_fmt = [], []
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].lower()
            continue
        if section == "script info" and ":" in line:
            key, val = [p.strip() for p in line.split(":", 1)]
            if key.lower() == "playresx":
                doc.play_res_x = int(val)
            elif key.lower() == "playresy":
                doc.play_res_y = int(val)
        elif section == "v4+ styles":
            if line.lower().startswith("format:"):
                style_fmt = [f.strip() for f in line[7:].split(",")]
            elif line.lower().startswith("style:"):
                vals = [v.strip() for v in line[6:].split(",")]
                rec = dict(zip(style_fmt, vals))
                st = Style(
                    name=rec.get("Name", "Default"),
                    font=rec.get("Fontname", "Arial"),
                    size=float(rec.get("Fontsize", 48)),
                    bold=rec.get("Bold", "0") not in ("0", ""),
                    italic=rec.get("Italic", "0") not in ("0", ""),
                    alignment=int(rec.get("Alignment", "2")),
                    margin_l=int(float(rec.get("MarginL", 10))),
                    margin_r=int(float(rec.get("MarginR", 10))),
                    margin_v=int(float(rec.get("MarginV", 10))),
                    wrap_style=int(rec.get("WrapStyle", "0") or 0),
                )
                doc.styles[st.name] = st
        elif section == "events":
            if line.lower().startswith("format:"):
                event_fmt = [f.strip() for f in line[7:].split(",")]
            elif line.lower().startswith("dialogue:"):
                vals = line[9:].split(",", len(event_fmt) - 1)
                rec = dict(zip(event_fmt, [v.strip() for v in vals]))
                doc.events.append(Event(
                    start=_ts_to_sec(rec["Start"]),
                    end=_ts_to_sec(rec["End"]),
                    text=_strip_tags(rec.get("Text", "")),
                    style=rec.get("Style", "Default"),
                    layer=int(rec.get("Layer", "0") or 0),
                ))
    return doc


def parse_srt(path: Path, default_style: Style) -> SubtitleDoc:
    doc = SubtitleDoc(fmt="srt")
    doc.styles[default_style.name] = default_style
    blocks = re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig").strip())
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        ts_line = next((l for l in lines if "-->" in l), None)
        if ts_line is None:
            continue
        start_s, end_s = [t.strip() for t in ts_line.split("-->")]
        idx = lines.index(ts_line)
        text = "\n".join(lines[idx + 1:])
        doc.events.append(Event(
            start=_ts_to_sec(start_s),
            end=_ts_to_sec(end_s),
            text=_strip_tags(re.sub(r"<[^>]+>", "", text)),
            style=default_style.name,
        ))
    return doc


def load_subtitles(path: Path, default_font: str, default_size: float) -> SubtitleDoc:
    if path.suffix.lower() in (".ass", ".ssa"):
        return parse_ass(path)
    return parse_srt(path, Style(name="Default", font=default_font, size=default_size))


# ---------------------------------------------------------------------------
# Font resolution, coverage, language and layout analysis
# ---------------------------------------------------------------------------

class FontFace:
    """A resolved font file with cmap + measuring capability."""

    def __init__(self, path: Path):
        self.path = path
        self.tt = TTFont(str(path), fontNumber=0, lazy=True)
        self.cmap = self.tt.getBestCmap()
        self.family = self._read_family()
        self._pil_cache = {}

    def _read_family(self) -> str:
        for rec in self.tt["name"].names:
            if rec.nameID in (16, 1):
                try:
                    return rec.toUnicode()
                except Exception:
                    continue
        return self.path.stem

    def has(self, ch: str) -> bool:
        return ord(ch) in self.cmap

    def pil(self, size: int) -> ImageFont.FreeTypeFont:
        if size not in self._pil_cache:
            self._pil_cache[size] = ImageFont.truetype(str(self.path), size)
        return self._pil_cache[size]


def resolve_fonts(font_dirs: list) -> dict:
    """family name (lower) -> FontFace, built from every font file found."""
    faces = {}
    for d in font_dirs:
        for p in sorted(Path(d).rglob("*")):
            if p.suffix.lower() not in (".ttf", ".otf", ".ttc", ".otc"):
                continue
            try:
                face = FontFace(p)
            except Exception:
                continue
            faces.setdefault(face.family.lower(), face)
    return faces


def script_of(ch: str) -> str:
    cp = ord(ch)
    if ch == "\n":
        return "newline"
    if unicodedata.category(ch).startswith("P"):
        return "punctuation"
    if unicodedata.category(ch).startswith("Z"):
        return "space"
    if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF:
        return "cjk"
    if 0x3040 <= cp <= 0x30FF:
        return "kana"
    if 0xAC00 <= cp <= 0xD7AF or 0x1100 <= cp <= 0x11FF:
        return "hangul"
    if 0x0400 <= cp <= 0x04FF:
        return "cyrillic"
    if 0x0600 <= cp <= 0x06FF:
        return "arabic"
    if cp < 0x0250:
        return "latin"
    return "other"


def analyze_languages(doc: SubtitleDoc) -> dict:
    counts = {}
    for ev in doc.events:
        for ch in ev.text:
            sc = script_of(ch)
            if sc not in ("space", "newline"):
                counts[sc] = counts.get(sc, 0) + 1
    return counts


def check_coverage(doc: SubtitleDoc, faces: dict) -> list:
    """Return a list of missing-glyph findings (never silently tofu)."""
    problems = []
    for ev in doc.events:
        style = doc.styles.get(ev.style) or next(iter(doc.styles.values()))
        face = faces.get(style.font.lower())
        if face is None:
            problems.append({
                "type": "missing_font",
                "font": style.font,
                "style": style.name,
                "start": sec_to_ts(ev.start),
                "end": sec_to_ts(ev.end),
            })
            continue
        missing = {}
        for ch in ev.text:
            if ch in ("\n", "\t") or unicodedata.category(ch).startswith("Z"):
                continue
            if not face.has(ch):
                missing.setdefault(ch, []).append(ev.text.strip().split("\n")[0][:40])
        for ch in sorted(missing):
            problems.append({
                "type": "missing_glyph",
                "char": ch,
                "codepoint": f"U+{ord(ch):04X}",
                "name": unicodedata.name(ch, "<unnamed>"),
                "font": face.family,
                "font_file": str(face.path),
                "style": style.name,
                "start": sec_to_ts(ev.start),
                "end": sec_to_ts(ev.end),
                "context": missing[ch][0],
            })
    return problems


# ---------------------------------------------------------------------------
# Layout: measure lines, simulate wrapping, find extremes
# ---------------------------------------------------------------------------

def _measure(face: FontFace, text: str, size: int) -> int:
    if not text:
        return 0
    font = face.pil(size)
    return int(round(font.getlength(text)))


def wrap_line(face: FontFace, text: str, size: int, max_w: int, wrap_style: int) -> list:
    """Greedy word/char wrap approximating libass WrapStyle 0/2."""
    if max_w <= 0:
        return [text]
    out, cur = [], ""
    tokens = re.findall(r"\S+\s*|\s+", text)
    for tok in tokens:
        if _measure(face, tok.strip(), size) > max_w:
            # single token wider than the frame: break by character
            piece = cur
            for ch in tok:
                if piece and _measure(face, piece + ch, size) > max_w:
                    out.append(piece.rstrip())
                    piece = ch
                else:
                    piece += ch
            cur = piece
            continue
        trial = cur + tok
        if cur and _measure(face, trial, size) > max_w:
            out.append(cur.rstrip())
            cur = tok if wrap_style != 2 else tok.lstrip()
        else:
            cur = trial
    if cur.strip():
        out.append(cur.rstrip())
    return out or [""]


@dataclass
class EventLayout:
    event: Event
    style: Style
    lines: list
    width: int
    height: int
    box: tuple          # (x0, y0, x1, y1) in video pixels
    overflow_x: bool
    overflow_y: bool
    punct_density: float


def layout_events(doc: SubtitleDoc, faces: dict, video_w: int, video_h: int,
                  scale: float) -> list:
    layouts = []
    sx = video_w / doc.play_res_x
    sy = video_h / doc.play_res_y
    for ev in doc.events:
        style = doc.styles.get(ev.style) or next(iter(doc.styles.values()))
        face = faces.get(style.font.lower())
        if face is None:
            continue
        size = max(1, int(round(style.size * sy * scale)))
        ml, mr = int(style.margin_l * sx), int(style.margin_r * sx)
        mv = int(style.margin_v * sy)
        max_w = video_w - ml - mr
        lines = []
        for hard in ev.text.split("\n"):
            lines.extend(wrap_line(face, hard, size, max_w, style.wrap_style))
        widths = [_measure(face, ln, size) for ln in lines]
        w = max(widths) if widths else 0
        line_h = int(size * 1.25)
        h = line_h * len(lines)
        align = style.alignment
        col = (align - 1) % 3          # 0=left 1=center 2=right
        row = (align - 1) // 3         # 0=bottom 1=middle 2=top
        x0 = [ml, (video_w - w) // 2, video_w - mr - w][col]
        y0 = [video_h - mv - h, (video_h - h) // 2, mv][row]
        punct = sum(1 for c in ev.text if script_of(c) == "punctuation")
        visible = sum(1 for c in ev.text if script_of(c) not in ("space", "newline"))
        layouts.append(EventLayout(
            event=ev, style=style, lines=lines, width=w, height=h,
            box=(x0, y0, x0 + w, y0 + h),
            overflow_x=w > max_w,
            overflow_y=(y0 < 0 or y0 + h > video_h),
            punct_density=(punct / visible) if visible else 0.0,
        ))
    return layouts


def pick_showcase(layouts: list) -> dict:
    """Longest subtitle, highest punctuation density, edge extremes."""
    if not layouts:
        return {}
    by_len = max(layouts, key=lambda l: max((len(ln) for ln in l.lines), default=0))
    by_punct = max(layouts, key=lambda l: l.punct_density)
    by_top = min(layouts, key=lambda l: l.box[1])
    by_bottom = max(layouts, key=lambda l: l.box[3])
    by_left = min(layouts, key=lambda l: l.box[0])
    by_right = max(layouts, key=lambda l: l.box[2])
    picks = {"longest": by_len, "punctuation": by_punct,
             "edge_top": by_top, "edge_bottom": by_bottom,
             "edge_left": by_left, "edge_right": by_right}
    # de-duplicate while keeping order
    seen, uniq = set(), {}
    for label, lay in picks.items():
        key = id(lay)
        if key not in seen:
            seen.add(key)
            uniq[label] = lay
        else:
            uniq[label] = lay
    return picks


# ---------------------------------------------------------------------------
# Video helpers (ffmpeg/ffprobe)
# ---------------------------------------------------------------------------

def run(cmd: list) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def probe_video(ffmpeg: str, video: Path) -> dict:
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    cp = run([ffprobe, "-v", "error", "-select_streams", "v:0",
              "-show_entries", "stream=width,height,duration",
              "-of", "json", str(video)])
    st = json.loads(cp.stdout)["streams"][0]
    return {"width": int(st["width"]), "height": int(st["height"]),
            "duration": float(st.get("duration", 0))}


def grab_frame(ffmpeg: str, video: Path, t: float) -> Image.Image:
    cp = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{t:.3f}", "-i", str(video),
                         "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                        capture_output=True)
    if cp.returncode != 0 or not cp.stdout:
        raise RuntimeError(f"frame grab failed at {t:.3f}s: {cp.stderr.decode()[:200]}")
    import io
    return Image.open(io.BytesIO(cp.stdout)).convert("RGB")


# ---------------------------------------------------------------------------
# Preview collage
# ---------------------------------------------------------------------------

def render_event_tile(ffmpeg: str, video: Path, lay: EventLayout, faces: dict,
                      video_w: int, video_h: int, label: str) -> Image.Image:
    t = (lay.event.start + lay.event.end) / 2
    try:
        frame = grab_frame(ffmpeg, video, t)
    except Exception:
        frame = Image.new("RGB", (video_w, video_h), (32, 32, 32))
    frame = frame.resize((video_w, video_h))
    draw = ImageDraw.Draw(frame, "RGBA")
    face = faces[lay.style.font.lower()]
    size = max(1, lay.height // max(1, len(lay.lines)))
    size = int(size / 1.25)
    font = face.pil(size)
    x0, y0, x1, y1 = lay.box
    draw.rectangle(lay.box, outline=(0, 255, 255, 255), width=2)
    line_h = int(size * 1.25)
    for i, ln in enumerate(lay.lines):
        w = _measure(face, ln, size)
        col = (lay.style.alignment - 1) % 3
        lx = [x0, x0 + (lay.width - w) // 2, x1 - w][col]
        ly = y0 + i * line_h
        draw.text((lx, ly), ln, font=font, fill=(255, 255, 255, 255),
                  stroke_width=2, stroke_fill=(0, 0, 0, 255))
    tag = ImageFont.truetype(str(face.path), 22)
    draw.rectangle([0, 0, frame.width, 30], fill=(0, 0, 0, 180))
    draw.text((8, 4), f"{label}  @{sec_to_ts(t)}  box={lay.box}",
              font=tag, fill=(255, 255, 0, 255))
    return frame


def build_collage(ffmpeg: str, video: Path, layouts: list, faces: dict,
                  video_w: int, video_h: int, out_path: Path) -> Path:
    picks = pick_showcase(layouts)
    tiles = []
    for label, lay in picks.items():
        tile = render_event_tile(ffmpeg, video, lay, faces, video_w, video_h, label)
        tiles.append(tile)
    if not tiles:
        raise RuntimeError("no events to preview")
    cols = 2 if len(tiles) > 1 else 1
    rows = (len(tiles) + cols - 1) // cols
    collage = Image.new("RGB", (cols * video_w, rows * video_h), (0, 0, 0))
    for i, tile in enumerate(tiles):
        collage.paste(tile, ((i % cols) * video_w, (i // cols) * video_h))
    collage.save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# Burn-in gate + before/after comparison
# ---------------------------------------------------------------------------

def burn(ffmpeg: str, video: Path, subs: Path, out: Path, font_dir: Path) -> None:
    filt = f"subtitles='{subs}':fontsdir='{font_dir}'"
    cp = run([ffmpeg, "-y", "-i", str(video), "-vf", filt,
              "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
              "-c:a", "copy", str(out)])
    if cp.returncode != 0:
        raise RuntimeError(f"ffmpeg burn failed:\n{cp.stderr[-800:]}")


def compare_frames(ffmpeg: str, src: Path, burned: Path, layouts: list,
                   out_dir: Path, max_checks: int = 3) -> list:
    """Diff same-timestamp frames; verify change lands in the predicted box."""
    from PIL import ImageChops
    results = []
    checks = layouts[:max_checks]
    for lay in checks:
        t = (lay.event.start + lay.event.end) / 2
        a = grab_frame(ffmpeg, src, t)
        b = grab_frame(ffmpeg, burned, t).resize(a.size)
        diff = ImageChops.difference(a, b).convert("L")
        bbox = diff.point(lambda p: 255 if p > 24 else 0).getbbox()
        px0, py0, px1, py1 = lay.box
        ok = False
        if bbox:
            ix0, iy0 = max(bbox[0], px0), max(bbox[1], py0)
            ix1, iy1 = min(bbox[2], px1), min(bbox[3], py1)
            ok = ix0 < ix1 and iy0 < iy1
        combo = Image.new("RGB", (a.width, a.height * 2 + 40))
        combo.paste(a, (0, 0))
        combo.paste(b, (0, a.height + 40))
        d = ImageDraw.Draw(combo)
        d.rectangle([0, a.height, a.width, a.height + 40], fill=(0, 0, 0))
        d.text((8, a.height + 8),
               f"t={sec_to_ts(t)}  predicted box={lay.box}  diff bbox={bbox}  match={ok}",
               fill=(255, 255, 0))
        img_path = out_dir / f"compare_{t:.2f}s.png"
        combo.save(img_path)
        results.append({"time": sec_to_ts(t), "predicted_box": list(lay.box),
                        "diff_bbox": list(bbox) if bbox else None,
                        "position_match": ok, "image": str(img_path)})
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Subtitle preflight gate for FFmpeg burn-in")
    ap.add_argument("--video", required=True, type=Path)
    ap.add_argument("--subs", required=True, type=Path)
    ap.add_argument("--out", type=Path, help="burned output video (only written if preflight passes)")
    ap.add_argument("--font-dir", action="append", default=[],
                    help="directory with font files (repeatable)")
    ap.add_argument("--default-font", default="Noto Sans CJK SC")
    ap.add_argument("--default-size", type=float, default=48.0)
    ap.add_argument("--font-scale", type=float, default=1.0)
    ap.add_argument("--preview", type=Path, default=Path("preflight_collage.png"))
    ap.add_argument("--report", type=Path, default=Path("preflight_report.json"))
    ap.add_argument("--compare-dir", type=Path, default=Path("compare"))
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--allow-overflow", action="store_true",
                    help="treat line overflow as warning instead of error")
    args = ap.parse_args()

    font_dirs = args.font_dir or ["/usr/share/fonts", str(Path.home() / ".fonts")]
    faces = resolve_fonts(font_dirs)
    if not faces:
        print("ERROR: no usable fonts found", file=sys.stderr)
        return 2

    doc = load_subtitles(args.subs, args.default_font, args.default_size)
    if not doc.events:
        print("ERROR: no subtitle events parsed", file=sys.stderr)
        return 2

    info = probe_video(args.ffmpeg, args.video)
    vw, vh = info["width"], info["height"]

    languages = analyze_languages(doc)
    coverage = check_coverage(doc, faces)
    layouts = layout_events(doc, faces, vw, vh, args.font_scale)
    overflow = [{"start": sec_to_ts(l.event.start), "end": sec_to_ts(l.event.end),
                 "overflow_x": l.overflow_x, "overflow_y": l.overflow_y,
                 "text": l.event.text[:60]}
                for l in layouts if l.overflow_x or l.overflow_y]

    errors = [p for p in coverage]
    if overflow and not args.allow_overflow:
        errors.extend({"type": "overflow", **o} for o in overflow)

    collage_path = None
    if layouts:
        collage_path = str(build_collage(args.ffmpeg, args.video, layouts, faces,
                                         vw, vh, args.preview))

    report = {
        "video": str(args.video), "subtitles": str(args.subs),
        "video_size": [vw, vh],
        "events": len(doc.events),
        "styles": {n: {"font": s.font, "size": s.size, "alignment": s.alignment,
                       "margins": [s.margin_l, s.margin_r, s.margin_v],
                       "wrap_style": s.wrap_style}
                   for n, s in doc.styles.items()},
        "language_histogram": languages,
        "fonts_used": sorted({s.font for s in doc.styles.values()}),
        "coverage_problems": coverage,
        "overflow": overflow,
        "preview_collage": collage_path,
        "passed": not errors,
    }

    if errors:
        report["errors"] = errors
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print("PREFLIGHT FAILED — burn-in aborted:")
        for e in errors:
            if e["type"] == "missing_glyph":
                print(f"  missing glyph {e['char']!r} ({e['codepoint']} {e['name']}) "
                      f"in font '{e['font']}' at {e['start']} -> {e['end']}  ctx: {e['context']!r}")
            elif e["type"] == "missing_font":
                print(f"  font '{e['font']}' (style {e['style']}) not found, "
                      f"first used at {e['start']}")
            else:
                print(f"  overflow at {e['start']} -> {e['end']}: {e['text']!r}")
        print(f"Report: {args.report}  Collage: {collage_path}")
        return 1

    comparison = []
    if args.out:
        burn(args.ffmpeg, args.video, args.subs, args.out, Path(font_dirs[0]))
        args.compare_dir.mkdir(parents=True, exist_ok=True)
        comparison = compare_frames(args.ffmpeg, args.video, args.out, layouts,
                                    args.compare_dir)
        report["burned_output"] = str(args.out)
        report["frame_comparison"] = comparison
        if not all(c["position_match"] for c in comparison):
            report["passed"] = False
            report["errors"] = [{"type": "position_mismatch"}]
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print("POST-BURN CHECK FAILED: subtitle pixels not at predicted position")
            return 1

    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"PREFLIGHT PASSED: {len(doc.events)} events, languages={languages}")
    print(f"Collage: {collage_path}")
    if args.out:
        print(f"Burned: {args.out}")
        for c in comparison:
            print(f"  compare @{c['time']}: match={c['position_match']} -> {c['image']}")
    print(f"Report: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
