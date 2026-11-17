import { SimulatedPlayer } from './src/player.js';
import { CONFIG, segmentIndexAt, totalSegments } from './src/config.js';

const player = new SimulatedPlayer();
const TOTAL = totalSegments();

const els = {
  timeline: document.getElementById('timeline'),
  play: document.getElementById('btn-play'),
  step: document.getElementById('btn-step'),
  backward: document.getElementById('btn-backward-seek'),
  rapid: document.getElementById('btn-rapid-seek'),
  reset: document.getElementById('btn-reset'),
  speed: document.getElementById('speed'),
  seekTime: document.getElementById('seek-time'),
  seek: document.getElementById('btn-seek'),
  eventLog: document.getElementById('event-log'),
  memoryBar: document.getElementById('memory-bar'),
};

// 为每个分片建一个 DOM 格，状态切换只改 className，避免反复重建。
const segmentEls = [];
for (let index = 0; index < TOTAL; index += 1) {
  const cell = document.createElement('div');
  cell.className = 'segment never';
  cell.dataset.index = index;
  const tip = document.createElement('span');
  tip.className = 'tip';
  cell.appendChild(tip);
  if (index % 10 === 0) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = `${index * CONFIG.SEGMENT_DURATION}s`;
    cell.appendChild(tick);
  }
  cell.addEventListener('click', () => {
    player.seek(index * CONFIG.SEGMENT_DURATION);
    render();
  });
  segmentEls.push(cell);
  els.timeline.appendChild(cell);
}

function statusOf(index, state) {
  if (state.resident.video.includes(index)) return 'resident';
  // 请求中：以 generation 匹配的在途键为准（fetcher 内部状态经 state 暴露）
  if (state.inFlightKeys.some((key) => key.endsWith(`:${index}`))) return 'in-flight';
  if (state.stats.evictedIndexCount > 0 && state.evictedIndexList.includes(index)) return 'evicted';
  return 'never';
}

function render() {
  const state = player.getState();
  for (let index = 0; index < TOTAL; index += 1) {
    const cell = segmentEls[index];
    const status = statusOf(index, state);
    cell.className = `segment ${status}`;
    if (index === state.currentIndex) cell.classList.add('playhead');
    if (index === state.pendingTargetIndex && state.pendingTargetIndex !== state.currentIndex) {
      cell.classList.add('pending-target');
    }
    const start = index * CONFIG.SEGMENT_DURATION;
    cell.querySelector('.tip').textContent =
      `#${index} ${start}-${start + CONFIG.SEGMENT_DURATION}s · ${statusLabel(status)}`;
  }
  renderStats(state);
  renderEvents(state);
}

function statusLabel(status) {
  return { resident: '已驻留', 'in-flight': '请求中', evicted: '已驱逐', never: '未加载' }[status];
}

function renderStats(state) {
  const { stats } = state;
  document.getElementById('stat-current').textContent = `${state.currentTime.toFixed(1)} s`;
  document.getElementById('stat-clock').textContent =
    `虚拟时钟 ${state.clockTime.toFixed(1)}s · 分片 #${state.currentIndex} · ${state.playing ? '播放中' : '已暂停'}`;

  const mb = state.residentBytes / 1e6;
  const limitMb = state.memoryLimit / 1e6;
  document.getElementById('stat-memory').textContent = `${mb.toFixed(2)} / ${limitMb.toFixed(1)} MB`;
  const pct = Math.min(100, (state.residentBytes / state.memoryLimit) * 100);
  els.memoryBar.style.width = `${pct}%`;
  els.memoryBar.classList.toggle('over', state.residentBytes > state.memoryLimit);

  document.getElementById('stat-evicted').textContent = `${stats.evictedDurationSeconds} s`;
  document.getElementById('stat-evicted-bytes').textContent =
    `约 ${(stats.evictedBytes / 1e6).toFixed(2)} MB · ${stats.evictedIndexCount} 个分片`;

  document.getElementById('stat-refetch').textContent = `${stats.refetchGroupRequests} 组`;
  document.getElementById('stat-refetch-detail').textContent =
    `命中已驱逐 ${stats.seeksIntoEvicted} 次 · 去重分片 ${stats.distinctRefetchSegments} 个`;

  document.getElementById('stat-requests').textContent = `${stats.totalRequests} 次`;
  document.getElementById('stat-requests-detail').textContent =
    `完成 ${stats.completedRequests} · abort ${stats.cancelledRequests} · 过期丢弃 ${stats.staleDropped}`;

  const r = state.lastRendered;
  const aligned = r && r.videoTime === r.audioTime && r.audioTime === r.textTime;
  const av = document.getElementById('stat-avsync');
  av.textContent = r ? (aligned ? '已对齐 ✓' : '未对齐 ✗') : 'waiting…';
  av.style.color = r ? (aligned ? 'var(--resident)' : 'var(--danger)') : 'var(--inflight)';
  document.getElementById('stat-avsync-detail').textContent = r
    ? `视频 ${r.videoTime}s / 音频 ${r.audioTime}s / 字幕 ${r.textTime}s（#${r.index}）`
    : '三轨未全部就绪，保持上一帧不渲染';
}

function renderEvents(state) {
  const recent = player.stats.events.slice(-30).reverse();
  els.eventLog.innerHTML = '';
  for (const event of recent) {
    const li = document.createElement('li');
    const t = event.time === null ? '' : `[${event.time.toFixed(1)}s] `;
    li.textContent = t + event.message;
    if (event.message.includes('evict')) li.classList.add('evict');
    if (event.message.includes('refetch')) li.classList.add('refetch');
    if (event.message.includes('cancel')) li.classList.add('cancel');
    els.eventLog.appendChild(li);
  }
}

// ---- 动画循环：用真实 requestAnimationFrame 驱动虚拟时钟 --------------------
let lastFrame = performance.now();
let running = true;

function frame(now) {
  const realDelta = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running) {
    const speed = Number(els.speed.value);
    player.clock.advance(realDelta * speed);
    if (player.currentTime >= CONFIG.DURATION - 0.01) running = false;
  }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

els.play.addEventListener('click', () => {
  running = !running;
  player.playing = running;
  els.play.textContent = running ? '暂停' : '播放';
});

els.step.addEventListener('click', () => {
  running = false;
  player.playing = true;
  player.clock.advance(1);
  els.play.textContent = '播放';
  render();
});

els.seek.addEventListener('click', () => {
  const target = Number(els.seekTime.value);
  if (Number.isFinite(target)) {
    player.seek(target);
    render();
  }
});

els.reset.addEventListener('click', () => location.reload());

// ---- 场景①：长距离回跳 -----------------------------------------------------
els.backward.addEventListener('click', () => {
  running = false;
  player.playing = true;
  player.clock.advance(480 - player.clock.now() > 0 ? 480 - player.clock.now() : 0);
  render();
  setTimeout(() => {
    player.seek(60);
    render();
    setTimeout(() => {
      player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.6);
      render();
    }, 400);
  }, 500);
});

// ---- 场景②：快速连续拖动 ---------------------------------------------------
els.rapid.addEventListener('click', () => {
  running = false;
  player.playing = true;
  if (player.clock.now() < 300) player.clock.advance(300 - player.clock.now());
  render();
  const targets = [200, 40, 350, 120, 260];
  targets.forEach((target, i) => {
    setTimeout(() => {
      player.seek(target);
      player.clock.advance(0.2);
      render();
      if (i === targets.length - 1) {
        setTimeout(() => {
          player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.6);
          render();
        }, 500);
      }
    }, 350 * (i + 1));
  });
});

render();
