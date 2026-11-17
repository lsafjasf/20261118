// CPU reference YUV420 -> RGB converter.
// Mirrors src/shader.js semantics, including the clamp ordering:
// range de-quantization and the 3x3 matrix multiply run on raw code
// values first; results are clamped to [0,255] only at the very end.

import { coefficients, decodeCodeValue } from './yuv.js';

const clamp8 = (v) => Math.min(255, Math.max(0, v));

export function yuv420ToRgb(frame, matrixName, range) {
  const { width, height, strides, yPlane, uPlane, vPlane } = frame;
  const cw = width / 2;
  const ch = height / 2;
  const coeff = coefficients(matrixName);
  const out = new Uint8Array(width * height * 3);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      // MPEG-2 style chroma siting: nearest sample toward the top-left,
      // identical to texture(nearest) sampling in the shader.
      const cx = Math.min(cw - 1, px >> 1);
      const cy = Math.min(ch - 1, py >> 1);

      const yCode = yPlane[py * strides.y + px];
      const uCode = uPlane[cy * strides.c + cx];
      const vCode = vPlane[cy * strides.c + cx];

      const yVal = decodeCodeValue(range, 'y', yCode);
      const cb = decodeCodeValue(range, 'c', uCode);
      const cr = decodeCodeValue(range, 'c', vCode);

      // Matrix multiply happens BEFORE clamping, so out-of-gamut /
      // overshoot code values still influence the reconstructed channels.
      const r = yVal + coeff.rFromCr * cr;
      const g = yVal - coeff.gFromCb * cb - coeff.gFromCr * cr;
      const b = yVal + coeff.bFromCb * cb;

      const idx = (py * width + px) * 3;
      out[idx] = clamp8(Math.round(r * 255));
      out[idx + 1] = clamp8(Math.round(g * 255));
      out[idx + 2] = clamp8(Math.round(b * 255));
    }
  }
  return out;
}

// Single pixel as 0-255 rounded/clamped values, used by the sampler panel.
export function samplePixel(frame, matrixName, range, px, py) {
  const { strides, yPlane, uPlane, vPlane, width, height } = frame;
  const coeff = coefficients(matrixName);
  const cx = Math.min(width / 2 - 1, px >> 1);
  const cy = Math.min(height / 2 - 1, py >> 1);
  const yVal = decodeCodeValue(range, 'y', yPlane[py * strides.y + px]);
  const cb = decodeCodeValue(range, 'c', uPlane[cy * strides.c + cx]);
  const cr = decodeCodeValue(range, 'c', vPlane[cy * strides.c + cx]);
  const r = yVal + coeff.rFromCr * cr;
  const g = yVal - coeff.gFromCb * cb - coeff.gFromCr * cr;
  const b = yVal + coeff.bFromCb * cb;
  return [r, g, b].map((v) => clamp8(Math.round(v * 255)));
}
