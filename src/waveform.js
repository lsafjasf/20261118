// Renders before/after mono waveforms to a self-contained SVG string.
// Modified regions are shaded and the repaired trace is drawn on top.
'use strict';

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function renderWaveformSvg({ before, after, regions, sampleRate, width = 1200, height = 360 }) {
  const pad = 48;
  const rowH = (height - pad * 1.5) / 2;
  const n = before.length;
  const x = (i) => pad + (i / Math.max(1, n - 1)) * (width - pad * 2);
  const y = (v, rowTop) => rowTop + rowH / 2 - v * (rowH / 2) * 0.95;

  // Downsample with local min/max so transients survive at any zoom level.
  const buckets = Math.max(200, width - pad * 2);
  const trace = (data) => {
    const parts = [];
    for (let b = 0; b < buckets; b++) {
      const lo = Math.floor((b / buckets) * n);
      const hi = Math.max(lo + 1, Math.floor(((b + 1) / buckets) * n));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = lo; i < hi && i < n; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      const xb = x(lo);
      parts.push(`M${xb.toFixed(1)},${y(mx, 0).toFixed(1)}L${x(hi).toFixed(1)},${y(mn, 0).toFixed(1)}`);
    }
    return parts.join('');
  };

  const row = (data, top, color, title) => `
    <g transform="translate(0,${top})">
      <text x="${pad}" y="-8" font-size="14" fill="#cbd5e1" font-family="monospace">${escapeXml(title)}</text>
      <line x1="${pad}" y1="${rowH / 2}" x2="${width - pad}" y2="${rowH / 2}"
            stroke="#334155" stroke-width="1" stroke-dasharray="4 4"/>
      <path d="${trace(data)}" stroke="${color}" stroke-width="0.8" fill="none" opacity="0.9"/>
    </g>`;

  const shades = regions
    .map(([lo, hi]) => {
      const xa = x(lo);
      const xb = x(hi);
      return `<rect x="${xa.toFixed(1)}" y="${pad - 18}" width="${Math.max(1, xb - xa).toFixed(1)}"
        height="${rowH * 2 + 24}" fill="#f59e0b" opacity="0.16"/>
        <text x="${((xa + xb) / 2).toFixed(1)}" y="${pad - 22}" font-size="10"
          fill="#fbbf24" text-anchor="middle" font-family="monospace">${(lo / sampleRate * 1000).toFixed(1)}ms</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
  viewBox="0 0 ${width} ${height}" style="background:#0f172a">
  <style>text{font-family:monospace}</style>
  ${shades}
  ${row(before, pad, '#60a5fa', 'before (raw PCM)')}
  ${row(after, pad + rowH + pad * 0.5, '#34d399', 'after (WASM declicked)')}
  <text x="${width - pad}" y="${height - 10}" text-anchor="end" font-size="11"
        fill="#94a3b8">${n} samples @ ${sampleRate} Hz, ${regions.length} repaired region(s)</text>
</svg>`;
}

module.exports = { renderWaveformSvg };
