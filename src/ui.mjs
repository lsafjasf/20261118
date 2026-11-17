import {
  STRAIGHT,
  PREMULTIPLIED,
  compositePixel,
  renderFrame,
  blendOverBackground,
} from './compositor.mjs';
import { makeScene } from './scene.mjs';
import { encodePngBrowser } from './png-browser.mjs';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const scene = makeScene(0);

let mode = STRAIGHT;
let bg = [255, 255, 255];
let probe = null;
let lastFrame = null;

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value === 'premultiplied'
    ? PREMULTIPLIED
    : STRAIGHT;
}

function render() {
  mode = currentMode();
  lastFrame = renderFrame(scene, mode);
  ctx.putImageData(new ImageData(lastFrame.straight, scene.width, scene.height), 0, 0);
  if (probe) showInspector(probe[0], probe[1]);
}

function buildLayerControls() {
  const host = document.getElementById('layers');
  scene.layers.forEach((layer, idx) => {
    const hex = '#' + layer.color.map((c) => c.toString(16).padStart(2, '0')).join('');
    const label = document.createElement('label');
    label.innerHTML =
      `<span class="swatch" style="background:${hex}"></span>${layer.name} ` +
      `<input type="color" data-i="${idx}" class="color" value="${hex}" /> ` +
      `α <input type="range" min="0" max="255" value="${layer.alpha}" data-i="${idx}" class="alpha" /> ` +
      `<span class="aval">${layer.alpha}</span>`;
    host.appendChild(label);
  });
  host.addEventListener('input', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.classList.contains('color')) {
      const v = e.target.value;
      scene.layers[i].color = [1, 3, 5].map((o) => parseInt(v.slice(o, o + 2), 16));
      e.target.closest('label').querySelector('.swatch').style.background = v;
    } else if (e.target.classList.contains('alpha')) {
      scene.layers[i].alpha = Number(e.target.value);
      e.target.parentElement.querySelector('.aval').textContent = e.target.value;
    }
    render();
  });
}

function fmt(px) {
  return `R${px[0]} G${px[1]} B${px[2]} A${px[3]}`;
}

function showInspector(x, y) {
  const { steps, finalPremul, finalStraight } = compositePixel(scene.layers, x, y, mode);
  const onBg = blendOverBackground(finalPremul, bg);
  document.getElementById('probe').textContent = `像素 (${x}, ${y}) — ${mode === STRAIGHT ? '直通' : '预乘'} Alpha 输入`;
  let rows = steps
    .map(
      (s, i) =>
        `<tr><td><span class="swatch" style="background:rgb(${s.layer.color})"></span>${s.layer.name}</td>` +
        `<td>${fmt(s.input)}</td><td>${fmt(s.premul)}</td><td>${fmt(s.acc)}</td></tr>`
    )
    .join('');
  document.getElementById('inspector').innerHTML = `
    <table>
      <tr><th>步骤</th><th>输入 RGBA</th><th>归一化（预乘）</th><th>累积合成</th></tr>
      ${rows}
      <tr><th>最终预乘</th><td colspan="3">${fmt(finalPremul)}</td></tr>
      <tr><th>导出直通值（PNG / 视频帧 / 屏幕）</th><td colspan="3">${fmt(finalStraight)}</td></tr>
      <tr><th>背景混合 rgb(${bg})</th><td colspan="3">R${onBg[0]} G${onBg[1]} B${onBg[2]}</td></tr>
    </table>`;
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * scene.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * scene.height);
  probe = [x, y];
  showInspector(x, y);
});

document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', render)
);

document.getElementById('bg').addEventListener('input', (e) => {
  const v = e.target.value;
  bg = [1, 3, 5].map((o) => parseInt(v.slice(o, o + 2), 16));
  if (probe) showInspector(probe[0], probe[1]);
});

document.getElementById('exportPng').addEventListener('click', () => {
  const png = encodePngBrowser(scene.width, scene.height, lastFrame.straight);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  a.download = 'composite.png';
  a.click();
  URL.revokeObjectURL(a.href);
});

buildLayerControls();
render();
