// Error metrics: per-color-bar reconstruction error and whole-frame CPU/GPU
// comparison. GPU pixels come from FBO readPixels (RGBA, top-row first).

import { COLOR_BARS } from './yuv.js';

export function rgbaToRgb(rgba) {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

// Per-bar max absolute error against the original SMPTE bar colors.
export function colorBarErrors(rgba, width, height, barIndexAt) {
  return COLOR_BARS.map((bar, barIdx) => {
    let maxErr = 0;
    let sumErr = 0;
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (barIndexAt(x) !== barIdx) continue;
        const p = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const err = Math.abs(rgba[p + ch] - bar.rgb[ch]);
          maxErr = Math.max(maxErr, err);
          sumErr += err;
          count++;
        }
      }
    }
    return {
      name: bar.name,
      expected: bar.rgb,
      maxAbs: maxErr,
      meanAbs: count ? sumErr / count : 0,
    };
  });
}

// Compare two RGB(A) buffers at a set of fixed pixels; returns per-pixel data
// plus the global max absolute error across the whole frame.
export function comparePixels(rgba, cpuRgb, width, height, points) {
  let globalMax = 0;
  for (let i = 0, n = width * height; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      globalMax = Math.max(globalMax, Math.abs(rgba[i * 4 + ch] - cpuRgb[i * 3 + ch]));
    }
  }
  const rows = points.map(([px, py]) => {
    const gi = (py * width + px) * 4;
    const ci = (py * width + px) * 3;
    const gpu = [rgba[gi], rgba[gi + 1], rgba[gi + 2]];
    const cpu = [cpuRgb[ci], cpuRgb[ci + 1], cpuRgb[ci + 2]];
    return {
      x: px,
      y: py,
      gpu,
      cpu,
      maxDiff: Math.max(...gpu.map((v, ch) => Math.abs(v - cpu[ch]))),
    };
  });
  return { globalMax, rows };
}

// Row continuity check for stride tests: every row inside a bar must equal
// the top row of that bar. Returns the first mismatching row or null.
export function findMisalignedRow(rgba, width, height, barIndexAt) {
  const reference = new Map();
  for (let x = 0; x < width; x++) {
    const bar = barIndexAt(x);
    if (!reference.has(bar)) reference.set(bar, rgba.slice(x * 4, x * 4 + 4));
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ref = reference.get(barIndexAt(x));
      const p = (y * width + x) * 4;
      if (ref.some((v, ch) => rgba[p + ch] !== v)) {
        return { row: y, x };
      }
    }
  }
  return null;
}
