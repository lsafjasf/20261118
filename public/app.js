import { decodeAndHash, isWebCodecsSupported } from '../src/decoder.js';
import { buildTimeline, diffByteRuns } from '../src/compare.js';
import {
  simulateKeyframeCorruption,
  simulatePFrameCorruption,
  simulateGentlePFrameCorruption,
  simulateMetadataCorruption,
} from '../src/corrupt.js';
import { parseMp4 } from '../src/mp4.js';
import { buildReport, reportToJson, reportToHtml } from '../src/report.js';

const $ = (id) => document.getElementById(id);
const state = {
  sourceBytes: null,
  sourceName: '',
  candidateBytes: null,
  candidateName: '',
  referenceHashes: null,
  candidateHashes: null,
  timeline: null,
  report: null,
  selectedFrame: null,
  injectedRuns: null,
};

const simulators = {
  keyframe: simulateKeyframeCorruption,
  pframe: simulatePFrameCorruption,
  gentlePframe: simulateGentlePFrameCorruption,
  metadata: simulateMetadataCorruption,
};

function setProgress(ratio) {
  $('progressBar').style.width = `${Math.round(ratio * 100)}%`;
}

function setError(message) {
  $('errorBox').textContent = message || '';
}

async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function run() {
  setError('');
  if (!isWebCodecsSupported()) {
    setError('当前浏览器不支持 WebCodecs，请使用 Chromium 系最新版本（Chrome/Edge 94+）。');
    return;
  }
  if (!state.sourceBytes) {
    setError('请先选择源文件。');
    return;
  }
  const blockSize = Number($('blockSize').value);
  const scenario = $('scenario').value;
  $('runBtn').disabled = true;
  try {
    let candidateBytes = state.candidateBytes;
    let candidateName = state.candidateName;
    let injectedRuns = null;
    if (!candidateBytes) {
      const simulation = simulators[scenario](state.sourceBytes);
      candidateBytes = simulation.buffer;
      candidateName = `simulated-${scenario}.mp4`;
      injectedRuns = simulation.byteRuns;
    }
    state.injectedRuns = injectedRuns;

    setProgress(0.1);
    const reference = await decodeAndHash(
      state.sourceBytes, blockSize, (r) => setProgress(0.1 + r * 0.4), true,
    );
    setProgress(0.55);
    const candidate = await decodeAndHash(
      candidateBytes, blockSize, (r) => setProgress(0.55 + r * 0.4), true,
    );
    setProgress(0.98);

    const runs = diffByteRuns(state.sourceBytes, candidateBytes);
    const timeline = buildTimeline(
      reference.frameHashes, candidate.frameHashes, candidate.mp4, runs,
    );
    state.referenceHashes = reference.frameHashes;
    state.candidateHashes = candidate.frameHashes;
    state.timeline = timeline;

    state.report = buildReport({
      referenceName: state.sourceName,
      candidateName,
      scenario: state.candidateBytes ? 'uploaded-candidate' : scenario,
      blockSize,
      timeline,
      referenceMeta: {
        byteLength: state.sourceBytes.length,
        sampleCount: reference.mp4.sampleCount,
        timescale: reference.mp4.timescale,
      },
      candidateMeta: {
        byteLength: candidateBytes.length,
        sampleCount: candidate.mp4.sampleCount,
        timescale: candidate.mp4.timescale,
      },
      decodeErrors: [...reference.errors, ...candidate.errors],
    });
    window.__report = state.report;
    renderSummary(timeline, scenario);
    renderTimeline(timeline);
    $('exportJsonBtn').disabled = false;
    $('exportHtmlBtn').disabled = false;
    setProgress(1);
  } catch (error) {
    setError(`${error.name || 'Error'}: ${error.message}`);
  } finally {
    $('runBtn').disabled = false;
  }
}

function renderSummary(timeline, scenario) {
  $('resultPanel').hidden = false;
  const verdictText = {
    'pixel-damage': '像素损坏（帧哈希不一致）',
    'metadata-only': '仅容器元数据变化（像素完全一致）',
    identical: '完全一致',
  }[timeline.verdict];
  const stats = [
    ['校验结论', verdictText, `verdict-badge verdict-${timeline.verdict}`],
    ['帧总数', timeline.totals.frames],
    ['一致帧', timeline.totals.matching],
    ['像素差异帧', timeline.totals.pixelDifferent],
    ['解码缺失帧', timeline.totals.missing],
    ['采样字节段', timeline.totals.sampleRuns],
    ['元数据/容器字节段', timeline.totals.metadataRuns + timeline.totals.containerRuns],
  ];
  $('summary').innerHTML = stats.map(([label, value, cls]) => `
    <div class="stat"><div class="num ${cls || ''}">${value}</div><div class="label">${label}</div></div>
  `).join('');
  $('timelinePanel').hidden = false;
  $('detailPanel').hidden = false;
  void scenario;
}

function renderTimeline(timeline) {
  const anchored = new Set();
  for (const frame of timeline.frames) {
    if (frame.linkedRuns && frame.linkedRuns.length) anchored.add(frame.frameIndex);
  }
  $('timeline').innerHTML = timeline.frames.map((frame) => `
    <div class="tick ${frame.status} ${anchored.has(frame.frameIndex) ? 'anchored' : ''}"
         data-index="${frame.frameIndex}"
         title="帧 ${frame.frameIndex}｜${frame.status}｜变化块 ${frame.changedBlockCount}"></div>
  `).join('');
  $('timeline').querySelectorAll('.tick').forEach((tick) => {
    tick.addEventListener('click', () => selectFrame(Number(tick.dataset.index)));
  });
  const firstDamaged = timeline.frames.find((frame) => frame.linkedRuns && frame.linkedRuns.length) ||
    timeline.frames.find((frame) => frame.status === 'pixels-differ') ||
    timeline.frames.find((frame) => frame.status === 'missing');
  selectFrame(firstDamaged ? firstDamaged.frameIndex : (timeline.frames[0]?.frameIndex ?? 0));
}

function selectFrame(frameIndex) {
  state.selectedFrame = frameIndex;
  document.querySelectorAll('.tick').forEach((tick) => {
    tick.classList.toggle('selected', Number(tick.dataset.index) === frameIndex);
  });
  const frame = state.timeline.frames.find((item) => item.frameIndex === frameIndex);
  const referenceEntry = state.referenceHashes.find((item) => item.frameIndex === frameIndex);
  if (!frame) return;
  drawLumaWithBlocks(referenceEntry, frame);
  renderBlockTable(frame);
  renderRunTable(frame);
  const statusText = frame.status === 'missing'
    ? '解码失败/缺失（损坏导致该 GOP 不可解码，直到下一个关键帧）'
    : frame.status;
  $('frameCaption').textContent =
    `显示序帧 ${frameIndex}（采样 #${frame.sampleIndex ?? frameIndex}）｜状态 ${statusText}｜变化块 ${frame.changedBlockCount}`;
}

function drawLumaWithBlocks(referenceEntry, frame) {
  const canvas = $('frameCanvas');
  const ctx = canvas.getContext('2d');
  const descriptor = referenceEntry && referenceEntry.descriptor;
  if (!descriptor) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const [luma] = descriptor.planes;
  const image = ctx.createImageData(luma.width, luma.height);
  for (let y = 0; y < luma.height; y += 1) {
    for (let x = 0; x < luma.width; x += 1) {
      const value = luma.data[(luma.offset || 0) + y * luma.stride + x];
      const pixel = (y * luma.width + x) * 4;
      image.data[pixel] = value;
      image.data[pixel + 1] = value;
      image.data[pixel + 2] = value;
      image.data[pixel + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.lineWidth = 1;
  const colors = { Y: '#f2604d', U: '#4f9cf9', V: '#e8b34a' };
  for (const block of frame.changedBlocks) {
    ctx.strokeStyle = colors[block.plane];
    ctx.strokeRect(block.x + 0.5, block.y + 0.5, block.w, block.h);
  }
}

function renderBlockTable(frame) {
  const body = $('blockTable').querySelector('tbody');
  if (frame.status === 'missing') {
    body.innerHTML = '<tr><td colspan="5" class="hint">该帧解码失败，无块哈希；根因见下方字节区间，受影响范围为整个 GOP</td></tr>';
    return;
  }
  if (!frame.changedBlocks.length) {
    body.innerHTML = '<tr><td colspan="5" class="hint">该帧所有分块哈希一致</td></tr>';
    return;
  }
  body.innerHTML = frame.changedBlocks.map((block) => `
    <tr>
      <td>${block.plane}</td>
      <td class="mono">(${block.row}, ${block.col})</td>
      <td class="mono">x:${block.x} y:${block.y} ${block.w}x${block.h}</td>
      <td class="mono">${block.referenceHash}</td>
      <td class="mono">${block.candidateHash}</td>
    </tr>`).join('');
}

function renderRunTable(frame) {
  const body = $('runTable').querySelector('tbody');
  const runs = frame.linkedRuns && frame.linkedRuns.length
    ? frame.linkedRuns
    : state.timeline.byteRuns.filter((run) => run.kind === 'metadata' || run.kind === 'container');
  if (!runs.length) {
    body.innerHTML = '<tr><td colspan="4" class="hint">无关联字节区间</td></tr>';
    return;
  }
  body.innerHTML = runs.map((run) => `
    <tr>
      <td class="kind-${run.kind}">${run.kind}${run.frameType ? ` (${run.frameType})` : ''}${run.region ? ` (${run.region})` : ''}</td>
      <td class="mono">[${run.start}, ${run.end})</td>
      <td class="mono">${run.sampleIndex ?? '-'}</td>
      <td class="mono">${run.sampleByteRange ? `[${run.sampleByteRange[0]}, ${run.sampleByteRange[1]})` : '-'}</td>
    </tr>`).join('');
}

function exportJson() {
  download(`integrity-report-${state.report.scenario}.json`, reportToJson(state.report), 'application/json');
}

function exportHtml() {
  download(`integrity-report-${state.report.scenario}.html`, reportToHtml(state.report), 'text/html');
}

$('sourceFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  state.sourceBytes = await readFile(file);
  state.sourceName = file.name;
  // Sanity parse to surface container errors before decoding.
  parseMp4(state.sourceBytes);
});

$('candidateFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) {
    state.candidateBytes = null;
    state.candidateName = '';
    return;
  }
  state.candidateBytes = await readFile(file);
  state.candidateName = file.name;
});

$('runBtn').addEventListener('click', run);
$('exportJsonBtn').addEventListener('click', exportJson);
$('exportHtmlBtn').addEventListener('click', exportHtml);

$('loadFixtureBtn').addEventListener('click', async () => {
  setError('');
  try {
    const response = await fetch('/fixtures/source.mp4');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.sourceBytes = new Uint8Array(await response.arrayBuffer());
    state.sourceName = 'fixtures/source.mp4';
    state.candidateBytes = null;
    state.candidateName = '';
    $('candidateFile').value = '';
    parseMp4(state.sourceBytes);
  } catch (error) {
    setError(`夹具加载失败：${error.message}`);
  }
});
