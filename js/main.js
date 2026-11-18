import { buildShots } from './detector.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const timeline = $('timeline');
const statusEl = $('status');

const state = {
  duration: 0,
  boundaries: [], // {time, type, confidence, score, spanStart, spanEnd, manual?}
  shots: [],
  diffs: [],
  thresholds: null,
  selected: -1,
  worker: null,
  thumbReqs: new Map(),
  thumbSeq: 0,
};

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function getWorker() {
  if (state.worker) return state.worker;
  const w = new Worker('js/worker.js', { type: 'module' });
  w.onerror = (e) => {
    setStatus(`Worker 错误：${e.message || e.type}`);
    $('runBtn').disabled = false;
  };
  w.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      setStatus(`解码中 ${msg.decoded}/${msg.total} 帧…`);
    } else if (msg.type === 'info') {
      setStatus(`已解析封装：${msg.codec}，时长 ${msg.duration.toFixed(2)}s`);
    } else if (msg.type === 'result') {
      onResult(msg);
    } else if (msg.type === 'thumbs') {
      const req = state.thumbReqs.get(msg.reqId);
      if (req) {
        state.thumbReqs.delete(msg.reqId);
        req(msg.thumbs);
      }
    } else if (msg.type === 'error') {
      setStatus(`出错：${msg.message}`);
      $('runBtn').disabled = false;
    }
  };
  state.worker = w;
  return w;
}

function requestThumbs(times) {
  return new Promise((resolve) => {
    const reqId = ++state.thumbSeq;
    state.thumbReqs.set(reqId, resolve);
    getWorker().postMessage({ type: 'thumbs', reqId, times });
  });
}

async function loadFile(file) {
  const buf = await file.arrayBuffer();
  state.fileBuffer = buf;
  video.src = URL.createObjectURL(file);
  $('runBtn').disabled = false;
  setStatus(`已加载 ${file.name}（${(buf.byteLength / 1024 / 1024).toFixed(2)} MB），点击“开始检测”`);
}

async function loadDemo() {
  setStatus('加载示例视频…');
  // Prefer H.264; fall back to VP9 build for browsers without H.264.
  const candidates = ['assets/test-video.mp4', 'assets/test-video-vp9.mp4'];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.fileBuffer = await res.arrayBuffer();
      video.src = url;
      $('runBtn').disabled = false;
      setStatus(`已加载示例视频（${url.split('/').pop()}），点击“开始检测”`);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  setStatus(`示例视频加载失败：${lastErr}`);
}

function runDetect() {
  if (!state.fileBuffer) return;
  $('runBtn').disabled = true;
  state.selected = -1;
  $('editPanel').classList.add('hidden');
  setStatus('检测中…');
  const buf = state.fileBuffer;
  state.fileBuffer = buf.slice(0); // keep a copy; the transferred one detaches
  getWorker().postMessage({
    type: 'detect',
    file: buf,
    options: {
      interval: parseFloat($('intervalSel').value),
      minShotLen: parseFloat($('minShotSel').value),
    },
  }, [buf]);
}

async function onResult(msg) {
  state.duration = msg.duration;
  state.boundaries = msg.boundaries;
  state.diffs = msg.diffs;
  state.thresholds = msg.thresholds;
  state.shots = msg.shots;
  attachThumbs(msg.shots);
  renderAll();
  const hard = msg.boundaries.filter((b) => b.type === 'hard').length;
  const gradual = msg.boundaries.filter((b) => b.type === 'gradual').length;
  setStatus(`检测完成：${msg.shots.length} 个镜头，${hard} 个硬切，${gradual} 个渐变`);
  $('runBtn').disabled = false;
}

function attachThumbs(shots) {
  for (const shot of shots) {
    if (shot.thumb) {
      const img = new ImageData(new Uint8ClampedArray(shot.thumb), shot.thumbW, shot.thumbH);
      shot.thumbBitmap = null;
      createImageBitmap(img).then((bmp) => {
        shot.thumbBitmap = bmp;
        renderShots();
      });
    }
  }
}

// Rebuild shots from the (possibly user-edited) boundary list, fetching
// representative frames from the worker for the new shot midpoints.
async function rebuildShots() {
  state.boundaries.sort((a, b) => a.time - b.time);
  const shots = buildShots(state.boundaries, state.duration);
  state.shots = shots;
  const thumbs = await requestThumbs(shots.map((s) => s.repTime));
  shots.forEach((shot, i) => {
    const th = thumbs[i];
    if (th) {
      const img = new ImageData(new Uint8ClampedArray(th.data), th.width, th.height);
      createImageBitmap(img).then((bmp) => {
        shot.thumbBitmap = bmp;
        renderShots();
      });
    }
  });
  renderAll();
}

function renderAll() {
  renderTimeline();
  renderShots();
  renderStats();
}

function renderStats() {
  const hard = state.boundaries.filter((b) => b.type === 'hard').length;
  const gradual = state.boundaries.filter((b) => b.type === 'gradual').length;
  $('shotStats').textContent =
    `共 ${state.shots.length} 个镜头 ｜ 硬切 ${hard} ｜ 渐变 ${gradual}`;
}

function timeToX(t, w) {
  return state.duration > 0 ? (t / state.duration) * w : 0;
}

function renderTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = timeline.clientWidth || timeline.parentElement.clientWidth;
  const cssH = 150;
  timeline.width = cssW * dpr;
  timeline.height = cssH * dpr;
  const ctx = timeline.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!state.duration) return;

  const curveH = 90;
  const baseY = curveH + 10;

  // diff score curve
  if (state.diffs.length) {
    let maxScore = 1;
    for (const d of state.diffs) maxScore = Math.max(maxScore, d.score);
    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    state.diffs.forEach((d, i) => {
      const x = timeToX(d.time, cssW);
      const y = baseY - (d.score / maxScore) * curveH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (state.thresholds) {
      const drawTh = (v, color) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 4]);
        const y = baseY - (v / maxScore) * curveH;
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawTh(state.thresholds.tHigh, '#ef4444');
      drawTh(state.thresholds.tLow, '#f59e0b');
    }
  }

  // time ruler
  ctx.fillStyle = '#7f8a99';
  ctx.font = '10px sans-serif';
  const step = state.duration > 60 ? 10 : state.duration > 20 ? 5 : 1;
  for (let t = 0; t <= state.duration + 1e-6; t += step) {
    const x = timeToX(t, cssW);
    ctx.fillRect(x, baseY, 1, 5);
    ctx.fillText(`${t}s`, x + 2, baseY + 13);
  }

  // boundary markers
  state.boundaries.forEach((b, i) => {
    const x = timeToX(b.time, cssW);
    const color = i === state.selected ? '#22d3ee' : b.type === 'hard' ? '#ef4444' : '#f59e0b';
    if (b.type === 'gradual' && b.spanEnd > b.spanStart) {
      ctx.fillStyle = color + '33';
      ctx.fillRect(timeToX(b.spanStart, cssW), 4, timeToX(b.spanEnd, cssW) - timeToX(b.spanStart, cssW), baseY - 4);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = i === state.selected ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, baseY + 16);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5, 4);
    ctx.lineTo(x + 5, 4);
    ctx.lineTo(x, 12);
    ctx.closePath();
    ctx.fill();
  });
}

function boundaryForShot(index) {
  // boundary that ends shot `index` (i.e. starts shot index+1)
  return index + 1 < state.shots.length ? state.boundaries[index] : null;
}

function renderShots() {
  const list = $('shotList');
  list.innerHTML = '';
  state.shots.forEach((shot, i) => {
    const card = document.createElement('div');
    card.className = 'shot-card';
    const cv = document.createElement('canvas');
    cv.width = 96;
    cv.height = 54;
    if (shot.thumbBitmap) cv.getContext('2d').drawImage(shot.thumbBitmap, 0, 0);
    card.appendChild(cv);

    const inB = i > 0 ? state.boundaries[i - 1] : null;
    const rows = [
      `<div class="row"><span class="title">镜头 ${i + 1}</span>` +
        `<span class="badge ${inB ? inB.type : 'start'}">` +
        `${inB ? (inB.type === 'hard' ? '硬切' : '渐变') : '起始'}</span></div>`,
      `<div class="row"><span>起止</span><span>${fmt(shot.start)} → ${fmt(shot.end)}</span></div>`,
      `<div class="row"><span>时长</span><span>${shot.duration.toFixed(2)}s</span></div>`,
      `<div class="row"><span>置信度</span><span>${inB ? (inB.confidence * 100).toFixed(0) + '%' : '—'}</span></div>`,
    ];
    const div = document.createElement('div');
    div.innerHTML = rows.join('');
    card.appendChild(div);
    card.addEventListener('click', () => {
      video.currentTime = shot.start + 0.01;
      video.play().catch(() => {});
    });
    list.appendChild(card);
  });
}

function selectBoundary(i) {
  state.selected = i;
  const panel = $('editPanel');
  if (i < 0) {
    panel.classList.add('hidden');
  } else {
    const b = state.boundaries[i];
    panel.classList.remove('hidden');
    $('editInfo').innerHTML =
      `时间：<b>${fmt(b.time)}</b><br>` +
      `类型：<b>${b.type === 'hard' ? '硬切' : '渐变转场'}</b>${b.manual ? '（手动）' : ''}<br>` +
      `置信度：${(b.confidence * 100).toFixed(0)}%`;
    video.currentTime = b.time;
  }
  renderTimeline();
}

function onTimelineClick(e) {
  if (!state.duration) return;
  const rect = timeline.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = (x / rect.width) * state.duration;
  // hit-test existing markers (within 8px)
  let best = -1;
  let bestD = 8;
  state.boundaries.forEach((b, i) => {
    const d = Math.abs(timeToX(b.time, rect.width) - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best >= 0) {
    selectBoundary(best);
  } else {
    // add a manual boundary at clicked time
    state.boundaries.push({
      time: Math.max(0.01, Math.min(state.duration - 0.01, t)),
      type: 'hard',
      confidence: 1,
      score: 0,
      spanStart: t,
      spanEnd: t,
      manual: true,
    });
    rebuildShots().then(() => {
      selectBoundary(state.boundaries.findIndex((b) => b.manual && Math.abs(b.time - t) < 0.02));
    });
  }
}

$('fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});
$('demoBtn').addEventListener('click', loadDemo);
$('runBtn').addEventListener('click', runDetect);
timeline.addEventListener('click', onTimelineClick);
window.addEventListener('resize', renderTimeline);

$('toggleTypeBtn').addEventListener('click', () => {
  const b = state.boundaries[state.selected];
  if (!b) return;
  b.type = b.type === 'hard' ? 'gradual' : 'hard';
  if (b.type === 'gradual' && b.spanEnd <= b.spanStart) {
    b.spanStart = Math.max(0, b.time - 0.25);
    b.spanEnd = Math.min(state.duration, b.time + 0.25);
  }
  rebuildShots().then(() => selectBoundary(state.selected));
});

$('deleteBtn').addEventListener('click', () => {
  if (state.selected < 0) return;
  state.boundaries.splice(state.selected, 1);
  state.selected = -1;
  $('editPanel').classList.add('hidden');
  rebuildShots();
});

$('closeEditBtn').addEventListener('click', () => selectBoundary(-1));

// Expose state for automated tests.
window.__shotApp = state;
