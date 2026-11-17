"""Cross-chunk consistency checks for Broadcast WAV files."""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import bext as bext_mod
from . import cue as cue_mod
from . import fmt as fmt_mod
from . import ixml as ixml_mod
from .riff import WaveFile


@dataclass
class Finding:
    severity: str        # "error" | "warning" | "info"
    field: str           # dotted field name, e.g. "bext.time_reference"
    offset: int | None   # absolute file offset, None if not applicable
    message: str

    def __str__(self) -> str:
        loc = f" @ 0x{self.offset:08x}" if self.offset is not None else ""
        return f"[{self.severity:7s}] {self.field}{loc}: {self.message}"


def _hms_from_samples(samples: int, rate: int) -> str:
    secs = samples // rate
    return f"{secs // 3600:02d}:{(secs % 3600) // 60:02d}:{secs % 60:02d}"


def check_wave(wave: WaveFile) -> list[Finding]:
    out: list[Finding] = []
    fmt_chunk = wave.find(b"fmt ")
    bext_chunk = wave.find(b"bext")
    ixml_chunk = wave.find(b"iXML")
    cue_chunk = wave.find(b"cue ")

    fmt = fmt_mod.parse_fmt(fmt_chunk) if fmt_chunk else None
    if fmt is None:
        out.append(Finding("error", "fmt", None, "missing fmt chunk"))
    bext = None
    if bext_chunk is None:
        out.append(Finding("error", "bext", None,
                           "missing bext chunk (not a valid Broadcast WAV)"))
    else:
        bext = bext_mod.parse_bext(bext_chunk)
    ixml = ixml_mod.parse_ixml(ixml_chunk) if ixml_chunk else None
    if ixml_chunk is None:
        out.append(Finding("warning", "iXML", None, "missing iXML chunk"))
    cues = None
    if cue_chunk:
        cues = cue_mod.parse_cue(cue_chunk)
        cue_mod.attach_labels(wave, cues)

    for c in wave.chunks:
        if not c.known:
            out.append(Finding(
                "warning", c.cid.decode("latin-1"), c.offset,
                f"unknown chunk id {c.cid!r}, size {c.size} bytes"))

    if fmt:
        out.extend(_check_fmt(fmt))
    if bext and fmt:
        out.extend(_check_bext_vs_fmt(bext, fmt))
    if bext and ixml:
        out.extend(_check_bext_vs_ixml(bext, ixml))
    if ixml and cues:
        out.extend(_check_scene_vs_cues(ixml, cues))
    return out


def _check_fmt(fmt: fmt_mod.FmtInfo) -> list[Finding]:
    out = []
    expect_align = fmt.channels * fmt.bits_per_sample // 8
    if fmt.block_align != expect_align:
        out.append(Finding(
            "error", "fmt.block_align", fmt.off(12),
            f"block_align {fmt.block_align} != channels*bits/8 "
            f"({expect_align})"))
    if fmt.byte_rate != fmt.sample_rate * fmt.block_align:
        out.append(Finding(
            "error", "fmt.byte_rate", fmt.off(8),
            f"byte_rate {fmt.byte_rate} != sample_rate*block_align "
            f"({fmt.sample_rate * fmt.block_align})"))
    if fmt.audio_format == fmt_mod.WAVE_FORMAT_EXTENSIBLE:
        mask = fmt.channel_mask or 0
        n_bits = bin(mask).count("1")
        if mask and n_bits != fmt.channels:
            out.append(Finding(
                "error", "fmt.channel_mask", fmt.off(20),
                f"channel mask 0x{mask:x} names {n_bits} speakers but "
                f"channel count is {fmt.channels}"))
        if fmt.sub_format not in (fmt_mod.WAVE_FORMAT_PCM,
                                  fmt_mod.WAVE_FORMAT_IEEE_FLOAT):
            out.append(Finding(
                "error", "fmt.sub_format_guid", fmt.off(24),
                f"unsupported extensible sub-format {fmt.sub_format}"))
        if fmt.valid_bits and fmt.valid_bits > fmt.bits_per_sample:
            out.append(Finding(
                "error", "fmt.valid_bits", fmt.off(18),
                f"valid bits {fmt.valid_bits} > bits per sample "
                f"{fmt.bits_per_sample}"))
    return out


def _check_bext_vs_fmt(bext: bext_mod.BextInfo,
                       fmt: fmt_mod.FmtInfo) -> list[Finding]:
    out = []
    rate = fmt.sample_rate
    per_day = rate * 86400
    if bext.time_reference >= per_day:
        out.append(Finding(
            "error", "bext.time_reference",
            bext.field_offset("time_reference"),
            f"time reference {bext.time_reference} exceeds samples per day "
            f"({per_day}) at {rate} Hz"))
    m = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2})", bext.origination_time)
    if m and bext.time_reference < per_day:
        h, mi, s = (int(g) for g in m.groups())
        expect = ((h * 3600 + mi * 60 + s) * rate)
        if abs(bext.time_reference - expect) >= rate:
            out.append(Finding(
                "error", "bext.time_reference",
                bext.field_offset("time_reference"),
                f"time reference {_hms_from_samples(bext.time_reference, rate)}"
                f" disagrees with bext.origination_time "
                f"{bext.origination_time} @ 0x"
                f"{bext.field_offset('origination_time'):08x}"))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", bext.origination_date or ""):
        out.append(Finding(
            "warning", "bext.origination_date",
            bext.field_offset("origination_date"),
            f"date {bext.origination_date!r} is not YYYY-MM-DD"))
    return out


def _check_bext_vs_ixml(bext: bext_mod.BextInfo,
                        ixml: ixml_mod.IxmlInfo) -> list[Finding]:
    out = []
    ixml_ref = ixml.time_reference
    if ixml_ref is not None and ixml_ref != bext.time_reference:
        out.append(Finding(
            "error", "iXML.BEXT/BWF_TIME_REFERENCE",
            ixml.element_offset("BEXT/BWF_TIME_REFERENCE_LOW"),
            f"iXML time reference {ixml_ref} != bext.time_reference "
            f"{bext.time_reference} @ 0x"
            f"{bext.field_offset('time_reference'):08x}"))
    pairs = [
        ("BEXT/BWF_ORIGINATION_DATE", "origination_date"),
        ("BEXT/BWF_ORIGINATION_TIME", "origination_time"),
        ("BEXT/BWF_ORIGINATOR_REFERENCE", "originator_reference"),
    ]
    for ixml_key, bext_key in pairs:
        iv = ixml.values.get(ixml_key)
        bv = getattr(bext, bext_key)
        if iv is not None and iv != bv:
            out.append(Finding(
                "error", f"iXML.{ixml_key}", ixml.element_offset(ixml_key),
                f"iXML value {iv!r} != bext.{bext_key} {bv!r} @ 0x"
                f"{bext.field_offset(bext_key):08x}"))
    return out


def _check_scene_vs_cues(ixml: ixml_mod.IxmlInfo,
                         cues: cue_mod.CueInfo) -> list[Finding]:
    out = []
    scene = ixml.values.get("SCENE")
    if not scene:
        return out
    scene_labels = [p for p in cues.points
                    if p.label and p.label.lower().startswith("scene")]
    if not scene_labels:
        out.append(Finding(
            "warning", "cue", cues.chunk.offset,
            f"iXML SCENE is {scene!r} but no cue label marks a scene"))
        return out
    for pt in scene_labels:
        m = re.search(r"scene\s+(\S+)", pt.label, re.IGNORECASE)
        if m and m.group(1) != scene:
            out.append(Finding(
                "error", "cue.label", pt.label_offset,
                f"cue {pt.cue_id} label {pt.label!r} names scene "
                f"{m.group(1)!r} but iXML SCENE is {scene!r} @ 0x"
                f"{ixml.element_offset('SCENE') or 0:08x}"))
    return out
