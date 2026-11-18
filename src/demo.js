// Browser demo: AudioWorklet de-esser with live metering and offline charts.
'use strict';

const $ = (id) => document.getElementById(id);
const controls = {
  crossoverFreq: $('crossoverFreq'),
  thresholdDb: $('thresholdDb'),
  maxReductionDb: $('maxReductionDb'),
  releaseMs: $('releaseMs'),
};
const readouts = {
  crossoverFreq: $('v-crossover'),
  thresholdDb: $('v-threshold'),
  maxReductionDb: $('v-maxReduction'),
  releaseMs: $('v-release'),
};

let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let audioBuffer = null;
let bypassed = false;
let spectra = null;
let reductionData = null;
let liveAnalyser = null;
let liveCtx2d = null;
let activeSpectrum = null;

const status = (text) => {
  $('status').textContent = text;
};

async function ensureContext() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('./src/deesser-processor.js');
  status(`AudioWorklet 已就绪，采样率 ${audioCtx.sampleRate} Hz。`);
}

function buildGraph() {
  if (workletNode) {
  workletNode.disconnect();
  sourceNode.disconnect();
  workletNode = null;
  }
  workletNode = new AudioWorkletNode(audioCtx, 'de-esser-processor', {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [audioBuffer.numberOfChannels],
  });
  workletNode.port.postMessage({ type: 'telemetry', enabled: true, stride: 32 });
  workletNode.port.onmessage = (event) => {
  if (event.data && event.data.type === 'reduction') {
    $('grValue').textContent = `${event.data.reductionDb.toFixed(1)} dB`;
    const pct = Math.min(100, (event.data.reductionDb / 24) * 100);
    $('grMeter').style.width = `${pct}%`;
  }
  };
  applyParams();
  sourceNode.connect(workletNode);

  liveAnalyser = audioCtx.createAnalyser();
  liveAnalyser.fftSize = 1024;
  workletNode.connect(liveAnalyser);
  liveAnalyser.connect(audioCtx.destination);
  drawLive();
}

function applyParams() {
  if (!workletNode) return;
  for (const [name, input] of Object.entries(controls)) {
  const param = workletNode.parameters.get(name);
  if (param) param.setValueAtTime(Number(input.value), audioCtx.currentTime);
  readouts[name].textContent = `${input.value} ${name === 'releaseMs' ? 'ms' : name.endsWith('Db') ? 'dB' : 'Hz'}`;
  }
}

for (const [name, input] of Object.entries(controls)) {
  input.addEventListener('input', () => {
  readouts[name].textContent = `${input.value} ${name === 'releaseMs' ? 'ms' : name.endsWith('Db') ? 'dB' : 'Hz'}`;
  applyParams();
  if (name === 'crossoverFreq' && activeSpectrum) drawSpectrum(activeSpectrum);
  });
}

async function loadArrayBuffer(buffer, name) {
  await ensureContext();
  if (sourceNode) {
  try { sourceNode.stop(); } catch { /* not started */ }
  sourceNode.disconnect?.();
  sourceNode = null;
  }
  audioBuffer = await audioCtx.decodeAudioData(buffer);
  $('fileName').textContent = `${name} — ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch`;
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.loop = false;
  buildGraph();
  status('音频已加载，点击播放。A/B 按钮可在原始与处理信号间切换。');
}

$('loadSample').addEventListener('click', async () => {
  const res = await fetch('./artifacts/test-voice.wav');
  const buf = await res.arrayBuffer();
  await loadArrayBuffer(buf, 'test-voice.wav');
});
$('chooseFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await loadArrayBuffer(await file.arrayBuffer(), file.name);
});

$('play').addEventListener('click', async () => {
  if (!audioBuffer) return $('loadSample').click();
  await audioCtx.resume();
  try { sourceNode.stop(); } catch { /* recreate below */ }
  sourceNode.disconnect();
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(workletNode);
  sourceNode.start();
});
$('stop').addEventListener('click', () => {
  try { sourceNode.stop(); } catch { /* noop */ }
});
$('bypass').addEventListener('click', () => {
  bypassed = !bypassed;
  const btn = $('bypass');
  btn.classList.toggle('on', !bypassed);
  btn.textContent = bypassed ? '原始信号 (点击回处理)' : '处理中 (A/B)';
  workletNode?.port.postMessage({ type: 'bypass', value: bypassed });
});

// ---------- Offline charts loaded from the Node test artifacts ----------
async function loadArtifacts() {
  try {
  const [spec, curve] = await Promise.all([
    fetch('./artifacts/spectra.json').then((r) => r.json()),
    fetch('./artifacts/reduction-curve.json').then((r) => r.json()),
  ]);
  spectra = spec;
  reductionData = curve;
  const labels = Object.keys(spectra);
  const box = $('segButtons');
  labels.forEach((label, idx) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (idx === 0) b.classList.add('toggle', 'on');
    b.addEventListener('click', () => {
    box.querySelectorAll('button').forEach((x) => x.classList.remove('toggle', 'on'));
    b.classList.add('toggle', 'on');
    drawSpectrum(label);
    activeSpectrum = label;
    });
    box.appendChild(b);
  });
  drawSpectrum(labels[0]);
  activeSpectrum = labels[0];
  drawReductionCurve();
  } catch (err) {
  status('静态图表需要先运行 `node test/run-test.js` 并通过 HTTP 打开本页。');
  }
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w: rect.width, h: rect.height };
}

function drawSpectrum(label) {
  if (!spectra) return;
  const canvas = $('spectrumCanvas');
  const { ctx, w, h } = setupCanvas(canvas);
  const { freqs, db: before } = spectra[label].before;
  const after = spectra[label].after.db;
  const minDb = -90;
  const maxDb = -10;
  const x = (f) => (Math.log10(f / 60) / Math.log10((22050) / 60)) * w;
  const y = (db) => h - ((Math.max(minDb, Math.min(maxDb, db)) - minDb) / (maxDb - minDb)) * h;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#2a3550';
  ctx.lineWidth = 1;
  for (let db = -80; db <= -20; db += 20) {
  ctx.beginPath();
  ctx.moveTo(0, y(db));
  ctx.lineTo(w, y(db));
  ctx.stroke();
  ctx.fillStyle = '#8b97ad';
  ctx.font = '10px sans-serif';
  ctx.fillText(`${db}dB`, 4, y(db) - 2);
  }
  const trace = (arr, color) => {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  arr.forEach((v, i) => {
    const px = x(freqs[i]);
    const py = y(v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  };
  trace(before, '#6aa7ff');
  trace(after, '#57d9a3');
  // Crossover marker.
  const fc = Number(controls.crossoverFreq.value);
  ctx.strokeStyle = '#ffce6a';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(x(fc), 0);
  ctx.lineTo(x(fc), h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffce6a';
  ctx.fillText(`${fc} Hz`, x(fc) + 4, 12);
  ctx.fillStyle = '#8b97ad';
  ctx.fillText('60Hz', 2, h - 4);
  ctx.fillText('20kHz', w - 38, h - 4);
}

function drawReductionCurve() {
  if (!reductionData) return;
  const canvas = $('curveCanvas');
  const { ctx, w, h } = setupCanvas(canvas);
  const { curve, stride, sampleRate, segments, params } = reductionData;
  const totalSamples = curve.length * stride;
  const x = (sample) => (sample / totalSamples) * w;
  const y = (gr) => h - (Math.min(24, gr) / 24) * h;
  ctx.clearRect(0, 0, w, h);
  // Segment backgrounds.
  for (const seg of segments) {
  if (seg.kind === 'silence') continue;
  ctx.fillStyle = seg.kind === 'sibilant' ? 'rgba(255,122,122,0.18)'
    : seg.kind === 'consonant' ? 'rgba(106,167,255,0.15)' : 'rgba(255,255,255,0.04)';
  ctx.fillRect(x(seg.start), 0, x(seg.end) - x(seg.start), h);
  }
  ctx.strokeStyle = '#ffce6a';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  curve.forEach((gr, i) => {
  const px = x(i * stride);
  const py = y(gr);
  if (i === 0) ctx.moveTo(px, py);
  else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = '#8b97ad';
  ctx.font = '10px sans-serif';
  for (let db = 0; db <= 24; db += 6) ctx.fillText(`${db}`, 2, y(db) - 2);
  ctx.fillText(`参数: fc=${params.crossoverFreq}Hz thr=${params.thresholdDb}dB max=${params.maxReductionDb}dB rel=${params.releaseMs}ms`, 8, 14);
  ctx.fillText(`时长 ${(totalSamples / sampleRate).toFixed(2)}s`, w - 70, h - 6);
}

function drawLive() {
  if (!liveAnalyser) return;
  const canvas = $('liveCanvas');
  if (!liveCtx2d || liveCtx2d.canvas.width !== canvas.clientWidth) {
  ({ ctx: liveCtx2d } = setupCanvas(canvas));
  }
  const ctx = liveCtx2d;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const bins = new Uint8Array(liveAnalyser.frequencyBinCount);
  liveAnalyser.getByteFrequencyData(bins);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#57d9a3';
  const barW = w / bins.length;
  for (let i = 0; i < bins.length; i++) {
  const barH = (bins[i] / 255) * h;
  ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 0.5), barH);
  }
  requestAnimationFrame(drawLive);
}

loadArtifacts();
