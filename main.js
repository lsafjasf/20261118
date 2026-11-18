// main.js — UI + audio graph wiring. All DSP runs inside the AudioWorklet
// (noise-gate-worklet.js); this file only builds the synthetic test signal,
// forwards parameters and renders telemetry.
import { synthFanWithBursts } from './test-signal.js';

const $ = (id) => document.getElementById(id);
const OFFLINE_SECONDS = parseFloat(new URLSearchParams(location.search).get('offline')) || 0;

const state = {
  ctx: null,
  node: null,
  source: null,
  running: false,
  telemetry: null,
  startTime: 0,
  lastFrames: 0,
  lastTotalIn: 0,
  continuous: true,
  driftMs: 0,
  log: [],
};

const params = { thresholdDb: 11, attackMs: 3, releaseMs: 150, lowKeep: 0.2 };

function fmtDb(v) {
  return v <= -99 ? '-∞ dB' : `${v.toFixed(1)} dB`;
}

function barWidth(db) {
  return `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
}

async function start() {
  // ?offline=N renders N seconds with an OfflineAudioContext (used by the
  // automated long-run test in device-less environments). Suspend/resume
  // pacing lets the UI paint and the test sample telemetry between slices.
  const ctx = OFFLINE_SECONDS > 0
    ? new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(OFFLINE_SECONDS * 48000), sampleRate: 48000 })
    : new AudioContext({ latencyHint: 'interactive' });
  state.ctx = ctx;
  state.offline = OFFLINE_SECONDS > 0;
  await ctx.audioWorklet.addModule('noise-gate-worklet.js');
  const node = new AudioWorkletNode(ctx, 'spectral-noise-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  state.node = node;

  // Synthetic test signal: looping fan bed with short bursts on top.
  const seconds = 8;
  const data = synthFanWithBursts(ctx.sampleRate, seconds, [1.0, 2.7, 4.3, 6.1, 7.4]);
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  state.source = source;

  const master = ctx.createGain();
  master.gain.value = 0.7;
  source.connect(node);
  node.connect(master);
  master.connect(ctx.destination);

  node.port.onmessage = (event) => {
    if (event.data && event.data.type === 'telemetry') {
      onTelemetry(event.data);
    }
  };
  node.port.postMessage({ type: 'params', params });

  source.start();
  state.running = true;
  state.startTime = ctx.currentTime;
  if (state.offline) {
    for (let t = 1; t < OFFLINE_SECONDS; t += 1) {
      const at = t;
      ctx.suspend(at).then(() => new Promise((resolve) => {
        setTimeout(() => {
          ctx.resume();
          resolve();
        }, 20);
      }));
    }
    ctx.startRendering().then(() => {
      state.running = false;
      state.finished = true;
      $('status').textContent = '离线渲染完成';
      $('toggle').textContent = '开始处理';
      $('toggle').classList.remove('stop');
    });
  }
  $('toggle').textContent = '停止';
  $('toggle').classList.add('stop');
  $('status').textContent = '处理中 · 风机噪声 + 每约 1.5 s 一个短脉冲';
}

function stop() {
  if (state.source) state.source.stop();
  if (state.ctx) state.ctx.close();
  state.running = false;
  state.ctx = null;
  state.node = null;
  state.telemetry = null;
  $('toggle').textContent = '开始处理';
  $('toggle').classList.remove('stop');
  $('status').textContent = '已停止';
}

function onTelemetry(t) {
  const ctx = state.ctx;
  if (!ctx) return;
  if (state.lastTotalIn === 0) {
    state.lastFrames = t.frames;
    state.lastTotalIn = t.totalIn;
  }
  // Drift: render-quantum counter vs the audio render clock, tracked inside
  // the worklet. Structural latency is fixed, so this stays at zero.
  state.driftMs = ((t.driftFrames || 0) / ctx.sampleRate) * 1000;
  // Continuity: input sample count must advance exactly one hop per STFT
  // frame, with no gaps, for the whole run.
  const dFrames = t.frames - state.lastFrames;
  const dIn = t.totalIn - state.lastTotalIn;
  if (dIn !== dFrames * (t.hopSize || 256)) state.continuous = false;
  state.lastFrames = t.frames;
  state.lastTotalIn = t.totalIn;
  state.telemetry = t;
  state.log.push({
    at: ctx.currentTime - state.startTime,
    driftMs: state.driftMs,
    frames: t.frames,
    fifoLevel: t.fifoLevel,
    latencySamples: t.latencySamples,
    attenDb: t.attenDb,
  });
}

function drawSpectrum() {
  const canvas = $('spectrum');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  g.fillStyle = '#0a0d12';
  g.fillRect(0, 0, w, h);
  const t = state.telemetry;
  const sr = state.ctx ? state.ctx.sampleRate : 48000;
  // Grid: frequency lines + dB lines.
  g.strokeStyle = '#1d2530';
  g.fillStyle = '#5b6572';
  g.font = `${10 * dpr}px sans-serif`;
  g.lineWidth = 1;
  const fMin = 40;
  const fMax = sr / 2;
  const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
  for (const f of [100, 1000, 10000]) {
    g.beginPath();
    g.moveTo(xOf(f), 0);
    g.lineTo(xOf(f), h);
    g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xOf(f) + 3 * dpr, h - 5 * dpr);
  }
  const dbTop = 0;
  const dbBottom = -90;
  const yOf = (db) => ((dbTop - db) / (dbTop - dbBottom)) * h;
  for (const db of [-30, -60]) {
    g.beginPath();
    g.moveTo(0, yOf(db));
    g.lineTo(w, yOf(db));
    g.stroke();
    g.fillText(`${db}`, 4 * dpr, yOf(db) - 3 * dpr);
  }
  if (!t) return;
  const n = t.spectrumDb.length;
  const binF = (k) => (k * sr) / ((n - 1) * 2);
  const trace = (values, color, dbOffset = 0) => {
    g.strokeStyle = color;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (let k = 1; k < n; k++) {
      const f = binF(k);
      if (f < fMin) continue;
      const x = xOf(f);
      const y = yOf(Math.max(dbBottom, values[k] + dbOffset));
      if (k === 1) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };
  trace(t.spectrumDb, '#58a6ff');
  trace(t.spectrumDb.map((v, k) => v + t.gainCurveDb[k]), '#4cc38a');
  trace(t.gainCurveDb, '#f0883e');
}

function render() {
  const t = state.telemetry;
  if (t) {
    $('inBar').firstElementChild.style.width = barWidth(t.inDb);
    $('outBar').firstElementChild.style.width = barWidth(t.outDb);
    $('inDb').textContent = fmtDb(t.inDb);
    $('outDb').textContent = fmtDb(t.outDb);
    $('atten').textContent = Math.abs(t.attenDb).toFixed(1);
    $('frames').textContent = t.frames.toLocaleString();
    $('latency').textContent = `${t.latencySamples} 样本 (${t.latencyMs.toFixed(1)} ms)`;
    $('fifo').textContent = `${t.fifoLevel} 样本`;
    $('drift').textContent = `${state.driftMs.toFixed(1)} ms`;
    $('continuity').textContent = state.continuous ? '连续' : '断档!';
    const elapsed = state.ctx ? state.ctx.currentTime - state.startTime : 0;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    $('runtime').textContent = `${mm}:${ss}`;
  }
  drawSpectrum();
  requestAnimationFrame(render);
}

function bindParam(id, key, fmt, valId) {
  $(id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    params[key] = v;
    $(valId).textContent = fmt(v);
    if (state.node) state.node.port.postMessage({ type: 'params', params });
  });
}

$('toggle').addEventListener('click', () => {
  if (state.running) stop();
  else start().catch((err) => {
    $('status').textContent = `启动失败: ${err.message}`;
  });
});

bindParam('threshold', 'thresholdDb', (v) => `${v.toFixed(1)} dB`, 'thVal');
bindParam('attack', 'attackMs', (v) => `${v.toFixed(1)} ms`, 'atVal');
bindParam('release', 'releaseMs', (v) => `${v.toFixed(0)} ms`, 'relVal');
bindParam('lowKeep', 'lowKeep', (v) => v.toFixed(2), 'lkVal');

// Hooks for the automated browser long-run test.
window.__gateTest = {
  state,
  stats() {
    return {
      running: state.running,
      driftMs: state.driftMs,
      continuous: state.continuous,
      telemetry: state.telemetry ? {
        frames: state.telemetry.frames,
        totalIn: state.telemetry.totalIn,
        fifoLevel: state.telemetry.fifoLevel,
        latencySamples: state.telemetry.latencySamples,
        attenDb: state.telemetry.attenDb,
        inDb: state.telemetry.inDb,
        outDb: state.telemetry.outDb,
      } : null,
      log: state.log.slice(),
    };
  },
};

requestAnimationFrame(render);
