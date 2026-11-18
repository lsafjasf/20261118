// Verification reports. Deliberately excludes any pixel data, screenshots,
// thumbnails or encoded frames: only hashes, indices and byte ranges.

export function buildReport({
  referenceName,
  candidateName,
  scenario,
  blockSize,
  timeline,
  referenceMeta,
  candidateMeta,
  decodeErrors,
}) {
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: 'webcodecs-frame-integrity',
    scenario,
    blockSize,
    files: {
      reference: {
        name: referenceName,
        byteLength: referenceMeta.byteLength,
        sampleCount: referenceMeta.sampleCount,
        timescale: referenceMeta.timescale,
      },
      candidate: {
        name: candidateName,
        byteLength: candidateMeta.byteLength,
        sampleCount: candidateMeta.sampleCount,
        timescale: candidateMeta.timescale,
      },
      equalLength: referenceMeta.byteLength === candidateMeta.byteLength,
    },
    totals: timeline.totals,
    verdict: timeline.verdict,
    decodeErrors: decodeErrors || [],
    byteRuns: timeline.byteRuns,
    frames: timeline.frames.map((frame) => ({
      frameIndex: frame.frameIndex,
      pts: frame.pts,
      sampleIndex: frame.sampleIndex ?? frame.frameIndex,
      status: frame.status,
      changedBlockCount: frame.changedBlockCount,
      planes: frame.planes,
      sampleMutated: frame.sampleMutated || false,
      linkedRuns: frame.linkedRuns,
      changedBlocks: frame.changedBlocks,
    })),
    contentNotice: 'No pixel data, images or encoded frames are embedded in this report.',
  };
}

export function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function reportToHtml(report) {
  const rows = report.frames.map((frame) => `
      <tr class="status-${esc(frame.status)}">
        <td>${esc(frame.frameIndex)}</td>
        <td>${esc(frame.pts)}</td>
        <td>${esc(frame.status)}</td>
        <td>${esc(frame.changedBlockCount)}</td>
        <td>Y:${esc(frame.planes.Y)} U:${esc(frame.planes.U)} V:${esc(frame.planes.V)}</td>
        <td>${esc(frame.linkedRuns.map((run) => `${run.start}-${run.end}`).join(', ') || '-')}</td>
      </tr>`).join('');
  const runRows = report.byteRuns.map((run) => `
      <tr>
        <td>${esc(run.kind)}</td>
        <td>${esc(run.start)}-${esc(run.end)}</td>
        <td>${esc(run.sampleIndex ?? '-')}</td>
        <td>${esc(run.frameType || run.region || '-')}</td>
      </tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>视频帧完整性验证报告 - ${esc(report.scenario)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a2330; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.85rem; }
  th, td { border: 1px solid #c9d2dc; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #eef2f6; }
  .status-pixels-differ { background: #ffe7e3; }
  .status-match { background: #e8f6ec; }
  .notice { background: #fff8e1; border: 1px solid #e3c268; padding: 0.8rem; }
  .verdict { font-weight: 700; font-size: 1.1rem; }
</style>
</head>
<body>
  <h1>视频帧完整性验证报告</h1>
  <p class="verdict">结论：${esc(report.verdict)} ｜ 场景：${esc(report.scenario)}</p>
  <p>参考文件：${esc(report.files.reference.name)} ｜ 校验文件：${esc(report.files.candidate.name)} ｜ 分块：${esc(report.blockSize)}px</p>
  <p>帧总数 ${esc(report.totals.frames)}，像素差异帧 ${esc(report.totals.pixelDifferent)}，元数据字节段 ${esc(report.totals.metadataRuns)}，采样字节段 ${esc(report.totals.sampleRuns)}</p>
  <h2>字节差异区间</h2>
  <table><thead><tr><th>类型</th><th>字节区间</th><th>采样索引</th><th>帧类型/区域</th></tr></thead>
  <tbody>${runRows || '<tr><td colspan="4">无差异</td></tr>'}</tbody></table>
  <h2>时间线帧校验</h2>
  <table><thead><tr><th>帧</th><th>PTS</th><th>状态</th><th>变化块</th><th>平面分布</th><th>关联字节区间</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="notice">${esc(report.contentNotice)}</p>
</body>
</html>`;
}
