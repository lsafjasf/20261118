"""Static HTML/SVG reports without third-party JavaScript."""

from __future__ import annotations

import html
import math
from pathlib import Path

from .analysis import DriftResult
from .wavio import read_wav, to_mono


def _svg_polyline(points: list[tuple[float, float]]) -> str:
    return " ".join(f"{x:.3f},{y:.3f}" for x, y in points)


def _waveform_points(signal: list[float], width: float, height: float, bins: int = 700):
    step = max(1, len(signal) // bins)
    points = []
    for index in range(0, len(signal), step):
        block = signal[index : index + step]
        minimum = min(block)
        maximum = max(block)
        x = width * index / max(1, len(signal) - 1)
        points.append((x, height / 2.0 - maximum * height / 2.2))
        points.append((x, height / 2.0 - minimum * height / 2.2))
    return points


def _drift_svg(result: DriftResult) -> str:
    width, height, margin = 900.0, 330.0, 58.0
    times = [point.time for point in result.points]
    offsets_ms = [point.offset * 1000.0 for point in result.points]
    fit_values = [
        (result.intercept + result.slope * time) * 1000.0 for time in times
    ]
    values = offsets_ms + fit_values
    min_t, max_t = min(times), max(times)
    min_v, max_v = min(values), max(values)
    pad_v = max((max_v - min_v) * 0.12, 0.05)
    min_v -= pad_v
    max_v += pad_v

    def x(value):
        return margin + (value - min_t) / (max_t - min_t) * (width - 2 * margin)

    def y(value):
        return height - margin - (value - min_v) / (max_v - min_v) * (
            height - 2 * margin
        )

    line = [(x(times[0]), y(fit_values[0])), (x(times[-1]), y(fit_values[-1]))]
    inliers = [
        (x(point.time), y(point.offset * 1000.0))
        for point in result.points
        if point.inlier
    ]
    outliers = [
        (x(point.time), y(point.offset * 1000.0))
        for point in result.points
        if not point.inlier
    ]
    return f"""
<svg viewBox="0 0 {width} {height}" role="img" aria-label="Drift fit">
  <rect width="{width}" height="{height}" class="panel"/>
  <line x1="{margin}" y1="{height-margin}" x2="{width-margin}" y2="{height-margin}" class="axis"/>
  <line x1="{margin}" y1="{margin}" x2="{margin}" y2="{height-margin}" class="axis"/>
  <polyline points="{_svg_polyline(line)}" class="fit-line"/>
  {''.join(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="4.5" class="inlier"/>' for px, py in inliers)}
  {''.join(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="5.0" class="outlier"/>' for px, py in outliers)}
  <text x="{width/2}" y="{height-14}" text-anchor="middle">Time (s)</text>
  <text transform="translate(18 {height/2}) rotate(-90)" text-anchor="middle">Offset (ms)</text>
</svg>"""


def _residual_svg(result: DriftResult) -> str:
    width, height, margin = 900.0, 210.0, 58.0
    residuals = [
        (point.offset - (result.intercept + result.slope * point.time)) * 1000.0
        for point in result.points
    ]
    limit = max(abs(min(residuals)), abs(max(residuals)), 0.02)
    zero_y = height / 2.0
    step = (width - 2 * margin) / max(1, len(residuals) - 1)
    bars = []
    for index, value in enumerate(residuals):
        x = margin + index * step - 4.0
        y = zero_y if value >= 0 else zero_y + value * 38.0
        bar_height = max(1.0, abs(value) * 38.0)
        bars.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="8" height="{bar_height:.2f}" class="bar"/>')
    return f"""
<svg viewBox="0 0 {width} {height}" role="img" aria-label="Fit residuals">
  <rect width="{width}" height="{height}" class="panel"/>
  <line x1="{margin}" y1="{zero_y}" x2="{width-margin}" y2="{zero_y}" class="zero"/>
  {''.join(bars)}
  <text x="{width/2}" y="{height-12}" text-anchor="middle">Measurement point</text>
  <text transform="translate(18 {height/2}) rotate(-90)" text-anchor="middle">Residual (ms)</text>
</svg>"""


def _waveform_svg(path: str, label: str) -> str:
    channels, _ = read_wav(path)
    signal = to_mono(channels)
    points = _waveform_points(signal, 900.0, 180.0)
    return f"""
<h3>{html.escape(label)}</h3>
<svg viewBox="0 0 900 180" role="img" aria-label="{html.escape(label)} waveform">
  <rect width="900" height="180" class="panel"/>
  <polyline points="{_svg_polyline(points)}" class="wave-line"/>
</svg>"""


def write_report(
    output: str,
    result: DriftResult,
    reference_path: str,
    candidate_path: str,
    corrected_path: str | None = None,
    metrics: dict[str, object] | None = None,
) -> None:
    metrics = metrics or {}
    corrected_waveform = (
        _waveform_svg(corrected_path, "Corrected waveform")
        if corrected_path and Path(corrected_path).exists()
        else ""
    )
    rows = "".join(
        f"<tr><td>{point.time:.3f}</td><td>{point.offset*1000:.4f}</td>"
        f"<td>{point.confidence:.4f}</td><td>{'yes' if point.inlier else 'no'}</td></tr>"
        for point in result.points
    )
    metric_cards = "".join(
        f"<div class='card'><span>{html.escape(key.replace('_', ' ').title())}</span>"
        f"<strong>{html.escape(str(value))}</strong></div>"
        for key, value in metrics.items()
    )
    document = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Audio Clock Drift Report</title>
<style>
body {{ margin: 0; font-family: system-ui, sans-serif; background: #f5f7fb; color: #172033; }}
main {{ max-width: 1040px; margin: 0 auto; padding: 32px; }}
h1 {{ margin: 0 0 8px; }} h2 {{ margin-top: 32px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }}
.card, section {{ background: white; border: 1px solid #dce3ee; border-radius: 14px; padding: 16px; }}
.card span {{ display: block; color: #627089; font-size: 12px; text-transform: uppercase; }}
.card strong {{ display: block; margin-top: 7px; font-size: 18px; overflow-wrap: anywhere; }}
svg {{ width: 100%; height: auto; }}
.panel {{ fill: #fbfcff; stroke: #dce3ee; }} .axis, .zero {{ stroke: #8190a8; stroke-width: 1; }}
.fit-line {{ fill: none; stroke: #2563eb; stroke-width: 2.5; }}
.inlier {{ fill: #0f766e; }} .outlier {{ fill: #dc2626; }} .bar {{ fill: #7c3aed; }}
.wave-line {{ fill: none; stroke: #334155; stroke-width: 0.8; }}
table {{ width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; }}
th, td {{ padding: 9px 10px; border-bottom: 1px solid #e5eaf2; text-align: right; }}
th:first-child, td:first-child {{ text-align: left; }} th {{ background: #eef2ff; }}
code {{ background: #eef2ff; padding: 2px 5px; border-radius: 5px; }}
</style>
</head>
<body><main>
<h1>Audio Clock Drift Report</h1>
<p>Offset model: <code>offset(t) = {result.intercept*1000:.4f} ms + {result.slope*1000:.4f} ms/s · t</code></p>
<div class="grid">
  <div class="card"><span>Nominal Rate</span><strong>{result.rate} Hz</strong></div>
  <div class="card"><span>Estimated Actual Rate</span><strong>{result.estimated_actual_rate:.3f} Hz</strong></div>
  <div class="card"><span>Relative Drift</span><strong>{result.relative_rate_ppm:.1f} ppm</strong></div>
  <div class="card"><span>Resample Ratio</span><strong>{result.resample_ratio:.9f}</strong></div>
  <div class="card"><span>Fit Residual RMS</span><strong>{result.residual_rms_seconds*1000:.4f} ms</strong></div>
  <div class="card"><span>Mean Correlation</span><strong>{result.confidence_mean:.4f}</strong></div>
</div>
{f'<h2>Validation Metrics</h2><div class="grid">{metric_cards}</div>' if metric_cards else ''}
<h2>Offset Points And Linear Fit</h2>{_drift_svg(result)}
<h2>Remaining Fit Error</h2>{_residual_svg(result)}
<h2>Waveforms</h2>{_waveform_svg(reference_path, "Reference waveform")}
{_waveform_svg(candidate_path, "Drifted input waveform")}{corrected_waveform}
<h2>Measurements</h2><table><thead><tr><th>Time</th><th>Offset</th><th>Confidence</th><th>Inlier</th></tr></thead>
<tbody>{rows}</tbody></table>
</main></body></html>"""
    Path(output).write_text(document, encoding="utf-8")
