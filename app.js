/* app.js — 页面逻辑：加载分片、拖拽换序、渲染诊断、拼接/修复/导出 */
'use strict';

const state = {
  chunks: [],        // [{ name, bytes: Uint8Array }]
  analysis: null,    // WebmEbml.analyzeChunks 结果
  lastReport: null,  // 最近一次修复报告
  objectUrl: null,
};

const $ = (id) => document.getElementById(id);

/* ---------- 文件加载 ---------- */

async function addFiles(fileList) {
  for (const file of fileList) {
    const buf = await file.arrayBuffer();
    state.chunks.push({ name: file.name, bytes: new Uint8Array(buf) });
  }
  refresh();
}

function refresh() {
  state.analysis = state.chunks.length ? WebmEbml.analyzeChunks(state.chunks) : null;
  state.lastReport = null;
  renderChunkList();
  renderDiagnostics();
  const has = state.chunks.length > 0;
  $('btn-merge').disabled = !has;
  $('btn-repair').disabled = !has;
  $('btn-export').disabled = !has;
}

/* ---------- 分片列表（拖拽换序） ---------- */

function renderChunkList() {
  const list = $('chunk-list');
  list.innerHTML = '';
  state.chunks.forEach((chunk, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = i;
    const entry = state.analysis ? state.analysis.chunks[i] : null;
    const clusterCount = entry ? entry.clusters.length : 0;
    const badges = [];
    if (entry && entry.hasEbml) badges.push('<span class="badge ok">EBML 头</span>');
    if (entry && !entry.hasEbml && i === 0) badges.push('<span class="badge bad">缺头部</span>');
    if (clusterCount) badges.push(`<span class="badge">${clusterCount} 个 Cluster</span>`);
    li.innerHTML =
      `<span class="handle">⠿</span><span class="name">#${i} ${chunk.name}</span>` +
      `<span class="meta">${chunk.bytes.length} 字节</span>${badges.join('')}`;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = Number(li.dataset.index);
      if (Number.isInteger(from) && from !== to) {
        const [moved] = state.chunks.splice(from, 1);
        state.chunks.splice(to, 0, moved);
        refresh();
      }
    });
    list.appendChild(li);
  });
}

/* ---------- 诊断渲染 ---------- */

function renderDiagnostics() {
  const stats = $('stats');
  const tbody = document.querySelector('#cluster-table tbody');
  const issues = $('issue-list');
  const tree = $('structure-tree');
  tbody.innerHTML = '';
  issues.innerHTML = '';
  tree.textContent = '';
  if (!state.analysis) {
    stats.textContent = '尚未加载分片。';
    return;
  }
  const a = state.analysis;
  const errors = a.issues.filter((i) => i.level === 'error').length;
  const warns = a.issues.filter((i) => i.level === 'warn').length;
  stats.innerHTML =
    `分片 <b>${a.chunks.length}</b> 个，共 <b>${a.totalBytes}</b> 字节，` +
    `Cluster <b>${a.clusters.length}</b> 个，` +
    `错误 <b>${errors}</b>，警告 <b>${warns}</b>`;

  a.clusters.forEach((cl, i) => {
    const tr = document.createElement('tr');
    const flags = [
      cl.unknownSize ? '未知长度' : '',
      cl.truncated ? '截断' : '',
    ].filter(Boolean).join(', ');
    tr.innerHTML =
      `<td>${i}</td><td>${state.chunks[cl.chunkIndex].name}</td>` +
      `<td>${WebmEbml.hex(cl.globalStart)}</td><td>${cl.size}</td>` +
      `<td>${cl.timecode === null ? '—' : cl.timecode}</td>` +
      `<td>${cl.blockCount}</td><td>${flags}</td>`;
    tbody.appendChild(tr);
  });

  for (const issue of a.issues) {
    const li = document.createElement('li');
    li.className = issue.level;
    li.innerHTML = `<code>[${issue.level}] ${issue.code} @ ${WebmEbml.hex(issue.offset)}</code> ${issue.message}`;
    issues.appendChild(li);
  }
  if (!a.issues.length) {
    issues.innerHTML = '<li class="info"><code>[ok]</code> 未发现结构问题</li>';
  }

  tree.textContent = a.chunks
    .map((entry, i) => formatChunkTree(entry, i))
    .join('\n');
}

function formatChunkTree(entry, index) {
  const lines = [`分片 #${index} ${entry.name}（全局基址 ${WebmEbml.hex(entry.offset)}，${entry.size} 字节）`];
  const walk = (els, indent) => {
    for (const el of els) {
      const size = el.unknownSize ? '未知长度' : `${el.size}B`;
      const flags = [el.truncated ? ' [截断!]' : ''].join('');
      lines.push(
        `${indent}${el.name} ${el.idHex} @${WebmEbml.hex(entry.offset + el.start)} 头${el.headerSize}B 数据${size}${flags}`
      );
      if (el.children.length) walk(el.children, indent + '  ');
    }
  };
  walk(entry.elements, '  ');
  return lines.join('\n');
}

/* ---------- 拼接 / 修复 / 导出 ---------- */

function setOutput(bytes, label) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const blob = new Blob([bytes], { type: 'video/webm' });
  state.objectUrl = URL.createObjectURL(blob);
  $('player').src = state.objectUrl;
  const link = $('download-link');
  link.href = state.objectUrl;
  link.classList.remove('hidden');
  link.textContent = `下载结果（${label}，${bytes.length} 字节）`;
}

function onMerge() {
  if (!state.chunks.length) return;
  const bytes = WebmRepair.mergeChunks(state.chunks);
  setOutput(bytes, '按当前顺序拼接');
  $('repair-summary').innerHTML =
    `按当前顺序原样拼接：输入 <b>${state.analysis.totalBytes}</b> 字节，` +
    `输出 <b>${bytes.length}</b> 字节（未做结构修复）。`;
}

function onRepair() {
  if (!state.chunks.length) return;
  const { bytes, report } = WebmRepair.repairChunks(state.chunks);
  state.lastReport = report;
  if (!bytes) {
    $('repair-summary').textContent = '修复失败：' + report.notes.join('；');
    return;
  }
  setOutput(bytes, '自动修复');
  const notes = report.notes.length
    ? '<br>' + report.notes.map((n) => `• ${n}`).join('<br>')
    : '';
  $('repair-summary').innerHTML =
    `修复前 <b>${report.inputBytes}</b> 字节 → 修复后 <b>${report.outputBytes}</b> 字节，` +
    `保留 Cluster <b>${report.clusterCount}</b> 个，` +
    `时间码序列 <b>[${report.timecodes.join(', ')}]</b>${notes}`;
}

function onExport() {
  if (!state.analysis) return;
  const report = state.lastReport || WebmRepair.repairChunks(state.chunks).report;
  const text = WebmRepair.formatReport(state.analysis, report);
  const json = JSON.stringify({
    generatedAt: new Date().toISOString(),
    chunks: state.chunks.map((c, i) => ({ index: i, name: c.name, bytes: c.bytes.length })),
    inputBytes: report.inputBytes,
    outputBytes: report.outputBytes,
    timecodes: report.timecodes,
    clusters: report.clusters,
    issues: state.analysis.issues,
    notes: report.notes,
  }, null, 2);
  downloadText('webm-diagnostic-report.txt', text + '\n');
  downloadText('webm-diagnostic-report.json', json + '\n');
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- 事件绑定 ---------- */

$('file-input').addEventListener('change', (e) => addFiles(e.target.files));

const dropZone = $('drop-zone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

$('btn-merge').addEventListener('click', onMerge);
$('btn-repair').addEventListener('click', onRepair);
$('btn-export').addEventListener('click', onExport);

refresh();
