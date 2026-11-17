// Browser side: file decoding (WebAudio), canvas waveform display, WASM call
// and WAV export. All DSP lives in the WebAssembly module.
import { Declicker } from '../src/declicker.js';
import { encodeWavPcm16 } from '../src/wav-codec.js';

const fileInput = document.getElementById('file');
const modeSelect = document.getElementById('mode');
const runBtn = document.getElementById('run');
const downloadBtn = document.getElementById('download');
const canvas = document.getElementById('canvas');
const metricsEl = document.getElementById('metrics');
const regionsEl = document.getElementById('regions');

let declicker = null;
let decoded = null;
let repaired = null;

function peak(x) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

function peakStep(x) {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

async function decodeFile(file) {
  const arrayBuf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 48000 });
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  // Down-mix to mono Float32 PCM, which is the module's contract.
  const mono = new Float32Array(audioBuf.length);
  for (let c = 0; c < audioBuf.numberOfChannels; c++) {
    const ch = audioBuf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audioBuf.numberOfChannels;
  }
  ctx.close();
  return { samples: mono, sampleRate: audioBuf.sampleRate };
}

function draw(before, after, regions) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const rows = [
    { data: before, top: 10, color: '#60a5fa' },
    { data: after, top: h / 2 + 10, color: '#34d399' },
  ];
  const rowH = h / 2 - 20;
  for (const row of rows) {
    const mid = row.top + rowH / 2;
    ctx.strokeStyle = '#334155';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = row.color;
    ctx.beginPath();
    const n = row.data.length;
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * n);
      const y = mid - row.data[i] * (rowH / 2) * 0.95;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(245,158,11,0.18)';
  const n = before.length;
  for (const [lo, hi] of regions) {
    const x0 = (lo / n) * w;
    const x1 = (hi / n) * w;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
}

fileInput.addEventListener('change', async () => {
  if (!fileInput.files[0]) return;
  decoded = await decodeFile(fileInput.files[0]);
  runBtn.disabled = false;
  downloadBtn.disabled = true;
});

runBtn.addEventListener('click', async () => {
  if (!decoded) return;
  if (!declicker) declicker = await Declicker.create(new URL('../build/declicker.wasm', import.meta.url));
  const mode = Number(modeSelect.value);
  const result = declicker.process(decoded.samples, mode);
  repaired = result;
  draw(decoded.samples, result.output, result.regions);

  const rows = [
    ['峰值（修复前）', peak(decoded.samples).toFixed(6)],
    ['峰值（修复后）', peak(result.output).toFixed(6)],
    ['峰值步长（前）', peakStep(decoded.samples).toFixed(6)],
    ['峰值步长（后）', peakStep(result.output).toFixed(6)],
    ['修改样本数', result.modified],
    ['修复区间数', result.regions.length],
    ['WASM 耗时', `${(result.ns / 1000).toFixed(2)} us`],
  ];
  metricsEl.innerHTML = '<tr>' + rows.map(([k, v]) => `<th>${k}</th>`).join('') + '</tr>' +
    '<tr>' + rows.map(([, v]) => `<td>${v}</td>`).join('') + '</tr>';
  regionsEl.textContent = '区间（样本，左闭右开）: ' +
    result.regions.map(([lo, hi]) => `[${lo}, ${hi})`).join('  ');
  downloadBtn.disabled = false;
});

downloadBtn.addEventListener('click', () => {
  if (!repaired) return;
  const wav = encodeWavPcm16(repaired.output, decoded.sampleRate);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'declicked.wav';
  a.click();
  URL.revokeObjectURL(a.href);
});
