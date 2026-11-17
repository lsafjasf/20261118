// Core YUV420 color math, shared by the browser UI and the Node test suite.
// All math is plain JS so the CPU path is an independent reference for the GPU.

export const MATRICES = {
  // ITU-R BT.601 (SD), luma Kr = 0.299
  bt601: {
    label: 'BT.601',
    Kr: 0.299,
    Kb: 0.114,
  },
  // ITU-R BT.709 (HD), luma Kr = 0.2126
  bt709: {
    label: 'BT.709',
    Kr: 0.2126,
    Kb: 0.0722,
  },
};

export const RANGES = {
  limited: { label: 'Limited (16-235)' },
  full: { label: 'Full (0-255)' },
};

// Standard SMPTE color bars, 0-255 R'G'B'.
export const COLOR_BARS = [
  { name: 'white',  rgb: [255, 255, 255] },
  { name: 'yellow', rgb: [255, 255, 0] },
  { name: 'cyan',   rgb: [0, 255, 255] },
  { name: 'green',  rgb: [0, 255, 0] },
  { name: 'magenta',rgb: [255, 0, 255] },
  { name: 'red',    rgb: [255, 0, 0] },
  { name: 'blue',   rgb: [0, 0, 255] },
  { name: 'black',  rgb: [0, 0, 0] },
];

const clamp8 = (v) => Math.min(255, Math.max(0, v));
const round8 = (v) => clamp8(Math.round(v));

// Range quantization helpers: float [0,1] Y/Cb/Cr -> 8-bit code value.
function encodeRange(range) {
  if (range === 'limited') {
    return {
      y: (v) => 16 + 219 * v,
      c: (v) => 128 + 224 * v,
    };
  }
  return {
    y: (v) => 255 * v,
    c: (v) => 128 + 255 * v,
  };
}

// Inverse of encodeRange: 8-bit code value -> normalized [0,1]-ish float.
// No clamping happens here: out-of-range values keep their overshoot on purpose.
export function decodeCodeValue(range, plane, value) {
  if (range === 'limited') {
    return plane === 'y' ? (value - 16) / 219 : (value - 128) / 224;
  }
  return plane === 'y' ? value / 255 : (value - 128) / 255;
}

// Conversion coefficients derived from Kr/Kb, matching the shader exactly.
export function coefficients(matrixName) {
  const { Kr, Kb } = MATRICES[matrixName];
  const Kg = 1 - Kr - Kb;
  return {
    Kr,
    Kg,
    Kb,
    rFromCr: 2 * (1 - Kr),
    gFromCb: (2 * Kb * (1 - Kb)) / Kg,
    gFromCr: (2 * Kr * (1 - Kr)) / Kg,
    bFromCb: 2 * (1 - Kb),
  };
}

// R'G'B' (0-255) -> planar YUV420 frame with independent plane strides.
// width/height must be even for 4:2:0 chroma subsampling.
export function rgbToYuv420Frame(rgb, width, height, matrixName, range, strides) {
  const { Kr, Kb } = MATRICES[matrixName];
  const enc = encodeRange(range);
  const sy = strides?.y ?? width;
  const sc = strides?.c ?? width / 2;
  const yPlane = new Uint8Array(sy * height);
  const uPlane = new Uint8Array(sc * (height / 2));
  const vPlane = new Uint8Array(sc * (height / 2));

  const lumaAt = (x, y) => {
    const idx = (y * width + x) * 3;
    const r = rgb[idx] / 255;
    const g = rgb[idx + 1] / 255;
    const b = rgb[idx + 2] / 255;
    return Kr * r + (1 - Kr - Kb) * g + Kb * b;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      yPlane[y * sy + x] = round8(enc.y(lumaAt(x, y)));
    }
  }

  // 4:2:0: average the four co-sited luma-sized samples per chroma sample.
  for (let cy = 0; cy < height / 2; cy++) {
    for (let cx = 0; cx < width / 2; cx++) {
      let cb = 0;
      let cr = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const idx = ((cy * 2 + dy) * width + cx * 2 + dx) * 3;
        const r = rgb[idx] / 255;
        const g = rgb[idx + 1] / 255;
        const b = rgb[idx + 2] / 255;
        const yVal = Kr * r + (1 - Kr - Kb) * g + Kb * b;
        cb += (b - yVal) / (2 * (1 - Kb));
        cr += (r - yVal) / (2 * (1 - Kr));
      }
      cb /= 4;
      cr /= 4;
      uPlane[cy * sc + cx] = round8(enc.c(cb));
      vPlane[cy * sc + cx] = round8(enc.c(cr));
    }
  }

  return { width, height, strides: { y: sy, c: sc }, yPlane, uPlane, vPlane };
}

// Build an 8-bar test pattern: width divisible by 8, even height.
export function makeColorBars(width = 320, height = 240) {
  if (width % 8 !== 0 || height % 2 !== 0) {
    throw new Error('width must be divisible by 8 and height even');
  }
  const rgb = new Uint8Array(width * height * 3);
  const barW = width / 8;
  const barIndexAt = (x) => Math.min(7, Math.floor(x / barW));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bar = COLOR_BARS[barIndexAt(x)];
      const idx = (y * width + x) * 3;
      rgb[idx] = bar.rgb[0];
      rgb[idx + 1] = bar.rgb[1];
      rgb[idx + 2] = bar.rgb[2];
    }
  }
  return { rgb, width, height, barIndexAt };
}
