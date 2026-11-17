import { framesToTC } from '../src/core/timecode.js';

const state = {
  bootstrap: null,
  report: null,
  proxies: null,
  enabledFaults: new Set(),
  activeFilter: 'all',
  search: '',
};

const $ = (id) => document.getElementById(id);

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function runCheck() {
  const payload = {
    faultIds: [...state.enabledFaults],
    tolerances: {
      startFrameTolerance: Number($('tol-start').value) || 0,
      durationTolerance: Number($('tol-duration').value) || 0,
      audioOffsetToleranceMs: Number($('tol-audio').value) || 0,
    },
  };
  const data = await fetchJson('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.report = data.report;
  state.proxies = data.proxies;
  renderAll();
}

function renderFaultPanel() {
  const { faultLibrary } = state.bootstrap;
  $('fault-list').innerHTML = faultLibrary.map((fault) => `
    <label class="fault-item" data-fault="${fault.id}">
      <input type="checkbox" ${state.enabledFaults.has(fault.id) ? 'checked' : ''} />
      <div>
        <span class="fault-tag ${fault.required ? 'tag-required' : 'tag-optional'}">
          ${fault.required ? '必选演示' : '可选'}
        </span>
        <div class="fault-title">${fault.title}</div>
      </div>
    </label>
  `).join('');

  $('fault-list').querySelectorAll('.fault-item').forEach((item) => {
    item.addEventListener('change', () => {
      const id = item.dataset.fault;
      if (item.querySelector('input').checked) state.enabledFaults.add(id);
      else state.enabledFaults.delete(id);
      runCheck().catch(showError);
    });
  });
}

function showError(err) {
  showToast(`检查失败: ${err.message}`);
}

let toastTimer;
function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

async function init() {
  state.bootstrap = await fetchJson('/api/bootstrap');
  state.enabledFaults = new Set(state.bootstrap.defaultFaultIds);
  renderFaultPanel();
  bindStaticEvents();
  await runCheck();
}

function bindStaticEvents() {
  $('btn-rerun').addEventListener('click', () => runCheck().catch(showError));
  $('btn-select-required').addEventListener('click', () => {
    state.enabledFaults = new Set(state.bootstrap.defaultFaultIds);
    renderFaultPanel();
    runCheck().catch(showError);
  });
  $('btn-select-all').addEventListener('click', () => {
    state.enabledFaults = new Set(state.bootstrap.faultLibrary.map((f) => f.id));
    renderFaultPanel();
    runCheck().catch(showError);
  });
  $('btn-select-none').addEventListener('click', () => {
    state.enabledFaults = new Set();
    renderFaultPanel();
    runCheck().catch(showError);
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderIssues();
  });
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-overlay').addEventListener('click', (e) => {
    if (e.target === $('detail-overlay')) closeDetail();
  });
  $('btn-export-csv').addEventListener('click', () => exportCurrent('csv'));
  $('btn-export-json').addEventListener('click', () => exportCurrent('json'));
}

async function exportCurrent(format) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faultIds: [...state.enabledFaults], format }),
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `proxy-mapping-pre-conform.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast(`代理替换前映射表已导出（${format.toUpperCase()}）`);
}

function closeDetail() {
  $('detail-overlay').classList.add('hidden');
}

function renderAll() {
  renderSummary();
  renderFilters();
  renderIssues();
  renderClipTable();
  renderTimeline();
}

init().catch(showError);

const SEVERITY_LABEL = { critical: '严重', major: '重要', minor: '提示', warning: '警告' };

const TYPE_LABEL = {
  fps_mismatch: '帧率错误',
  audio_offset: '音频偏移',
  start_early: '起始帧提前',
  start_late: '起始帧延后',
  duration_mismatch: '时长不符',
  reel_mismatch: '卷轴名不符',
  clipname_mismatch: '片段名不符',
  marker_drift: '标记点漂移',
  marker_missing: '标记点缺失',
  marker_unexpected: '多余标记点',
  unlinked_proxy: '无法映射',
  missing_proxy: '缺少代理',
  mapping_weak: '弱映射',
  timeline_unmapped: '时间线未映射',
  timeline_out_of_bounds: '时间线越界',
};

function renderSummary() {
  const s = state.report.summary;
  const cards = [
    { num: s.totalOriginal, label: '原始素材' },
    { num: s.totalProxy, label: '转码代理' },
    { num: s.paired, label: '成功配对' },
    { num: s.issueCount, label: '问题总数', cls: s.issueCount ? 'critical' : 'ok' },
    { num: s.criticalCount, label: '严重问题', cls: s.criticalCount ? 'critical' : 'ok' },
    { num: `${s.timelineUnmapped}/${s.timelineEvents}`, label: '时间线异常事件' },
  ];
  $('summary-cards').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls || ''}">
      <div class="num">${c.num}</div>
      <div class="label">${c.label}</div>
    </div>
  `).join('');
}

function renderFilters() {
  const types = ['all', ...new Set(state.report.issues.map((i) => i.type))];
  $('filters').innerHTML = types.map((type) => `
    <button class="chip ${state.activeFilter === type ? 'active' : ''}" data-type="${type}">
      ${type === 'all' ? '全部' : (TYPE_LABEL[type] || type)}
    </button>
  `).join('');
  $('filters').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.activeFilter = chip.dataset.type;
      renderFilters();
      renderIssues();
    });
  });
}

function renderIssues() {
  if (!state.report) return;
  const keyword = state.search;
  const filtered = state.report.issues.filter((item) => {
    if (state.activeFilter !== 'all' && item.type !== state.activeFilter) return false;
    if (!keyword) return true;
      const haystack = [item.proxyId, item.clipName, item.reelName, item.message, item.type]
        .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(keyword);
  });

  if (!filtered.length) {
    $('issue-list').innerHTML = '<p class="muted" style="padding:8px 4px">没有匹配的问题。</p>';
    return;
  }

  $('issue-list').innerHTML = filtered.map((item) => `
    <div class="issue-card sev-${item.severity}" data-proxy="${item.proxyId || ''}">
      <span class="sev sev-badge-${item.severity}">${SEVERITY_LABEL[item.severity] || item.severity}</span>
      <span class="proxy">${item.proxyId || '—'}</span>
      <span class="msg">${item.message}</span>
      <span class="type">${TYPE_LABEL[item.type] || item.type}</span>
    </div>
  `).join('');

  $('issue-list').querySelectorAll('.issue-card').forEach((card) => {
    card.addEventListener('click', () => locateClip(card.dataset.proxy));
  });
}

/** 定位到具体片段：高亮表格行并弹出详情 */
function locateClip(proxyId) {
  if (!proxyId) {
    showToast('该问题不绑定具体代理，请查看时间线或缺失项');
    return;
  }
  const clip = state.report.clipReports.find((c) => c.proxyId === proxyId);
  if (!clip) return;
  openDetail(clip);
  const row = document.querySelector(`tr[data-proxy="${proxyId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  }
}

function renderClipTable() {
  const tbody = $('clip-table').querySelector('tbody');
  tbody.innerHTML = state.report.clipReports.map((clip) => {
    const fps = clip.original?.fps ?? clip.proxy.fps;
    const markerHtml = clip.proxy.markers?.length
      ? clip.proxy.markers.map((m) => {
          const result = clip.markers.find((r) => r.name === m.name);
          const bad = result && result.status !== 'ok';
          return `<span class="marker-pill ${bad ? 'bad' : ''}">${m.name}@${m.frame}</span>`;
        }).join('')
      : '<span class="muted">无</span>';
    return `
      <tr class="row-${clip.status}" data-proxy="${clip.proxyId}">
        <td><span class="status-dot dot-${clip.status}"></span>${
          clip.status === 'ok' ? '正常' : clip.status === 'critical' ? '严重' : '警告'
        }</td>
        <td class="mono">${clip.proxyId}<br /><span class="muted">${clip.clipName}</span></td>
        <td>${clip.reelName}<br /><span class="muted mono">${clip.sourceId || '未映射'}</span></td>
        <td class="mono">${clip.proxy.fps}${clip.original && clip.proxy.fps !== clip.original.fps
          ? ` <span class="detail-diff">/ ${clip.original.fps}</span>` : ''}</td>
        <td class="mono">${clip.proxy.sourceStartFrame}<br /><span class="muted">${framesToTC(clip.proxy.sourceStartFrame, fps)}</span></td>
        <td class="mono">${clip.proxy.totalFrames}</td>
        <td class="mono">${clip.proxy.audioOffsetMs} ms</td>
        <td>${markerHtml}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => {
      const clip = state.report.clipReports.find((c) => c.proxyId === row.dataset.proxy);
      openDetail(clip);
    });
  });
}

function fieldRow(label, actual, expected, diffText) {
  const differs = actual !== expected;
  return `
    <div class="detail-row">
      <span class="k">${label}</span>
      <span class="mono ${differs ? 'detail-diff' : 'detail-diff good'}">
        实际 ${actual ?? '—'}${differs ? ` / 期望 ${expected ?? '—'}` : ''}
        ${diffText ? `（${diffText}）` : ''}
      </span>
    </div>`;
}

function openDetail(clip) {
  const proxy = clip.proxy;
  const original = clip.original;
  const fps = original?.fps ?? proxy.fps;
  const issuesHtml = clip.issues.length
    ? clip.issues.map((i) => `<li><span class="detail-diff">${TYPE_LABEL[i.type] || i.type}</span> — ${i.message}</li>`).join('')
    : '<li class="detail-diff good">全部字段一致，可安全替换。</li>';

  const markerRows = clip.markers.length
    ? clip.markers.map((m) => `
      <div class="detail-row">
        <span class="k">标记 ${m.name}</span>
        <span class="mono ${m.status === 'ok' ? 'detail-diff good' : 'detail-diff'}">
          代理 ${m.proxyFrame ?? '—'} / 原片 ${m.originalFrame ?? '—'}
          ${m.delta ? `（Δ ${m.delta > 0 ? '+' : ''}${m.delta} 帧）` : ''}
        </span>
      </div>`).join('')
    : '<p class="muted">无标记点</p>';

  $('detail-body').innerHTML = `
    <h2 style="margin:0">${clip.clipName} <span class="muted mono">(${clip.proxyId})</span></h2>
    <p class="muted" style="margin:6px 0 0">
      卷轴 ${clip.reelName} · 映射方式 ${clip.matchedBy === 'sourceId' ? 'sourceId 直连' : clip.matchedBy === 'none' ? '映射失败' : '命名回退'}
    </p>
    <div class="detail-grid">
      <div class="detail-box">
        <h3>代理元数据 vs 原片</h3>
        ${fieldRow('帧率', proxy.fps, original?.fps ?? '—')}
        ${fieldRow('起始帧', proxy.sourceStartFrame, original?.sourceStartFrame ?? '—')}
        ${fieldRow('起始时间码', framesToTC(proxy.sourceStartFrame, fps),
          original ? framesToTC(original.sourceStartFrame, fps) : '—')}
        ${fieldRow('总帧数', proxy.totalFrames, original?.totalFrames ?? '—')}
        ${fieldRow('音频偏移', `${proxy.audioOffsetMs} ms`, original ? `${original.audioOffsetMs} ms` : '—')}
      </div>
      <div class="detail-box">
        <h3>标记点交叉验证</h3>
        ${markerRows}
      </div>
    </div>
    <div class="detail-box">
      <h3>命中问题（${clip.issues.length}）</h3>
      <ul style="margin:0; padding-left:18px; line-height:1.8">${issuesHtml}</ul>
    </div>
  `;
  $('detail-overlay').classList.remove('hidden');
}

function renderTimeline() {
  $('timeline-view').innerHTML = state.report.timeline.map((entry) => {
    const event = entry.event;
    const bad = entry.status !== 'ok';
    const clip = entry.pair
      ? state.report.clipReports.find((c) => c.proxyId === entry.pair.proxy.id)
      : null;
    return `
      <div class="tl-event ${bad ? 'tl-bad' : 'tl-ok'}" data-proxy="${event.proxyId}">
        <span class="tl-track">${event.id}</span>
        <span class="tl-track">${event.track}</span>
        <span class="mono">${event.proxyId}</span>
        <span class="mono muted">源帧 ${event.sourceInFrame} → ${event.sourceOutFrame}</span>
        <span class="${bad ? 'detail-diff' : 'detail-diff good'}">
          ${bad ? (entry.status === 'unmapped' ? '映射失败' : '源范围越界') : `→ ${clip?.sourceId || '—'}`}
        </span>
      </div>
    `;
  }).join('');

  $('timeline-view').querySelectorAll('.tl-event').forEach((row) => {
    row.addEventListener('click', () => locateClip(row.dataset.proxy));
  });
}
