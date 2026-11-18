"""Bidirectional SRT <-> WebVTT converter.

Features:
- Comma (SRT) and dot (WebVTT) timestamp separators, normalized on output.
- BOM / UTF-8 / UTF-16 / Windows-1252 input detection; output is UTF-8.
- Inline style tags: <i>, <b>, <u> are preserved in both directions.
  Styles that cannot be expressed in the target format (e.g. <font> in
  SRT, or <c>/<v>/ruby/inline-timestamps in WebVTT) produce warnings;
  the tag is stripped but the text is always kept.
- Timestamp ordering errors raise SubtitleError identifying the exact cue.
- Cues crossing midnight (23:59:59 -> 00:00:01) are unwrapped to >= 24h.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

MS_PER_HOUR = 3_600_000
MS_PER_DAY = 24 * MS_PER_HOUR
WRAP_THRESHOLD_MS = 12 * MS_PER_HOUR


class SubtitleError(Exception):
    """Raised for malformed input, including timestamp ordering errors."""


@dataclass
class Cue:
    start_ms: int
    end_ms: int
    lines: list
    identifier: str = ""
    settings: str = ""

    @property
    def label(self) -> str:
        return self.identifier or "(no id)"


@dataclass
class ConversionReport:
    warnings: list = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


# ---------------------------------------------------------------- timestamps

_SRT_TS = re.compile(r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})")
_VTT_TS = re.compile(r"(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})")


def _to_ms(hours: int, minutes: int, seconds: int, millis: int) -> int:
    if minutes > 59 or seconds > 59:
        raise SubtitleError(
            f"invalid timestamp {hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"
        )
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def parse_srt_timestamp(text: str) -> int:
    match = _SRT_TS.fullmatch(text.strip())
    if not match:
        raise SubtitleError(f"invalid SRT timestamp: {text!r}")
    return _to_ms(*map(int, match.groups()))


def parse_vtt_timestamp(text: str) -> int:
    match = _VTT_TS.fullmatch(text.strip())
    if not match:
        raise SubtitleError(f"invalid WebVTT timestamp: {text!r}")
    hours, minutes, seconds, millis = match.groups()
    return _to_ms(int(hours or 0), int(minutes), int(seconds), int(millis))


def format_timestamp(ms: int, sep: str) -> str:
    hours, rem = divmod(ms, MS_PER_HOUR)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{sep}{millis:03d}"


def format_srt_timestamp(ms: int) -> str:
    return format_timestamp(ms, ",")


def format_vtt_timestamp(ms: int) -> str:
    return format_timestamp(ms, ".")


# ------------------------------------------------------------- order checks

def _check_cue_times(cues: list, source: str) -> None:
    """Unwrap cross-midnight cues, then validate ordering with cue locations."""
    day_offset = 0
    prev_start = 0
    for cue in cues:
        cue.start_ms += day_offset
        cue.end_ms += day_offset
        if cue.start_ms < prev_start - WRAP_THRESHOLD_MS:
            day_offset += MS_PER_DAY
            cue.start_ms += MS_PER_DAY
            cue.end_ms += MS_PER_DAY
        if (
            cue.end_ms < cue.start_ms
            and cue.end_ms + MS_PER_DAY - cue.start_ms <= WRAP_THRESHOLD_MS
        ):
            cue.end_ms += MS_PER_DAY
        if cue.end_ms <= cue.start_ms:
            raise SubtitleError(
                f"{source}: cue {cue.label} has non-positive duration: "
                f"{format_srt_timestamp(cue.start_ms)} --> "
                f"{format_srt_timestamp(cue.end_ms)}"
            )
        if cue.start_ms < prev_start:
            raise SubtitleError(
                f"{source}: cue {cue.label} starts at "
                f"{format_srt_timestamp(cue.start_ms)} before previous cue "
                f"start {format_srt_timestamp(prev_start)}"
            )
        prev_start = cue.start_ms


# --------------------------------------------------------------------- SRT

_SRT_ARROW = re.compile(r"^(.*?)\s*-->\s*(.*?)$")


def parse_srt(text: str, report: ConversionReport | None = None) -> list:
    """Parse SRT text into cues. Timestamps may use ',' or '.'."""
    cues = []
    blocks = re.split(r"\r?\n\s*\r?\n", text.replace("\r\n", "\n").strip("\n"))
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        index = ""
        if _SRT_ARROW.match(lines[0]) is None and len(lines) > 1:
            index = lines.pop(0).strip()
        if not lines or not _SRT_ARROW.match(lines[0]):
            raise SubtitleError(
                f"SRT: malformed cue near {index or lines[0]!r}: "
                "missing 'start --> end' line"
            )
        match = _SRT_ARROW.match(lines.pop(0))
        try:
            start_ms = parse_srt_timestamp(match.group(1))
            end_ms = parse_srt_timestamp(match.group(2))
        except SubtitleError as exc:
            raise SubtitleError(f"SRT: cue {index or '?'}: {exc}") from exc
        if not lines:
            raise SubtitleError(f"SRT: cue {index or '?'} has no text")
        cues.append(Cue(start_ms, end_ms, lines, identifier=index))
    for position, cue in enumerate(cues, 1):
        if not cue.identifier:
            cue.identifier = str(position)
    _check_cue_times(cues, "SRT")
    return cues


def to_srt(cues: list, report: ConversionReport | None = None) -> str:
    chunks = []
    for position, cue in enumerate(cues, 1):
        lines = [
            str(position),
            f"{format_srt_timestamp(cue.start_ms)} --> "
            f"{format_srt_timestamp(cue.end_ms)}",
            *cue.lines,
        ]
        chunks.append("\n".join(lines))
    return "\n\n".join(chunks) + "\n"


# ------------------------------------------------------------------ WebVTT

_VTT_TIMING = re.compile(
    r"^(" + _VTT_TS.pattern + r")\s+-->\s+(" + _VTT_TS.pattern + r")(.*)$"
)


def parse_vtt(text: str, report: ConversionReport | None = None) -> list:
    """Parse WebVTT text into cues, skipping NOTE/STYLE/REGION blocks."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if not lines or not lines[0].lstrip("\ufeff").startswith("WEBVTT"):
        raise SubtitleError("WebVTT: missing 'WEBVTT' header")
    cues = []
    index = 1
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if line.startswith(("NOTE", "STYLE", "REGION")):
            while index < len(lines) and lines[index].strip():
                index += 1
            continue
        identifier = ""
        timing = _VTT_TIMING.match(line)
        if not timing and index + 1 < len(lines):
            maybe = _VTT_TIMING.match(lines[index + 1])
            if maybe:
                identifier = line.strip()
                index += 1
                timing = maybe
        if not timing:
            raise SubtitleError(
                f"WebVTT: malformed cue near line {index + 1}: {line!r}"
            )
        start_ms = parse_vtt_timestamp(timing.group(1))
        end_ms = parse_vtt_timestamp(timing.group(6))
        settings = timing.group(11).strip()
        index += 1
        payload = []
        while index < len(lines) and lines[index].strip():
            payload.append(lines[index])
            index += 1
        if not payload:
            raise SubtitleError(
                f"WebVTT: cue {identifier or '?'} has no text"
            )
        cues.append(Cue(start_ms, end_ms, payload, identifier, settings))
    _check_cue_times(cues, "WebVTT")
    return cues


def to_vtt(cues: list, report: ConversionReport | None = None) -> str:
    chunks = []
    for cue in cues:
        lines = []
        if cue.identifier:
            lines.append(cue.identifier)
        timing = (
            f"{format_vtt_timestamp(cue.start_ms)} --> "
            f"{format_vtt_timestamp(cue.end_ms)}"
        )
        if cue.settings:
            timing += " " + cue.settings
        lines.append(timing)
        lines.extend(cue.lines)
        chunks.append("\n".join(lines))
    return "WEBVTT\n\n" + "\n\n".join(chunks) + "\n"


# ------------------------------------------------------------- tag mapping

_TAG = re.compile(r"</?([A-Za-z][^>/]*)[^>]*>|</([A-Za-z]+)>")
_VTT_INLINE_TS = re.compile(r"<" + _VTT_TS.pattern + r">")


def convert_tags(text: str, target: str, cue_label: str,
                 report: ConversionReport) -> str:
    """Map inline tags between SRT and WebVTT.

    <i>, <b>, <u> survive both directions. Anything the target format
    cannot express is stripped with a warning; the text is never dropped.
    """
    if target == "vtt":
        def repl(match: re.Match) -> str:
            raw = match.group(0)
            name = (match.group(1) or match.group(2) or "").lower()
            if name in ("i", "b", "u"):
                return raw
            report.warn(
                f"cue {cue_label}: tag {raw!r} has no WebVTT equivalent; "
                "keeping text only"
            )
            return ""
        return _TAG.sub(repl, text)

    # target == "srt"
    def repl(match: re.Match) -> str:
        raw = match.group(0)
        name = (match.group(1) or match.group(2) or "").lower()
        base = name.split(".")[0].split()[0]
        if base in ("i", "b", "u"):
            return raw
        report.warn(
            f"cue {cue_label}: WebVTT tag {raw!r} cannot be expressed in "
            "SRT; keeping text only"
        )
        return ""

    if _VTT_INLINE_TS.search(text):
        report.warn(
            f"cue {cue_label}: WebVTT inline timestamp tags removed; "
            "text kept"
        )
        text = _VTT_INLINE_TS.sub("", text)
    return _TAG.sub(repl, text)


def convert_cue_tags(cues: list, target: str, report: ConversionReport) -> None:
    for cue in cues:
        cue.lines = [
            convert_tags(line, target, cue.label, report) for line in cue.lines
        ]
        if target == "srt" and cue.settings:
            report.warn(
                f"cue {cue.label}: WebVTT cue settings "
                f"{cue.settings!r} dropped (not supported by SRT)"
            )
            cue.settings = ""


# ----------------------------------------------------------------- encoding

def decode_subtitle(data: bytes) -> str:
    """Decode bytes honoring BOMs, then UTF-8, falling back to Windows-1252."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252")


def detect_format(text: str) -> str:
    return "vtt" if text.lstrip("\ufeff \t\r\n").startswith("WEBVTT") else "srt"


# ---------------------------------------------------------------------- API

def convert_text(text: str, target: str,
                 report: ConversionReport | None = None) -> str:
    """Convert subtitle text to 'srt' or 'vtt'."""
    report = report or ConversionReport()
    source = detect_format(text)
    if source == target:
        raise SubtitleError(f"input is already {target.upper()}")
    cues = parse_vtt(text, report) if source == "vtt" else parse_srt(text, report)
    convert_cue_tags(cues, target, report)
    return to_vtt(cues, report) if target == "vtt" else to_srt(cues, report)


def convert_file(input_path: str, output_path: str) -> ConversionReport:
    with open(input_path, "rb") as handle:
        text = decode_subtitle(handle.read())
    target = "vtt" if output_path.lower().endswith(".vtt") else "srt"
    report = ConversionReport()
    output = convert_text(text, target, report)
    with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(output)
    return report


def main(argv: list) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} INPUT.(srt|vtt) OUTPUT.(srt|vtt)",
              file=sys.stderr)
        return 2
    try:
        report = convert_file(argv[1], argv[2])
    except (SubtitleError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for warning in report.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
