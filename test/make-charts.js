// Render static SVG charts from the Node test artifacts for reports/CI.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'artifacts');
const spectra = JSON.parse(fs.readFileSync(path.join(outDir, 'spectra.json'), 'utf8'));
const curve = JSON.parse(fs.readFileSync(path.join(outDir, 'reduction-curve.json'), 'utf8'));
const results = JSON.parse(fs.readFileSync(path.join(outDir, 'segment-results.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function polyline(points) {
  return points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
}

function spectrumSvg(label) {
  const w = 760;
  const h = 320;
  const m = { l: 52, r: 16, t: 28, b: 38 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const { freqs, db: before } = spectra[label].before;
  const after = spectra[label].after.db;
  const minDb = -90;
  const maxDb = -10;
  const x = (f) => m.l + (Math.log10(f / 60) / Math.log10(22050 / 60)) * iw;
  const y = (db) => m.t + ih - ((Math.max(minDb, Math.min(maxDb, db)) - minDb) / (maxDb - minDb)) * ih;
  const grid = [];
  for (let db = -80; db <= -20; db += 20) {
  grid.push(`<line x1="${m.l}" y1="${y(db)}" x2="${w - m.r}" y2="${y(db)}" stroke="#2a3550" stroke-width="1"/>`);
  grid.push(`<text x="${m.l - 6}" y="${y(db) + 3}" fill="#8b97ad" font-size="10" text-anchor="end">${db}</text>`);
  }
  const trace = (arr, color) => {
  const pts = arr.map((v, i) => [x(freqs[i]), y(v)]);
  return `<polyline points="${polyline(pts)}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };
  const fc = curve.params.crossoverFreq;
  const freqLabels = [100, 300, 1000, 3000, 10000, 20000].map((f) =>
  `<text x="${x(f)}" y="${h - 12}" fill="#8b97ad" font-size="10" text-anchor="middle">${f >= 1000 ? `${f / 1000}k` : f}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">
  <rect width="${w}" height="${h}" fill="#181f30"/>
  <text x="${m.l}" y="18" fill="#e6ebf5" font-size="13">${esc(label)} — before/after spectrum</text>
  ${grid.join('')}
  <line x1="${x(fc)}" y1="${m.t}" x2="${x(fc)}" y2="${m.t + ih}" stroke="#ffce6a" stroke-dasharray="5 4"/>
  <text x="${x(fc) + 4}" y="${m.t + 12}" fill="#ffce6a" font-size="10">${fc} Hz</text>
  ${trace(before, '#6aa7ff')}
  ${trace(after, '#57d9a3')}
  ${freqLabels}
  <rect x="${w - 190}" y="22" width="10" height="10" fill="#6aa7ff"/><text x="${w - 174}" y="31" fill="#e6ebf5" font-size="11">original</text>
  <rect x="${w - 110}" y="22" width="10" height="10" fill="#57d9a3"/><text x="${w - 94}" y="31" fill="#e6ebf5" font-size="11">processed</text>
</svg>`;
}

function curveSvg() {
  const w = 760;
  const h = 300;
  const m = { l: 52, r: 16, t: 28, b: 38 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const { curve: data, stride, sampleRate, segments, params } = curve;
  const total = data.length * stride;
  const x = (s) => m.l + (s / total) * iw;
  const y = (gr) => m.t + ih - (Math.min(24, gr) / 24) * ih;
  const bands = segments.filter((s) => s.kind !== 'silence').map((s) => {
  const color = s.kind === 'sibilant' ? 'rgba(255,122,122,0.20)'
    : s.kind === 'consonant' ? 'rgba(106,167,255,0.16)' : 'rgba(255,255,255,0.05)';
  return `<rect x="${x(s.start)}" y="${m.t}" width="${Math.max(1, x(s.end) - x(s.start))}" height="${ih}" fill="${color}"/>`;
  });
  const pts = data.map((gr, i) => [x(i * stride), y(gr)]);
  const grid = [0, 6, 12, 18, 24].map((db) =>
  `<line x1="${m.l}" y1="${y(db)}" x2="${w - m.r}" y2="${y(db)}" stroke="#2a3550"/>
   <text x="${m.l - 6}" y="${y(db) + 3}" fill="#8b97ad" font-size="10" text-anchor="end">${db}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">
  <rect width="${w}" height="${h}" fill="#181f30"/>
  <text x="${m.l}" y="18" fill="#e6ebf5" font-size="13">Gain reduction over time (dB) — fc=${params.crossoverFreq}Hz thr=${params.thresholdDb}dB max=${params.maxReductionDb}dB rel=${params.releaseMs}ms</text>
  ${bands.join('')}
  ${grid}
  <polyline points="${polyline(pts)}" fill="none" stroke="#ffce6a" stroke-width="1.6"/>
  <text x="${m.l}" y="${h - 12}" fill="#8b97ad" font-size="10">0s</text>
  <text x="${w - m.r}" y="${h - 12}" fill="#8b97ad" font-size="10" text-anchor="end">${(total / sampleRate).toFixed(2)}s</text>
</svg>`;
}

function barSvg() {
  const w = 760;
  const h = 300;
  const m = { l: 120, r: 16, t: 28, b: 38 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const kinds = [
  ['sibilant', '#ff7a7a'],
  ['consonant', '#6aa7ff'],
  ['vowel', '#57d9a3'],
  ];
  const metrics = [
  ['air (10k+) attenuation dB', 'air', true],
  ['sibilance (5-10k) attenuation dB', 'sibilance', true],
  ['low (0-2k) change dB', 'low', false],
  ['mean gain reduction dB', 'meanGR', false],
  ];
  const maxVal = 12;
  const rowH = ih / (kinds.length * metrics.length + 1);
  let rows = '';
  let idx = 0;
  for (const [kind, color] of kinds) {
  const agg = results.summary[kind];
  for (const [label, key, negate] of metrics) {
    let val = agg[key];
    if (negate) val = -val;
    const bw = Math.max(0, (Math.abs(val) / maxVal) * iw);
    const yy = m.t + idx * rowH;
    rows += `<text x="${m.l - 8}" y="${yy + rowH * 0.7}" fill="#e6ebf5" font-size="10" text-anchor="end">${kind} · ${label.split(' ')[0]}</text>
    <rect x="${m.l}" y="${yy + 2}" width="${bw}" height="${rowH - 5}" fill="${color}"/>
    <text x="${m.l + bw + 4}" y="${yy + rowH * 0.7}" fill="#e6ebf5" font-size="10">${agg[key].toFixed(2)}</text>`;
    idx += 1;
  }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">
  <rect width="${w}" height="${h}" fill="#181f30"/>
  <text x="${m.l}" y="18" fill="#e6ebf5" font-size="13">Sibilant vs normal consonant vs vowel (segment averages, dB)</text>
  ${rows}
</svg>`;
}

for (const label of Object.keys(spectra)) {
  fs.writeFileSync(path.join(outDir, `chart-spectrum-${label}.svg`), spectrumSvg(label));
}
fs.writeFileSync(path.join(outDir, 'chart-reduction-curve.svg'), curveSvg());
fs.writeFileSync(path.join(outDir, 'chart-segment-comparison.svg'), barSvg());
console.log('wrote chart-*.svg files to artifacts/');
