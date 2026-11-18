/* Viewer application: rendering, interaction, audition, local re-analysis. */
(function () {
  'use strict';
  const M = METRICS;
  const TL = M.timeline;
  const DUR = M.duration_s;
  const SR = M.sample_rate;
  const $ = (id) => document.getElementById(id);
  const fmt = (x, d = 2) => Number(x).toFixed(d);

  let audioCtx = null;
  let audioBuffer = null;
  let fullSamples = null;
  let fullWeighted = null;
  let currentSource = null;

  const state = { winStart: 0, winLen: 60, clipLen: 3, local: null };

  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function stopPlayback() {
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
  }

  // Play a clip beginning at an absolute global time; coordinate never resets.
  function audition(timeS) {
    if (!audioBuffer) return;
    stopPlayback();
    const start = Math.min(Math.max(0, timeS), DUR - 0.05);
    const dur = Math.min(state.clipLen, DUR - start);
    $('playReadout').innerHTML =
      `试听 <b>t=${fmt(start, 2)} s</b> → ${fmt(start + dur, 2)} s（长度 ${fmt(dur, 1)} s）`;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(audioCtx.destination);
    try {
      src.start(0, start, dur);
      currentSource = src;
      src.onended = () => { if (currentSource === src) currentSource = null; };
    } catch (err) {
      $('playReadout').innerHTML += ` <span style="color:var(--loud)">（播放被浏览器拦截，已定位到 t=${fmt(start, 2)} s）</span>`;
    }
  }

  async function initAudio() {
    // Pin the context to the file's sample rate so decodeAudioData does not
    // resample (default contexts often run at 44.1/48 kHz), which would
    // misalign every timestamp against the Python metrics.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      audioCtx = new Ctx({ sampleRate: SR });
      if (audioCtx.sampleRate !== SR) throw new Error('sampleRate option ignored');
    } catch (_) {
      audioCtx = new Ctx();
    }
    let arrayBuffer;
    if (WAV_BASE64 && WAV_BASE64.length > 100) {
      arrayBuffer = b64ToArrayBuffer(WAV_BASE64);
    } else {
      const resp = await fetch('test_track.wav');
      if (!resp.ok) throw new Error('无法加载 test_track.wav，请通过本地 HTTP 服务打开（python src/serve.py）');
      arrayBuffer = await resp.arrayBuffer();
    }
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    fullSamples = audioBuffer.getChannelData(0);
    fullWeighted = window.AudioMetrics.kWeight(fullSamples, SR);
  }

  function renderCards() {
    const s = M.summary;
    const cards = [
      ['最高响度位置', `${fmt(s.max_loudness_lufs)} LUFS`, `t = ${fmt(s.max_loudness_frame_time_s, 1)} s`],
      ['最大峰点', `${fmt(s.global_peak_dbfs)} dBFS`, `t = ${fmt(s.global_peak_time_s, 1)} s · 样本 ${s.global_peak_sample_index}`],
      ['静音总时长', `${fmt(s.silence_total_s, 1)} s`, `阈值 ${M.silence_threshold_dbfs} dBFS · 精确零 ${fmt(s.digital_zero_total_s, 1)} s`],
      ['素材时长', `${fmt(DUR, 0)} s`, `${SR} Hz 单声道 · 帧 ${TL.t_s.length}`],
    ];
    $('cards').innerHTML = cards.map(([k, v, h]) =>
      `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="h">${h}</div></div>`).join('');
  }

  function renderStrategy() {
    $('strategy').innerHTML = [
      `分析帧 <b>${M.frame.window_s} s</b> Hann 窗，帧移 <b>${M.frame.hop_s} s</b>，即 <b>50% 重叠</b>；Hann 在 50% 帧移下满足 COLA（恒重叠相加），帧能量无缝铺满时间轴、不重复计数。`,
      `K 加权（BS.1770-4 高架+高通）对整条信号<b>连续滤波一次</b>，不在帧或窗口边界重置状态，拖动窗口不会改变任一样本的分析值。`,
      `响度为非门限 K 加权 LUFS（-0.691 + 10·log₁₀ 均方）；峰值取<b>未加权</b>样本、采样级精确；静音按每 ${M.frame.hop_s} s 单元的 RMS &lt; ${M.silence_threshold_dbfs} dBFS 判定，避免零交叉/量化误判。`,
      `所有指标以绝对帧/单元起点时间打标；局部重分析仅传入全局样本偏移 globalOffsetSamples，故窗口边界不影响整体 0–${DUR} s 时间坐标。`,
    ].map((t) => `<div style="margin-bottom:6px">• ${t}</div>`).join('');
  }

  function renderRegionTable() {
    const rows = [];
    M.regions.sudden_loud.forEach((r) => rows.push({ cls: 'loud', label: '突然变响', r, val: `峰值 ${r.peak_lufs} LUFS，跃升 +${r.onset_jump_lu} LU` }));
    M.regions.sustained_low.forEach((r) => rows.push({ cls: 'low', label: '持续低电平', r, val: `最低 ${r.min_lufs} LUFS` }));
    M.regions.silence.forEach((r) => rows.push({ cls: 'sil', label: '静音', r, val: `单元 RMS &lt; ${M.silence_threshold_dbfs} dBFS` }));
    rows.sort((a, b) => a.r.start_s - b.r.start_s);
    $('regionTable').querySelector('tbody').innerHTML = rows.map((row) => `
      <tr class="region" data-t="${row.r.start_s}">
        <td><span class="tag ${row.cls}">${row.label}</span></td>
        <td>${fmt(row.r.start_s, 1)}</td><td>${fmt(row.r.end_s, 1)}</td>
        <td>${fmt(row.r.end_s - row.r.start_s, 1)}</td><td>${row.val}</td>
      </tr>`).join('');
    document.querySelectorAll('tr.region').forEach((tr) =>
      tr.addEventListener('click', () => audition(parseFloat(tr.dataset.t))));
  }

  const COLORS = {
    accent: '#5aa7ff', peak: '#ffd166', loud: '#ff6b6b', quiet: '#7c5cff',
    silence: '#2c3650', window: '#22d3a5', grid: '#24304a', muted: '#8794ad',
  };

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth - 28;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: canvas.clientHeight };
  }

  function band(ctx, x0, x1, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }

  function drawRegionBands(ctx, w, h, t0, t1) {
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const paint = (list, color) => list.forEach((r) => {
      const s = Math.max(t0, r.start_s), e = Math.min(t1, r.end_s);
      if (e > s) band(ctx, X(s), X(e), h, color);
    });
    paint(M.regions.silence, 'rgba(120,140,180,0.16)');
    paint(M.regions.sustained_low, 'rgba(124,92,255,0.16)');
    paint(M.regions.sudden_loud, 'rgba(255,107,107,0.20)');
  }

  // Generic line chart over an arbitrary [t0,t1] view using global time.
  function drawLine(ctx, w, h, t0, t1, times, values, vMin, vMax, color, width) {
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const Y = (v) => h - ((v - vMin) / (vMax - vMin)) * (h - 18) - 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < t0 || times[i] > t1) continue;
      const x = X(times[i]), y = Y(values[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawGrid(ctx, w, h, t0, t1, vMin, vMax) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.font = '10px sans-serif';
    const step = (t1 - t0) / 6;
    for (let k = 0; k <= 6; k++) {
      const x = (k / 6) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(fmt(t0 + step * k, 0), x + 3, h - 2);
    }
    const Y = (v) => h - ((v - vMin) / (vMax - vMin)) * (h - 18) - 6;
    [-60, -40, -20, 0].forEach((v) => {
      if (v < vMin || v > vMax) return;
      ctx.fillText(`${v}`, 3, Y(v) - 2);
    });
  }

  function drawMap() {
    const canvas = $('map');
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    drawRegionBands(ctx, w, h, 0, DUR);
    drawGrid(ctx, w, h, 0, DUR, -70, 0);
    drawLine(ctx, w, h, 0, DUR, TL.t_s, TL.loudness_lufs, -70, 0, COLORS.accent, 1.6);
    drawLine(ctx, w, h, 0, DUR, TL.t_s, TL.peak_dbfs, -70, 0, COLORS.peak, 1.0);
    // Current analysis window overlay (global coordinates).
    const X = (t) => (t / DUR) * w;
    ctx.strokeStyle = COLORS.window;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(X(state.winStart), 2, X(state.winStart + state.winLen) - X(state.winStart), h - 4);
    ctx.setLineDash([]);
    canvas._view = { t0: 0, t1: DUR };
  }

  function drawZoom() {
    const canvas = $('zoom');
    const { ctx, w, h } = setupCanvas(canvas);
    const t0 = state.winStart;
    const t1 = Math.min(DUR, state.winStart + state.winLen);
    ctx.clearRect(0, 0, w, h);
    drawRegionBands(ctx, w, h, t0, t1);
    drawGrid(ctx, w, h, t0, t1, -70, 0);
    const data = state.local ? state.local.timeline : TL;
    const tArr = state.local ? data.tS : data.t_s;
    const loudArr = state.local ? data.loudness : data.loudness_lufs;
    const peakArr = state.local ? data.peakDbfs : data.peak_dbfs;
    drawLine(ctx, w, h, t0, t1, tArr, loudArr, -70, 0, COLORS.accent, 1.8);
    drawLine(ctx, w, h, t0, t1, tArr, peakArr, -70, 0, COLORS.peak, 1.1);
    canvas._view = { t0, t1 };
    ctx.fillStyle = COLORS.muted;
    ctx.font = '11px sans-serif';
    ctx.fillText(state.local ? '局部窗口实时重分析（浏览器端 DSP）' : '全轨参考分析（Python 离线结果）', 8, 14);
  }

  function canvasTimeFromEvent(canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    const frac = (ev.clientX - rect.left) / rect.width;
    const { t0, t1 } = canvas._view;
    return t0 + frac * (t1 - t0);
  }

  function bindCanvasAudition() {
    ['map', 'zoom'].forEach((id) => {
      $(id).addEventListener('click', (ev) => audition(canvasTimeFromEvent(ev.target, ev)));
    });
  }

  function updateWindowReadout() {
    const end = Math.min(DUR, state.winStart + state.winLen);
    $('winReadout').innerHTML =
      `窗口 <b>${fmt(state.winStart, 1)} – ${fmt(end, 1)} s</b>（长度 ${fmt(end - state.winStart, 1)} s）` +
      `<br><span style="color:var(--muted)">时间坐标始终为全局 0–${DUR} s</span>`;
  }

  function reanalyzeWindow() {
    const startSample = Math.round(state.winStart * SR);
    const endSample = Math.round(Math.min(DUR, state.winStart + state.winLen) * SR);
    // Slice the already weighted full signal: no filter reset, global offset kept.
    const slice = fullSamples.subarray(startSample, endSample);
    const weightedSlice = fullWeighted.subarray(startSample, endSample);
    const result = window.AudioMetrics.analyze(slice, SR, {
      globalOffsetSamples: startSample,
      weighted: weightedSlice,
      windowS: M.frame.window_s,
      hopS: M.frame.hop_s,
      silenceDbfs: M.silence_threshold_dbfs,
    });
    state.local = result;
    const tl = result.timeline;
    const maxI = tl.loudness.indexOf(Math.max(...tl.loudness));
    const silCells = tl.silenceRatio.reduce((a, b) => a + b, 0);
    $('reanalyzeNote').innerHTML =
      `局部重分析完成：${tl.tS.length} 帧，首帧时间 <b>${fmt(tl.tS[0], 2)} s</b>（=全局偏移，未重置），` +
      `窗口内最高响度 <b>${fmt(tl.loudness[maxI], 2)} LUFS @ ${fmt(tl.tS[maxI], 2)} s</b>，` +
      `窗口内静音 <b>${fmt(silCells * M.frame.hop_s, 1)} s</b>。`;
    drawZoom();
  }

  function bindControls() {
    const startSlider = $('winStart');
    const lenSlider = $('winLen');
    startSlider.max = DUR;
    lenSlider.max = 120;
    startSlider.value = state.winStart;
    lenSlider.value = state.winLen;
    $('clipLen').value = state.clipLen;

    startSlider.addEventListener('input', () => {
      state.winStart = parseFloat(startSlider.value);
      state.local = null;
      updateWindowReadout();
      drawMap();
      drawZoom();
    });
    lenSlider.addEventListener('input', () => {
      state.winLen = parseFloat(lenSlider.value);
      state.local = null;
      updateWindowReadout();
      drawMap();
      drawZoom();
    });
    $('reanalyze').addEventListener('click', reanalyzeWindow);
    $('resetWin').addEventListener('click', () => {
      state.winStart = 0;
      state.winLen = 60;
      state.local = null;
      startSlider.value = 0;
      lenSlider.value = 60;
      updateWindowReadout();
      drawMap();
      drawZoom();
      $('reanalyzeNote').textContent = '';
    });
    $('clipLen').addEventListener('input', () => {
      state.clipLen = parseFloat($('clipLen').value);
    });
    $('play').addEventListener('click', () => audition(state.winStart));
    $('stop').addEventListener('click', () => {
      stopPlayback();
      $('playReadout').textContent = '已停止';
    });
    bindCanvasAudition();
    window.addEventListener('resize', () => { drawMap(); drawZoom(); });
  }

  async function main() {
    renderCards();
    renderStrategy();
    renderRegionTable();
    drawMap();
    bindControls();
    updateWindowReadout();
    drawZoom();
    try {
      await initAudio();
    } catch (err) {
      $('playReadout').innerHTML = `<span style="color:var(--loud)">${err.message}</span>`;
    }
    window.__audioReady = {
      hasCtx: !!audioCtx, ctxRate: audioCtx && audioCtx.sampleRate,
      hasBuffer: !!audioBuffer, hasSamples: !!fullSamples,
      samplesLen: fullSamples && fullSamples.length,
    };
  }
  window.addEventListener('DOMContentLoaded', main);
})();
