"use strict";

const state = {
  tracks: ["constant", "accelerando", "free"],
  current: null,
  analysis: null,
  grid: [],
  selectedIndex: null,
  audioBuffer: null,
  audioCtx: null,
  source: null,
  playing: false,
  playStartedAt: 0,
  playOffset: 0,
  rafId: null,
};

const MODE_LABEL = { constant: "恒定 BPM", ramp: "渐快/变速", free: "自由演奏" };

async function loadTrack(name) {
  stopPlayback();
  const [analysis, buffer] = await Promise.all([
    fetch(`../data/${name}.analysis.json`).then((r) => r.json()),
    loadAudio(`../audio/${name}.wav`),
  ]);
  state.current = name;
  state.analysis = analysis;
  state.audioBuffer = buffer;
  state.grid = analysis.grid.map((g) => ({ ...g }));
  state.selectedIndex = null;
  renderMetrics();
  renderBpmTable();
  drawAll();
}

async function loadAudio(url) {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return state.audioCtx.decodeAudioData(arr);
}

function gridPointAt(index) {
  return state.grid.find((g) => g.index === index) || null;
}

function halfBeatTimes() {
  const out = [];
  const g = state.grid;
  for (let i = 0; i < g.length - 1; i++) {
    out.push((g[i].time + g[i + 1].time) / 2);
  }
  return out;
}

function localPeriod(index) {
  const g = state.grid;
  const i = g.findIndex((p) => p.index === index);
  if (i < 0 || i >= g.length - 1) return null;
  return g[i + 1].time - g[i].time;
}

function nudge(direction) {
  if (state.selectedIndex === null) {
    alert("请先点击网格选中一个拍点");
    return;
  }
  const unit = document.getElementById("nudge-unit").value;
  const g = state.grid;
  const sel = g.findIndex((p) => p.index === state.selectedIndex);
  if (sel < 0) return;
  const analysis = state.analysis;

  if (analysis.mode === "free") {
    nudgeFree(sel, direction, unit);
  } else if (unit === "half") {
    nudgeHalfMetric(sel, direction);
  } else {
    nudgeBarMetric(sel, direction);
  }
  sanitizeGrid();
  afterGridChanged();
}

function nudgeFree(sel, direction, unit) {
  const g = state.grid;
  const step = unit === "half" ? 0.5 : 2.0;
  const refPeriod = localPeriod(g[sel].index) || 0.6;
  const delta = direction * step * refPeriod;
  g[sel].time = Math.max(0, g[sel].time + delta);
}

function nudgeHalfMetric(sel, direction) {
  const g = state.grid;
  const anchor = g[sel];
  const period = localPeriod(anchor.index) || 0.5;
  const delta = direction * period * 0.5;
  for (const p of g) {
    if (p.index >= anchor.index) p.time += delta;
  }
}

function nudgeBarMetric(sel, direction) {
  const g = state.grid;
  const anchor = g[sel];
  const period = localPeriod(anchor.index) || 0.5;
  const delta = direction * period * 4;
  for (const p of g) {
    if (p.bar >= anchor.bar) p.time += delta;
  }
}

function sanitizeGrid() {
  const g = state.grid;
  for (const p of g) {
    if (p.time < 0) p.time = 0;
    if (p.time > state.analysis.duration) p.time = state.analysis.duration;
  }
  g.sort((a, b) => a.time - b.time);
}

function afterGridChanged() {
  updateDerivedBpm();
  renderMetrics();
  renderBpmTable();
  drawAll();
}

function updateDerivedBpm() {
  const g = state.grid;
  const curve = [];
  for (let i = 0; i < g.length; i++) {
    const prev = g[Math.max(0, i - 1)].time;
    const next = g[Math.min(g.length - 1, i + 1)].time;
    const span = next - prev || 1e-6;
    const steps = Math.min(g.length - 1, i + 1) - Math.max(0, i - 1);
    const bpm = 60 / (span / Math.max(steps, 1));
    curve.push([g[i].time, bpm]);
  }
  state.derivedBpm = curve;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawWaveform() {
  const canvas = document.getElementById("wave-canvas");
  const { ctx, w, h } = setupCanvas(canvas);
  const a = state.analysis;
  const wf = a.waveform;
  ctx.clearRect(0, 0, w, h);
  const n = wf.peak.length;
  const xOf = (t) => (t / wf.duration) * w;
  ctx.fillStyle = "#3b82f6";
  const mid = h / 2;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const pk = Math.max(1, wf.peak[i] * mid * 0.95);
    const rms = Math.max(1, wf.rms[i] * mid * 0.9);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, mid - rms, Math.max(1, w / n), rms * 2);
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, mid - pk, Math.max(1, w / n), pk * 2);
  }
  ctx.globalAlpha = 1;
}

function drawOverlay() {
  const canvas = document.getElementById("overlay-canvas");
  const { ctx, w, h } = setupCanvas(canvas);
  const a = state.analysis;
  const dur = a.duration;
  const xOf = (t) => (t / dur) * w;
  ctx.clearRect(0, 0, w, h);

  for (const t of halfBeatTimes()) {
    const x = xOf(t);
    ctx.strokeStyle = "rgba(160,170,190,0.35)";
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(x, h * 0.55);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const p of state.grid) {
    const x = xOf(p.time);
    const barLine = p.beat_in_bar === 0;
    const selected = p.index === state.selectedIndex;
    ctx.strokeStyle = barLine ? "#f59e0b" : selected ? "#22d3ee" : "#8fb4ff";
    ctx.lineWidth = barLine ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (barLine) {
      ctx.fillStyle = "#f59e0b";
      ctx.font = "11px monospace";
      ctx.fillText(`${p.bar + 1}`, x + 3, 14);
    }
  }
  ctx.lineWidth = 1;

  for (const o of a.onsets) {
    const x = xOf(o.time);
    ctx.fillStyle = "rgba(74,222,128,0.9)";
    ctx.beginPath();
    ctx.arc(x, 14, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const playT = currentPlayTime();
  if (playT !== null) {
    const x = xOf(playT);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawBpmCurve() {
  const canvas = document.getElementById("bpm-canvas");
  const { ctx, w, h } = setupCanvas(canvas);
  const a = state.analysis;
  const curve = state.derivedBpm || a.bpm_curve;
  const dur = a.duration;
  ctx.clearRect(0, 0, w, h);
  const bpms = curve.map((c) => c[1]);
  const lo = Math.min(...bpms) - 4;
  const hi = Math.max(...bpms) + 4;
  const xOf = (t) => (t / dur) * w;
  const yOf = (b) => h - ((b - lo) / (hi - lo)) * (h - 24) - 8;
  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach(([t, b], i) => {
    const x = xOf(t);
    const y = yOf(b);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = "#7d8899";
  ctx.font = "11px monospace";
  ctx.fillText(`${hi.toFixed(1)} BPM`, 8, 14);
  ctx.fillText(`${lo.toFixed(1)} BPM`, 8, h - 4);
  const playT = currentPlayTime();
  if (playT !== null) {
    const x = xOf(playT);
    ctx.strokeStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawAll() {
  if (!state.analysis) return;
  drawWaveform();
  drawOverlay();
  drawBpmCurve();
}

function renderMetrics() {
  const a = state.analysis;
  const curve = state.derivedBpm || a.bpm_curve;
  const bpms = curve.map((c) => c[1]);
  document.getElementById("mode-badge").textContent = MODE_LABEL[a.mode];
  document.getElementById("mode-badge").className = `badge ${a.mode}`;
  document.getElementById("m-mode").textContent = MODE_LABEL[a.mode];
  document.getElementById("m-confidence").textContent =
    `${(a.confidence * 100).toFixed(1)}%`;
  document.getElementById("m-mae").textContent =
    a.mode === "free" ? "不适用（自由拍）" : `${a.mean_grid_error_ms.toFixed(2)} ms`;
  document.getElementById("m-median").textContent =
    a.mode === "free" ? "—" : `${a.median_grid_error_ms.toFixed(2)} ms`;
  document.getElementById("m-bpm").textContent =
    `${Math.min(...bpms).toFixed(1)} – ${Math.max(...bpms).toFixed(1)}`;
  document.getElementById("m-points").textContent = String(state.grid.length);
}

function renderBpmTable() {
  const a = state.analysis;
  const curve = state.derivedBpm || a.bpm_curve;
  const rows = curve
    .map(([t, b], i) => {
      const p = state.grid[i];
      const label = p ? `第 ${p.bar + 1} 小节 / 拍 ${p.beat_in_bar + 1}` : `点 ${i + 1}`;
      return `<tr><td>${label}</td><td>${t.toFixed(4)} s</td><td>${b.toFixed(2)}</td></tr>`;
    })
    .join("");
  document.getElementById("bpm-table").innerHTML =
    `<table><thead><tr><th>位置</th><th>时间</th><th>BPM</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function currentPlayTime() {
  if (!state.playing) return null;
  return state.playOffset + (state.audioCtx.currentTime - state.playStartedAt);
}

function startPlayback() {
  if (!state.audioBuffer || state.playing) return;
  const ctx = state.audioCtx;
  state.source = ctx.createBufferSource();
  state.source.buffer = state.audioBuffer;
  state.source.connect(ctx.destination);
  state.source.start();
  state.playStartedAt = ctx.currentTime;
  state.playing = true;
  document.getElementById("play-btn").textContent = "播放中";
  const tick = () => {
    drawOverlay();
    drawBpmCurve();
    const t = currentPlayTime();
    document.getElementById("time-readout").textContent = `${t.toFixed(3)} s`;
    if (t >= state.audioBuffer.duration) {
      stopPlayback();
      return;
    }
    state.rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopPlayback() {
  if (state.source) {
    try { state.source.stop(); } catch (_) {}
    state.source.disconnect();
    state.source = null;
  }
  state.playing = false;
  state.playOffset = 0;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  const btn = document.getElementById("play-btn");
  if (btn) btn.textContent = "播放";
  if (state.analysis) drawAll();
}

function handleCanvasClick(evt) {
  const canvas = document.getElementById("overlay-canvas");
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const t = (x / rect.width) * state.analysis.duration;
  let best = null;
  let bestDist = Infinity;
  for (const p of state.grid) {
    const px = (p.time / state.analysis.duration) * rect.width;
    const d = Math.abs(px - x);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (best && bestDist < 24) {
    state.selectedIndex = best.index;
    drawOverlay();
  }
}

function init() {
  const sel = document.getElementById("track-select");
  for (const name of state.tracks) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = MODE_LABEL[name] || name;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => loadTrack(sel.value));
  document.getElementById("play-btn").addEventListener("click", startPlayback);
  document.getElementById("stop-btn").addEventListener("click", stopPlayback);
  document.getElementById("nudge-left").addEventListener("click", () => nudge(-1));
  document.getElementById("nudge-right").addEventListener("click", () => nudge(1));
  document.getElementById("reset-btn").addEventListener("click", () =>
    loadTrack(state.current)
  );
  document
    .getElementById("overlay-canvas")
    .addEventListener("click", handleCanvasClick);
  window.addEventListener("resize", drawAll);
  loadTrack(state.tracks[0]);
}

document.addEventListener("DOMContentLoaded", init);

if (typeof window !== "undefined") {
  window.__beatgrid = { state, nudge, drawAll, loadTrack };
}
