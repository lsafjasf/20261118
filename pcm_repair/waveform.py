"""SVG waveform renderer with highlighted repaired intervals."""

from __future__ import annotations

from html import escape
from pathlib import Path

from .audio import Audio
from .detector import RepairInterval


def _envelope_path(
    channels: list[list[float]],
    sample_channel: int,
    x0: float,
    x1: float,
    center_y: float,
    half_height: float,
    scale: float,
) -> str:
    frames = len(channels[sample_channel])
    columns = max(1, int(x1 - x0))
    commands: list[str] = []
    for column in range(columns):
        start = int(column * frames / columns)
        end = max(start + 1, int((column + 1) * frames / columns))
        values = channels[sample_channel][start:end]
        low = min(values)
        high = max(values)
        x = x0 + column + 0.5
        y_low = center_y - high * half_height / scale
        y_high = center_y - low * half_height / scale
        commands.append(f"M{x:.2f},{y_low:.2f}L{x:.2f},{y_high:.2f}")
    return "".join(commands)


def render_waveform_svg(
    damaged: Audio,
    repaired: Audio,
    intervals: list[RepairInterval],
    path: str | Path,
    title: str = "PCM transient repair",
) -> None:
    """Render A/B waveforms and every changed frame interval."""

    if damaged.channels != repaired.channels or damaged.frames != repaired.frames:
        raise ValueError("damaged and repaired audio must have the same shape")

    width = 1440
    left, right = 92, 32
    plot_width = width - left - right
    panel_height = 255
    lane_gap = 8
    top_panel_y = 112
    bottom_panel_y = 414
    axis_y = bottom_panel_y + panel_height + 25
    legend_y = axis_y + 50
    shown = intervals[:18]
    extra_rows = 1 if len(intervals) > len(shown) else 0
    height = max(760, legend_y + 28 + (len(shown) + extra_rows) * 17)
    max_amplitude = max(
        1.0e-4,
        max(abs(value) for channel in damaged.samples for value in channel),
        max(abs(value) for channel in repaired.samples for value in channel),
    )
    lane_height = (panel_height - lane_gap * (damaged.channels - 1)) / damaged.channels
    rate = damaged.sample_rate

    def frame_x(frame: int) -> float:
        return left + frame * plot_width / damaged.frames

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#11161d"/>',
        '<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;fill:#dfe7ef}'
        '.grid{stroke:#2a3440;stroke-width:1}.wave{stroke-width:1.15;fill:none}'
        '.zone{fill:#ff3b5c;opacity:.18}.zone-line{stroke:#ff5a76;stroke-width:1.2;opacity:.9}'
        '</style>',
        f'<text x="32" y="42" font-size="25" font-weight="700">{escape(title)}</text>',
        f'<text x="32" y="68" font-size="13" fill="#91a0b2">'
        f'{damaged.sample_rate} Hz · {damaged.channels} ch · '
        f'{damaged.duration:.3f} s · {damaged.sample_width * 8}-bit PCM</text>',
        f'<text x="{width-right}" y="68" text-anchor="end" font-size="13" fill="#ff8295">'
        f'{len(intervals)} modified interval(s)</text>',
    ]

    for panel_y, label, audio, color in (
        (top_panel_y, "A  DAMAGED", damaged, "#72c7ff"),
        (bottom_panel_y, "B  REPAIRED", repaired, "#5ce1b8"),
    ):
        parts.append(
            f'<rect x="{left}" y="{panel_y}" width="{plot_width}" height="{panel_height}" '
            'fill="#17202a" stroke="#303c49"/>'
        )
        parts.append(
            f'<text x="{left}" y="{panel_y - 12}" font-size="14" font-weight="700" '
            f'fill="{color}">{label}</text>'
        )
        for channel in range(damaged.channels):
            lane_y = panel_y + channel * (lane_height + lane_gap)
            center = lane_y + lane_height / 2
            parts.append(
                f'<line class="grid" x1="{left}" y1="{center:.2f}" '
                f'x2="{left + plot_width}" y2="{center:.2f}"/>'
            )
            label_text = "L" if channel == 0 else ("R" if channel == 1 else str(channel + 1))
            parts.append(
                f'<text x="{left + 8}" y="{lane_y + 17}" font-size="11" '
                f'fill="#738296">{label_text}</text>'
            )
            wave_color = color if panel_y == top_panel_y else "#5ce1b8"
            parts.append(
                f'<path class="wave" stroke="{wave_color}" d="'
                + _envelope_path(
                    audio.samples,
                    channel,
                    left,
                    left + plot_width,
                    center,
                    lane_height / 2 - 5,
                    max_amplitude,
                )
                + '"/>'
            )

    for index, interval in enumerate(intervals, start=1):
        x_start = frame_x(interval.start)
        x_end = frame_x(interval.end)
        band_width = max(4.0, x_end - x_start)
        band_x = min(x_start, left + plot_width - band_width)
        for panel_y in (top_panel_y, bottom_panel_y):
            parts.append(
                f'<rect class="zone" x="{band_x:.2f}" y="{panel_y}" '
                f'width="{band_width:.2f}" height="{panel_height}"/>'
            )
            parts.append(
                f'<line class="zone-line" x1="{x_start:.2f}" y1="{panel_y}" '
                f'x2="{x_start:.2f}" y2="{panel_y + panel_height}"/>'
            )
        label_y = top_panel_y - 35 + (index % 3) * 10
        parts.append(
            f'<text x="{x_start:.2f}" y="{label_y}" text-anchor="middle" '
            f'font-size="11" font-weight="700" fill="#ff8295">#{index}</text>'
        )

    parts.append(
        f'<line class="grid" x1="{left}" y1="{axis_y}" x2="{left + plot_width}" y2="{axis_y}"/>'
    )
    for tick in range(0, 11):
        x = left + plot_width * tick / 10
        time = damaged.duration * tick / 10
        parts.append(
            f'<line class="grid" x1="{x:.2f}" y1="{axis_y}" x2="{x:.2f}" y2="{axis_y + 6}"/>'
        )
        parts.append(
            f'<text x="{x:.2f}" y="{axis_y + 22}" text-anchor="middle" '
            f'font-size="11" fill="#8291a5">{time:.2f}s</text>'
        )

    parts.append(
        f'<text x="{left}" y="{legend_y}" font-size="13" font-weight="700" '
        'fill="#ff8295">MODIFIED INTERVALS</text>'
    )
    for row, interval in enumerate(shown):
        start_s = interval.start / rate
        end_s = interval.end / rate
        channels_text = ",".join("L" if ch == 0 else ("R" if ch == 1 else str(ch + 1))
                                  for ch in interval.channels)
        parts.append(
            f'<text x="{left}" y="{legend_y + 24 + row * 17}" font-size="11" fill="#b8c4d1">'
            f'#{row + 1:02d}  {start_s:9.6f}s → {end_s:9.6f}s  '
            f'frames {interval.start}–{interval.end - 1}  ch {channels_text}</text>'
        )
    if len(intervals) > len(shown):
        parts.append(
            f'<text x="{left}" y="{legend_y + 24 + len(shown) * 17}" '
            f'font-size="11" fill="#ff8295">+ {len(intervals) - len(shown)} more; '
            'see the JSON report for the complete list.</text>'
        )
    parts.append("</svg>")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(parts), encoding="utf-8")
