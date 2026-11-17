from __future__ import annotations

import re
import math
import xml.etree.ElementTree as ET

from .model import Manifest, Period, Representation, Segment, Template

DASH_NS = "urn:mpeg:dash:schema:mpd:2011"


def _ns(tag: str) -> str:
    return f"{{{DASH_NS}}}{tag}"


_DURATION_RE = re.compile(
    r"^P(?:(?P<days>\d+(?:\.\d+)?)D)?"
    r"(?:T(?:(?P<hours>\d+(?:\.\d+)?)H)?"
    r"(?:(?P<minutes>\d+(?:\.\d+)?)M)?"
    r"(?:(?P<seconds>\d+(?:\.\d+)?)S)?)?$"
)


def parse_iso8601_duration(text: str | None) -> float | None:
    if text is None:
        return None
    match = _DURATION_RE.match(text.strip())
    if not match:
        raise ValueError(f"unsupported ISO 8601 duration: {text!r}")
    parts = match.groupdict()
    days = float(parts["days"] or 0)
    hours = float(parts["hours"] or 0)
    minutes = float(parts["minutes"] or 0)
    seconds = float(parts["seconds"] or 0)
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _find(parent: ET.Element, tag: str) -> ET.Element | None:
    return parent.find(_ns(tag))


def _findall(parent: ET.Element, tag: str) -> list[ET.Element]:
    return parent.findall(_ns(tag))


def _merge_templates(parent_el: ET.Element, rep_el: ET.Element) -> Template:
    parent_tpl = _find(parent_el, "SegmentTemplate")
    rep_tpl = _find(rep_el, "SegmentTemplate")
    base = Template()
    for element in (parent_tpl, rep_tpl):
        if element is None:
            continue
        for attr, value in element.attrib.items():
            name = attr.split("}", 1)[-1]
            if name == "timescale":
                base.timescale = int(value)
            elif name == "presentationTimeOffset":
                base.presentation_time_offset = int(value)
            elif name == "startNumber":
                base.start_number = int(value)
            elif name == "duration":
                base.duration_ticks = int(value)
            elif name == "media":
                base.media = value
            elif name == "initialization":
                base.initialization = value
            elif name == "sapType":
                base.sap_type = int(value)
    return base


def _parse_timeline(template_el: ET.Element | None) -> list[tuple[int, int]]:
    if template_el is None:
        return []
    timeline_el = _find(template_el, "SegmentTimeline")
    if timeline_el is None:
        return []
    entries: list[tuple[int, int]] = []
    current_time: int | None = None
    for s_el in _findall(timeline_el, "S"):
        explicit_time = s_el.get("t")
        if explicit_time is not None:
            current_time = int(explicit_time)
        if current_time is None:
            current_time = 0
        repeat = int(s_el.get("r", 0))
        duration = int(s_el.get("d"))
        for _ in range(repeat + 1):
            entries.append((current_time, duration))
            current_time += duration
    return entries


def _format_number(pattern: str, number: int) -> str:
    match = re.search(r"\$Number(?:%0(\d+)[du])?\$", pattern)
    if not match:
        return pattern
    width = int(match.group(1)) if match.group(1) else 1
    return pattern.replace(match.group(0), str(number).zfill(width))


def build_segment_url(pattern: str, rep_id: str, number: int, media_time: int) -> str:
    url = pattern
    url = url.replace("$RepresentationID$", rep_id)
    url = _format_number(url, number)
    url = url.replace("$Time$", str(media_time))
    url = url.replace("$$", "$")
    return url


def build_initialization_url(pattern: str, rep_id: str) -> str:
    return pattern.replace("$RepresentationID$", rep_id).replace("$$", "$")


def _segments_from_timeline(
    template: Template,
    timeline: list[tuple[int, int]],
    period_start_s: float,
    rep_id: str,
) -> list[Segment]:
    segments: list[Segment] = []
    number = template.start_number
    for media_time, duration_ticks in timeline:
        duration_s = duration_ticks / template.timescale
        relative_s = (media_time - template.presentation_time_offset) / template.timescale
        presentation_start_s = period_start_s + relative_s
        url = build_segment_url(template.media or "", rep_id, number, media_time)
        segments.append(
            Segment(
                number=number,
                media_time=media_time,
                duration_ticks=duration_ticks,
                url=url,
                period_relative_s=relative_s,
                duration_s=duration_s,
                presentation_start_s=presentation_start_s,
                presentation_end_s=presentation_start_s + duration_s,
                sap_type=template.sap_type,
            )
        )
        number += 1
    return segments


def _segments_from_fixed_duration(
    template: Template, period: Period, number_of_segments: int, rep_id: str
) -> list[Segment]:
    segments: list[Segment] = []
    if template.duration_ticks is None:
        return segments
    number = template.start_number
    for index in range(number_of_segments):
        media_time = template.presentation_time_offset + index * template.duration_ticks
        duration_s = template.duration_ticks / template.timescale
        relative_s = index * duration_s
        presentation_start_s = period.start_s + relative_s
        url = build_segment_url(template.media or "", rep_id, number, media_time)
        segments.append(
            Segment(
                number=number,
                media_time=media_time,
                duration_ticks=template.duration_ticks,
                url=url,
                period_relative_s=relative_s,
                duration_s=duration_s,
                presentation_start_s=presentation_start_s,
                presentation_end_s=presentation_start_s + duration_s,
                sap_type=template.sap_type,
            )
        )
        number += 1
    return segments


def parse_mpd(path: str) -> Manifest:
    root = ET.parse(path).getroot()
    duration = parse_iso8601_duration(root.get("mediaPresentationDuration"))
    periods: list[Period] = []
    for period_el in _findall(root, "Period"):
        period = Period(
            id=period_el.get("id", f"period-{len(periods) + 1}"),
            start_s=parse_iso8601_duration(period_el.get("start")) or 0.0,
            duration_s=parse_iso8601_duration(period_el.get("duration")),
        )
        for adaptation_el in _findall(period_el, "AdaptationSet"):
            parent_tpl_el = _find(adaptation_el, "SegmentTemplate")
            for rep_el in _findall(adaptation_el, "Representation"):
                template = _merge_templates(adaptation_el, rep_el)
                representation = Representation(
                    id=rep_el.get("id"), period_id=period.id, template=template
                )
                timeline = _parse_timeline(parent_tpl_el)
                if timeline:
                    representation.segments = _segments_from_timeline(
                        template, timeline, period.start_s, representation.id
                    )
                elif template.duration_ticks is not None and period.duration_s is not None:
                    count = math.ceil(
                        period.duration_s * template.timescale
                        / template.duration_ticks
                        - 1e-9
                    )
                    representation.segments = _segments_from_fixed_duration(
                        template, period, count, representation.id
                    )
                period.representations.append(representation)
        periods.append(period)
    return Manifest(path=path, media_presentation_duration_s=duration, periods=periods)
