// Pure-Node tests that exercise the shared math without any GPU. The browser
// suite in browser-tests.js repeats the same checks against WebGL2 output.

import assert from 'node:assert/strict';
import {
  makeColorBars,
  rgbToYuv420Frame,
  COLOR_BARS,
  decodeCodeValue,
} from '../src/yuv.js';
import { yuv420ToRgb, samplePixel } from '../src/cpu-convert.js';
import { colorBarErrors, rgbaToRgb } from '../src/metrics.js';

const W = 320;
const H = 240;
const COMBOS = [
  ['bt601', 'limited'],
  ['bt601', 'full'],
  ['bt709', 'limited'],
  ['bt709', 'full'],
];
// Fixed pixels, one in each of five bars (bar width = 40 px).
const FIXED_POINTS = [
  [20, 120, 'white'],
  [60, 120, 'yellow'],
  [100, 120, 'cyan'],
  [220, 60, 'red'],
  [300, 200, 'black'],
];

const rgbToRgba = (rgb) => {
  const rgba = new Uint8Array(rgb.length / 3 * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return rgba;
};

export const fixedPoints = FIXED_POINTS;

export function runCpuTests() {
  const bars = makeColorBars(W, H);
  const results = { combos: [], fixedPixels: [], stride: null, clampOrder: null };

  for (const [matrix, range] of COMBOS) {
    const frame = rgbToYuv420Frame(bars.rgb, W, H, matrix, range);
    const rgb = yuv420ToRgb(frame, matrix, range);
    const errs = colorBarErrors(rgbToRgba(rgb), W, H, bars.barIndexAt);
    const worst = Math.max(...errs.map((e) => e.maxAbs));
    assert.ok(
      worst <= 3,
      `${matrix}/${range} bar round-trip error ${worst} exceeds 3`,
    );
    results.combos.push({
      combo: `${matrix}/${range}`,
      worstBarError: worst,
      perBar: errs.map((e) => `${e.name}:${e.maxAbs}`),
    });

    // Analytic anchors: white and black must reconstruct exactly after
    // range de-quantization (Y=235/16 limited, 255/0 full; C=128).
    const white = samplePixel(frame, matrix, range, 5, 5);
    const black = samplePixel(frame, matrix, range, 300, 5);
    assert.deepEqual(white, [255, 255, 255]);
    assert.deepEqual(black, [0, 0, 0]);

    for (const [px, py, name] of FIXED_POINTS) {
      results.fixedPixels.push({
        combo: `${matrix}/${range}`,
        point: `${px},${py}`,
        bar: name,
        cpu: samplePixel(frame, matrix, range, px, py),
      });
    }
  }

  // Stride sweep: padded strides must produce bit-identical RGB to tight
  // strides, and plane row indexing must follow the stride, not the width.
  const tight = rgbToYuv420Frame(bars.rgb, W, H, 'bt709', 'limited');
  const strideCases = [
    { y: 322, c: 162 },
    { y: 352, c: 176 },
    { y: 400, c: 200 },
    { y: 331, c: 167 },
  ];
  for (const strides of strideCases) {
    const padded = rgbToYuv420Frame(bars.rgb, W, H, 'bt709', 'limited', strides);
    assert.equal(padded.strides.y, strides.y);
    assert.equal(padded.strides.c, strides.c);
    const rgbPadded = yuv420ToRgb(padded, 'bt709', 'limited');
    const rgbTight = yuv420ToRgb(tight, 'bt709', 'limited');
    assert.deepEqual(Array.from(rgbPadded), Array.from(rgbTight));
    // Spot-check that row data actually starts at row * stride.
    assert.equal(padded.yPlane[10 * strides.y + 20], tight.yPlane[10 * W + 20]);
    assert.equal(padded.uPlane[5 * strides.c + 10], tight.uPlane[5 * (W / 2) + 10]);
  }
  results.stride = { cases: strideCases, status: 'all strides bit-identical' };

  // Clamp ordering: out-of-range code values must survive into the matrix.
  // Compare (a) raw overshoot frame vs (b) the same frame pre-clamped to the
  // legal limited-range envelope before conversion.
  const raw = rgbToYuv420Frame(bars.rgb, W, H, 'bt601', 'limited');
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      raw.yPlane[y * raw.strides.y + x] = 250;
      raw.uPlane[(y >> 1) * raw.strides.c + (x >> 1)] = 10;
      raw.vPlane[(y >> 1) * raw.strides.c + (x >> 1)] = 250;
    }
  }
  const preClamped = structuredClone(raw);
  for (let i = 0; i < preClamped.yPlane.length; i++) {
    preClamped.yPlane[i] = Math.min(235, Math.max(16, preClamped.yPlane[i]));
  }
  for (const plane of [preClamped.uPlane, preClamped.vPlane]) {
    for (let i = 0; i < plane.length; i++) plane[i] = Math.min(240, Math.max(16, plane[i]));
  }
  const rawPx = samplePixel(raw, 'bt601', 'limited', 5, 5);
  const clampedPx = samplePixel(preClamped, 'bt601', 'limited', 5, 5);
  assert.notDeepEqual(rawPx, clampedPx, 'overshoot must change the result');
  assert.ok(rawPx.every((v) => v >= 0 && v <= 255), 'final output must be clamped');
  // De-quantization itself is unclamped: Y=250 -> 1.068 (>1.0).
  assert.ok(decodeCodeValue('limited', 'y', 250) > 1);
  results.clampOrder = {
    rawOvershootRgb: rawPx,
    preClampedRgb: clampedPx,
    decodedY250: Number(decodeCodeValue('limited', 'y', 250).toFixed(4)),
  };

  return results;
}
