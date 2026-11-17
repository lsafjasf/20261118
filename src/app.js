import { makeColorBars, rgbToYuv420Frame, MATRICES, RANGES } from './yuv.js';
import { yuv420ToRgb, samplePixel } from './cpu-convert.js';
import { YuvRenderer } from './renderer.js';
import { rgbaToRgb, colorBarErrors, comparePixels, findMisalignedRow } from './metrics.js';

const WIDTH = 320;
const HEIGHT = 240;

const canvas = document.getElementById('view');
const renderer = new YuvRenderer(canvas);
const bars = makeColorBars(WIDTH, HEIGHT);

const state = {
  matrix: 'bt601',
  range: 'limited',
  strideY: WIDTH,
  strideC: WIDTH / 2,
  overshoot: false,
  frame: null,
  samplePoints: [
    [20, 120],
    [60, 120],
    [100, 120],
    [220, 60],
    [300, 200],
  ],
};

function currentCombination() {
  return `${MATRICES[state.matrix].label} / ${RANGES[state.range].label}`;
}

// Optionally write out-of-range code values into a region. These stay raw
// through upload and de-quantization; only the final RGB is clamped.
function injectOvershoot(frame) {
  if (!state.overshoot) return frame;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      frame.yPlane[y * frame.strides.y + x] = 250;
      frame.uPlane[(y >> 1) * frame.strides.c + (x >> 1)] = 10;
      frame.vPlane[(y >> 1) * frame.strides.c + (x >> 1)] = 250;
    }
  }
  return frame;
}

function rebuildFrame() {
  const frame = rgbToYuv420Frame(
    bars.rgb,
    WIDTH,
    HEIGHT,
    state.matrix,
    state.range,
    { y: state.strideY, c: state.strideC },
  );
  state.frame = injectOvershoot(frame);
}

function yuvCodesAt(frame, px, py) {
  const cx = Math.min(WIDTH / 2 - 1, px >> 1);
  const cy = Math.min(HEIGHT / 2 - 1, py >> 1);
  return [
    frame.yPlane[py * frame.strides.y + px],
    frame.uPlane[cy * frame.strides.c + cx],
    frame.vPlane[cy * frame.strides.c + cx],
  ];
}

function render() {
  renderer.render(state.frame, state.matrix, state.range);
  const rgba = renderer.readPixels(WIDTH, HEIGHT);
  const cpuRgb = yuv420ToRgb(state.frame, state.matrix, state.range);

  document.getElementById('combo').textContent = currentCombination();

  const cmp = comparePixels(rgba, cpuRgb, WIDTH, HEIGHT, state.samplePoints);
  const samplerBody = document.querySelector('#sampler tbody');
  samplerBody.innerHTML = '';
  for (const row of cmp.rows) {
    const codes = yuvCodesAt(state.frame, row.x, row.y);
    samplerBody.insertAdjacentHTML(
      'beforeend',
      `<tr><td>${row.x},${row.y}</td><td>${codes.join(', ')}</td>` +
        `<td>${row.gpu.join(', ')}</td><td>${row.cpu.join(', ')}</td>` +
        `<td>${row.maxDiff}</td></tr>`,
    );
  }

  const errs = colorBarErrors(rgba, WIDTH, HEIGHT, bars.barIndexAt);
  const errBody = document.querySelector('#errors tbody');
  errBody.innerHTML = '';
  for (const e of errs) {
    errBody.insertAdjacentHTML(
      'beforeend',
      `<tr><td>${e.name}</td><td>${e.expected.join(', ')}</td>` +
        `<td>${e.maxAbs}</td><td>${e.meanAbs.toFixed(2)}</td></tr>`,
    );
  }
  document.getElementById('clampNote').textContent =
    `整帧 GPU vs CPU 最大差: ${cmp.globalMax}（钳制仅在矩阵换算之后执行）`;
}

function rebuildAndRender() {
  rebuildFrame();
  render();
}

document.querySelectorAll('input[name="matrix"]').forEach((el) => {
  el.addEventListener('change', () => {
    state.matrix = el.value;
    rebuildAndRender();
  });
});
document.querySelectorAll('input[name="range"]').forEach((el) => {
  el.addEventListener('change', () => {
    state.range = el.value;
    rebuildAndRender();
  });
});
document.getElementById('rebuild').addEventListener('click', () => {
  state.strideY = Math.max(WIDTH, Number(document.getElementById('strideY').value) || WIDTH);
  state.strideC = Math.max(WIDTH / 2, Number(document.getElementById('strideC').value) || WIDTH / 2);
  rebuildAndRender();
});
document.getElementById('overshoot').addEventListener('change', (e) => {
  state.overshoot = e.target.checked;
  rebuildAndRender();
});

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) * (WIDTH / rect.width));
  const py = Math.floor((e.clientY - rect.top) * (HEIGHT / rect.height));
  state.samplePoints.push([px, py]);
  if (state.samplePoints.length > 8) state.samplePoints.shift();
  render();
});

// Exposed for the automated test harness.
window.__yuvApp = {
  state,
  rebuildAndRender,
  render,
  renderer,
  bars,
  setCombination(matrix, range) {
    state.matrix = matrix;
    state.range = range;
    rebuildAndRender();
  },
  setStrides(y, c) {
    state.strideY = y;
    state.strideC = c;
    document.getElementById('strideY').value = y;
    document.getElementById('strideC').value = c;
    rebuildAndRender();
  },
  setOvershoot(on) {
    state.overshoot = on;
    document.getElementById('overshoot').checked = on;
    rebuildAndRender();
  },
  readRgba() {
    return renderer.readPixels(WIDTH, HEIGHT);
  },
  rgbaToRgb,
  colorBarErrors,
  comparePixels,
  findMisalignedRow,
  constants: { WIDTH, HEIGHT, barIndexAt: bars.barIndexAt },
  cpuRgb() {
    return yuv420ToRgb(state.frame, state.matrix, state.range);
  },
  sampleCpu(px, py) {
    return samplePixel(state.frame, state.matrix, state.range, px, py);
  },
  yuvCodesAt,
};

rebuildAndRender();
