import {
  DEFAULT_TAPS,
  DURATION_SECONDS,
  INPUT_FRAMES,
  OUTPUT_FRAMES,
  OUTPUT_RATE,
  SIGNAL_SEGMENTS,
  TAP_OPTIONS,
  TRANSIENT_TIME,
} from './config.js';
import { generateInputSignal } from './signal.js';
import { encodeFloat32Wav } from './wav.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const COLORS = {
  ink: '#f0f4e9',
  dim: '#aab3a5',
  muted: '#6e786c',
  acid: '#c9ff4a',
  cyan: '#63d8e6',
  amber: '#ffb34d',
  red: '#ff6b5e',
  grid: 'rgba(222, 239, 210, 0.09)',
  gridSoft: 'rgba(222, 239, 210, 0.045)',
};

const state = {
  input: generateInputSignal(),
  taps: readStoredTaps(),
  result: null,
  busy: false,
  waveWindow: 'all',
  audioContext: null,
  playbackSource: null,
  playbackStartedAt: 0,
  renderHistory: new Map(),
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let toastTimer = 0;
let redrawFrame = 0;

function readStoredTaps() {
  try {
    const stored = Number(localStorage.getItem('phase-lock-taps'));
    return TAP_OPTIONS.includes(stored) ? stored : DEFAULT_TAPS;
  } catch {
    return DEFAULT_TAPS;
  }
}

function storeTaps(value) {
  try {
    localStorage.setItem('phase-lock-taps', String(value));
  } catch {
    // Storage is optional for this offline lab.
  }
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatMilliseconds(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return value < 1 ? `${value.toFixed(3)} ms` : `${value.toFixed(1)} ms`;
}

function formatDb(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return value === 0 ? '−∞ dBFS' : '—';
  }
  return `${(20 * Math.log10(value)).toFixed(1)} dBFS`;
}

function formatScientific(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) {
    return '0.00e0';
  }
  const [mantissa, exponent] = value.toExponential(2).split('e');
  const sign = exponent.startsWith('-') ? '−' : '+';
  return `${mantissa.replace('-', '−')}e${sign}${Math.abs(Number(exponent))}`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3600);
}

function setSystemStatus(mode, text) {
  const status = $('#systemStatus');
  status.classList.toggle('is-loading', mode === 'loading');
  status.classList.toggle('is-error', mode === 'error');
  status.querySelector('span').textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  const button = $('#runButton');
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  button.querySelector('.run-label strong').textContent = busy
    ? 'CONVERTING'
    : 'RUN CONVERSION';
  if (busy) {
    $('#runSubtext').textContent = `${state.taps} taps / phase · analysing`;
    setSystemStatus('loading', 'CONVERSION ACTIVE');
  }
}

function requestConversion(reason = 'manual') {
  setBusy(true);
  worker.postMessage({ type: 'convert', tapsPerPhase: state.taps, reason });
}

function applyResult(payload) {
  if (payload.tapsPerPhase !== state.taps) {
    return;
  }

  stopPlayback();
  state.result = payload;
  state.renderHistory.set(payload.tapsPerPhase, {
    renderMs: payload.renderMs,
    totalMs: payload.totalMs,
    peak: payload.comparison?.overall.peak ?? null,
  });
  setBusy(false);
  setSystemStatus(
    payload.referenceStatus === 'ready' ? 'ready' : 'error',
    payload.referenceStatus === 'ready' ? 'REFERENCE ONLINE' : 'REFERENCE MISSING',
  );
  updateReadouts(payload);
  scheduleDraw();

  if (payload.referenceStatus !== 'ready') {
    showToast(`Reference unavailable: ${payload.referenceStatus}`);
  }
}

function updateReadouts(result) {
  const frames = result.outputFrames;
  const duration = frames / result.outputRate;
  const expected = Math.round(INPUT_FRAMES * result.outputRate / 44100);
  const ppm = expected === frames ? 0 : (frames - expected) / expected * 1e6;
  const comparison = result.comparison;
  const realtime = duration / (result.renderMs / 1000);
  const throughput = duration / (result.renderMs / 1000);
  const mflops = frames * result.tapsPerPhase * 2 * 2 / (result.renderMs / 1000) / 1e6;
  const delay = result.groupDelayMs;

  $('#heroOutputCount').textContent = formatInteger(frames);
  $('#heroDuration').textContent = `${duration.toFixed(6)} s`;
  $('#heroClockError').textContent = `${ppm.toFixed(3)} ppm`;
  $('#metricSamples').textContent = formatInteger(frames);
  $('#metricSamplesNote').textContent = expected === frames ? 'exact integer ratio' : 'count mismatch';
  $('#metricGroupDelay').textContent = `${delay.toFixed(3)} ms`;
  $('#metricSkew').textContent = `${result.stereoSkewSamples} samples`;
  $('#metricTime').textContent = formatMilliseconds(result.renderMs);
  $('#metricRealtime').textContent = `${realtime.toFixed(0)}× real-time`;
  $('#metricTime').parentElement.classList.toggle('is-good', realtime > 60);

  if (comparison) {
    $('#metricPeakError').textContent = formatDb(comparison.overall.peak);
    $('#metricPeakErrorNote').textContent = `${formatScientific(comparison.overall.peak)} peak`;
    $('#metricPeakErrorNote').classList.add('is-good');
  } else {
    $('#metricPeakError').textContent = 'N/A';
    $('#metricPeakErrorNote').textContent = 'reference not loaded';
  }

  $('#tapChip').textContent = `${result.tapsPerPhase} TAPS`;
  $('#prototypeLength').textContent = formatInteger(result.prototypeLength);
  $('#runSubtext').textContent = `${result.tapsPerPhase} taps · ${duration.toFixed(2)} s · reference ${result.referenceStatus}`;
  $('#timingMFLOPS').textContent = `${mflops.toFixed(1)} MFLOP/s`;
  $('#timingBar').style.width = `${Math.min(100, result.renderMs)}%`;
  $('#wallTime').textContent = formatMilliseconds(result.renderMs);
  $('#realtimeFactor').textContent = `${realtime.toFixed(0)}×`;
  $('#throughput').textContent = `${throughput.toFixed(0)}× RT`;
  $('#playbackStatus').textContent = `${formatInteger(frames)} frames · ${duration.toFixed(2)} s`;
  $('#delayChip').textContent = `${delay.toFixed(3)} ms`;
  $('#delayValue').textContent = delay.toFixed(3);
  $('#delayAlignment').textContent = 'OFFSET 0.000 SAMPLE';
  $('#delayAlignment').style.color = comparison ? COLORS.acid : COLORS.dim;

  $('#referenceMeta').textContent = `${result.referenceTaps} taps / phase · Float32 · ${formatInteger(result.referenceFrames || frames)} frames`;
  $('#countCheck').textContent = expected === frames ? `PASS · ${formatInteger(frames)}` : `FAIL · ${formatInteger(frames)}`;
  $('#durationCheck').textContent = `${Math.abs(ppm).toFixed(3)} ppm`;
  $('#stereoCheck').textContent = result.stereoSkewSamples === 0
    ? 'PASS · 0 samples'
    : `CHECK · ${result.stereoSkewSamples} samples`;
  updateErrorTable(result);
  updateResidual(result);
}

function statusForPeak(peak) {
  if (peak < 2e-3) {
    return { label: 'PASS', className: 'pill-good' };
  }
  if (peak < 1e-2) {
    return { label: 'WATCH', className: '' };
  }
  return { label: 'HIGH', className: 'pill-lock' };
}

function updateErrorTable(result) {
  const body = $('#errorTableBody');
  const comparison = result.comparison;
  const regionRows = Array.from(body.querySelectorAll('tr')).slice(0, 3);

  if (!comparison) {
    regionRows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      cells[1].textContent = '—';
      cells[2].textContent = '—';
      cells[3].textContent = '—';
      cells[4].innerHTML = '<span class="status-pill">NO REF</span>';
    });
    return;
  }

  comparison.regions.forEach((region, index) => {
    const cells = regionRows[index].querySelectorAll('td');
    const status = statusForPeak(region.peak);
    cells[1].textContent = formatScientific(region.peakLeft);
    cells[2].textContent = formatScientific(region.peakRight);
    cells[3].textContent = `${formatScientific(region.rmsLeft)} / ${formatScientific(region.rmsRight)}`;
    cells[4].innerHTML = `<span class="status-pill ${status.className}">${status.label}</span>`;
  });

  const overall = comparison.overall;
  $('#totalPeakL').textContent = formatScientific(overall.peakLeft);
  $('#totalPeakR').textContent = formatScientific(overall.peakRight);
  $('#totalRms').textContent = `${formatScientific(overall.rmsLeft)} / ${formatScientific(overall.rmsRight)}`;
}

function updateResidual(result) {
  if (!result.residual) {
    $('#residualPeak').textContent = '— peak';
    return;
  }
  $('#residualPeak').textContent = `${formatScientific(result.residual.peak)} peak`;
}

function scheduleDraw() {
  if (redrawFrame) {
    return;
  }
  redrawFrame = requestAnimationFrame(() => {
    redrawFrame = 0;
    drawAll();
  });
}

function drawAll() {
  drawSpectrum();
  drawWaveform();
  drawGroupDelay();
  drawResidual();
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  return { context, width, height };
}

function drawGrid(context, plot, xTicks, yTicks, options = {}) {
  context.save();
  context.lineWidth = 1;
  context.font = '8px "SFMono-Regular", "Cascadia Code", monospace';
  context.textBaseline = 'middle';

  yTicks.forEach((tick) => {
    const y = plot.top + (1 - tick.value) * plot.height;
    context.strokeStyle = tick.emphasis ? COLORS.grid : COLORS.gridSoft;
    context.beginPath();
    context.moveTo(plot.left, y + 0.5);
    context.lineTo(plot.right, y + 0.5);
    context.stroke();
    context.fillStyle = COLORS.muted;
    context.textAlign = 'right';
    context.fillText(tick.label, plot.left - 7, y);
  });

  xTicks.forEach((tick) => {
    const x = plot.left + tick.value * plot.width;
    context.strokeStyle = COLORS.gridSoft;
    context.beginPath();
    context.moveTo(x + 0.5, plot.top);
    context.lineTo(x + 0.5, plot.bottom);
    context.stroke();
  });

  if (options.xLabels) {
    context.textAlign = 'center';
    context.textBaseline = 'top';
    options.xLabels.forEach((tick) => {
      const x = plot.left + tick.value * plot.width;
      context.fillStyle = COLORS.muted;
      context.fillText(tick.label, x, plot.bottom + 7);
    });
  }
  context.restore();
}

function traceSpectrum(context, spectrum, xForFrequency, yForDecibels) {
  const { frequency, decibels } = spectrum;
  context.beginPath();
  for (let index = 0; index < frequency.length; index += 1) {
    const x = xForFrequency(frequency[index]);
    const y = yForDecibels(decibels[index]);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
}

function findSpectrumPeaks(spectrum, count) {
  const candidates = [];
  const { frequency, decibels } = spectrum;
  for (let index = 2; index < decibels.length - 2; index += 1) {
    if (
      decibels[index] > -62
      && decibels[index] >= decibels[index - 1]
      && decibels[index] > decibels[index + 1]
    ) {
      candidates.push({ frequency: frequency[index], db: decibels[index] });
    }
  }

  candidates.sort((a, b) => b.db - a.db);
  const selected = [];
  for (const candidate of candidates) {
    if (!selected.some((peak) => Math.abs(peak.frequency - candidate.frequency) < 180)) {
      selected.push(candidate);
    }
    if (selected.length >= count) {
      break;
    }
  }
  return selected.sort((a, b) => a.frequency - b.frequency);
}

function drawSpectrum() {
  const canvas = $('#spectrumCanvas');
  if (!canvas || !state.result) {
    return;
  }

  const { context, width, height } = prepareCanvas(canvas);
  const plot = { left: 34, right: width - 8, top: 12, bottom: height - 9 };
  plot.width = plot.right - plot.left;
  plot.height = plot.bottom - plot.top;
  const maxFrequency = 24000;
  const maxDb = 4;
  const minDb = -100;
  const xForFrequency = (frequency) => plot.left + frequency / maxFrequency * plot.width;
  const yForDecibels = (decibels) => (
    plot.top + (maxDb - Math.max(minDb, Math.min(maxDb, decibels))) / (maxDb - minDb) * plot.height
  );

  drawGrid(
    context,
    plot,
    [0, 5, 10, 15, 20, 24].map((value) => ({ value: value / 24 })),
    [0, -20, -40, -60, -80, -100].map((db) => ({
      value: (db - minDb) / (maxDb - minDb),
      label: db === 0 ? '0' : String(db),
      emphasis: db === 0 || db === -100,
    })),
  );

  context.save();
  context.beginPath();
  context.rect(plot.left, plot.top, plot.width, plot.height);
  context.clip();

  context.strokeStyle = 'rgba(99, 216, 230, 0.58)';
  context.lineWidth = 1.15;
  traceSpectrum(context, state.result.inputSpectrum, xForFrequency, yForDecibels);
  context.stroke();

  if (state.result.referenceSpectrum) {
    context.save();
    context.setLineDash([3, 4]);
    context.strokeStyle = 'rgba(194, 207, 192, 0.34)';
    context.lineWidth = 1;
    traceSpectrum(context, state.result.referenceSpectrum, xForFrequency, yForDecibels);
    context.stroke();
    context.restore();
  }

  const gradient = context.createLinearGradient(0, plot.top, 0, plot.bottom);
  gradient.addColorStop(0, 'rgba(201, 255, 74, 0.16)');
  gradient.addColorStop(1, 'rgba(201, 255, 74, 0)');
  traceSpectrum(context, state.result.outputSpectrum, xForFrequency, yForDecibels);
  context.lineTo(xForFrequency(state.result.outputSpectrum.frequency.at(-1)), plot.bottom);
  context.lineTo(plot.left, plot.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  traceSpectrum(context, state.result.outputSpectrum, xForFrequency, yForDecibels);
  context.strokeStyle = COLORS.acid;
  context.lineWidth = 1.55;
  context.shadowColor = 'rgba(201, 255, 74, 0.28)';
  context.shadowBlur = 6;
  context.stroke();
  context.shadowBlur = 0;

  context.setLineDash([2, 5]);
  context.strokeStyle = 'rgba(99, 216, 230, 0.34)';
  context.lineWidth = 1;
  const nyquistX = xForFrequency(22050);
  context.beginPath();
  context.moveTo(nyquistX, plot.top);
  context.lineTo(nyquistX, plot.bottom);
  context.stroke();
  context.setLineDash([]);
  context.restore();

  const peaks = findSpectrumPeaks(state.result.outputSpectrum, 4);
  context.save();
  context.font = '8px "SFMono-Regular", "Cascadia Code", monospace';
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  peaks.forEach((peak) => {
    const x = xForFrequency(peak.frequency);
    const y = yForDecibels(peak.db);
    context.strokeStyle = 'rgba(201, 255, 74, 0.4)';
    context.beginPath();
    context.moveTo(x, y - 4);
    context.lineTo(x, y - 10);
    context.stroke();
    context.fillStyle = 'rgba(201, 255, 74, 0.68)';
    const label = peak.frequency >= 1000
      ? `${(peak.frequency / 1000).toFixed(peak.frequency < 10000 ? 2 : 1)}k`
      : `${Math.round(peak.frequency)}`;
    context.fillText(label, x, y - 11);
  });
  context.restore();
}

$('#spectrumCanvas').addEventListener('mousemove', (event) => {
  const canvas = event.currentTarget;
  const result = state.result;
  if (!result) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const plotLeft = 34;
  const plotRight = rect.width - 8;
  const frequency = Math.max(
    0,
    Math.min(24000, (event.clientX - rect.left - plotLeft) / (plotRight - plotLeft) * 24000),
  );
  const spectrum = result.outputSpectrum;
  const bin = Math.min(
    spectrum.frequency.length - 1,
    Math.round(frequency / (spectrum.frequency[1] || 1)),
  );
  const hover = $('#spectrumHover');
  hover.hidden = false;
  hover.style.left = `${Math.min(rect.width - 120, Math.max(8, event.clientX - rect.left + 12))}px`;
  hover.style.right = 'auto';
  $('#spectrumHoverFreq').textContent = frequency >= 1000
    ? `${(frequency / 1000).toFixed(2)} kHz`
    : `${Math.round(frequency)} Hz`;
  $('#spectrumHoverDb').textContent = `${spectrum.decibels[bin].toFixed(1)} dB`;
});

$('#spectrumCanvas').addEventListener('mouseleave', () => {
  $('#spectrumHover').hidden = true;
});

function drawWaveform() {
  const canvas = $('#waveformCanvas');
  if (!canvas) {
    return;
  }
  const { context, width, height } = prepareCanvas(canvas);
  const plot = { left: 2, right: width - 2, top: 12, bottom: height - 10 };
  plot.width = plot.right - plot.left;
  plot.height = plot.bottom - plot.top;

  if (!state.result) {
    context.strokeStyle = COLORS.grid;
    context.beginPath();
    context.moveTo(plot.left, plot.top + plot.height / 2);
    context.lineTo(plot.right, plot.top + plot.height / 2);
    context.stroke();
    return;
  }

  context.save();
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  context.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.width - 1, plot.height - 1);
  context.restore();

  if (state.waveWindow === 'all') {
    drawSegmentBands(context, plot, 0, DURATION_SECONDS);
    drawOverviewRange(context, plot, 0, DURATION_SECONDS);
    positionTransientPin(30);
  } else if (state.waveWindow === 'transient') {
    drawSegmentBands(context, plot, TRANSIENT_TIME - 0.04, TRANSIENT_TIME + 0.04);
    drawRawRange(context, plot, TRANSIENT_TIME - 0.04, TRANSIENT_TIME + 0.04);
    positionTransientPin(50);
  } else {
    const gap = 16;
    const halfWidth = (plot.width - gap) / 2;
    const leftPlot = { ...plot, right: plot.left + halfWidth };
    leftPlot.width = leftPlot.right - leftPlot.left;
    const rightPlot = { ...plot, left: plot.left + halfWidth + gap };
    rightPlot.width = plot.right - rightPlot.left;
    drawSegmentBands(context, leftPlot, 0, 0.1);
    drawSegmentBands(context, rightPlot, 5.9, 6);
    drawRawRange(context, leftPlot, 0, 0.1, 'HEAD');
    drawRawRange(context, rightPlot, 5.9, 6, 'TAIL');
    context.save();
    context.strokeStyle = COLORS.grid;
    context.setLineDash([3, 5]);
    context.beginPath();
    context.moveTo(leftPlot.right + gap / 2, plot.top);
    context.lineTo(leftPlot.right + gap / 2, plot.bottom);
    context.stroke();
    context.restore();
    positionTransientPin(50, true);
  }
}

function drawSegmentBands(context, plot, startTime, endTime) {
  const xForTime = (time) => (
    plot.left + (time - startTime) / (endTime - startTime) * plot.width
  );

  context.save();
  SIGNAL_SEGMENTS.forEach((segment) => {
    const start = Math.max(startTime, segment.start);
    const end = Math.min(endTime, segment.end);
    if (end <= start) {
      return;
    }
    const x = xForTime(start);
    const segmentWidth = xForTime(end) - x;
    if (segment.type === 'silence') {
      context.fillStyle = 'rgba(255, 255, 255, 0.018)';
      context.fillRect(x, plot.top, segmentWidth, plot.height);
    }
    context.strokeStyle = 'rgba(222, 239, 210, 0.095)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + 0.5, plot.top);
    context.lineTo(x + 0.5, plot.bottom);
    context.stroke();
  });

  if (startTime <= TRANSIENT_TIME && endTime >= TRANSIENT_TIME) {
    const center = xForTime(TRANSIENT_TIME);
    const gradient = context.createLinearGradient(center - 22, 0, center + 22, 0);
    gradient.addColorStop(0, 'rgba(255, 179, 77, 0)');
    gradient.addColorStop(0.5, 'rgba(255, 179, 77, 0.11)');
    gradient.addColorStop(1, 'rgba(255, 179, 77, 0)');
    context.fillStyle = gradient;
    context.fillRect(center - 24, plot.top, 48, plot.height);
    context.strokeStyle = 'rgba(255, 179, 77, 0.45)';
    context.beginPath();
    context.moveTo(center + 0.5, plot.top);
    context.lineTo(center + 0.5, plot.bottom);
    context.stroke();
  }
  context.restore();
}

function drawOverviewRange(context, plot, startTime, endTime) {
  const output = state.result;
  const outputStart = Math.floor(startTime * OUTPUT_RATE);
  const outputEnd = Math.min(output.outputLeft.length, Math.ceil(endTime * OUTPUT_RATE));
  const inputStart = Math.floor(startTime * state.input.sampleRate);
  const inputEnd = Math.min(state.input.left.length, Math.ceil(endTime * state.input.sampleRate));
  const columns = Math.max(2, Math.floor(plot.width));
  const center = plot.top + plot.height / 2;
  const amplitude = plot.height * 0.44;
  const leftPeaks = new Float32Array(columns);
  const rightPeaks = new Float32Array(columns);
  const inputPeaks = new Float32Array(columns);

  context.save();
  context.beginPath();
  context.rect(plot.left, plot.top, plot.width, plot.height);
  context.clip();
  context.strokeStyle = 'rgba(222, 239, 210, 0.12)';
  context.beginPath();
  context.moveTo(plot.left, center + 0.5);
  context.lineTo(plot.right, center + 0.5);
  context.stroke();

  for (let column = 0; column < columns; column += 1) {
    const outFirst = outputStart + Math.floor(column * (outputEnd - outputStart) / columns);
    const outLast = outputStart + Math.ceil((column + 1) * (outputEnd - outputStart) / columns);
    const inFirst = inputStart + Math.floor(column * (inputEnd - inputStart) / columns);
    const inLast = inputStart + Math.ceil((column + 1) * (inputEnd - inputStart) / columns);
    let leftMin = 0;
    let leftMax = 0;
    let rightMin = 0;
    let rightMax = 0;
    let inputMax = 0;

    for (let index = outFirst; index < outLast; index += 1) {
      leftMin = Math.min(leftMin, output.outputLeft[index]);
      leftMax = Math.max(leftMax, output.outputLeft[index]);
      rightMin = Math.min(rightMin, output.outputRight[index]);
      rightMax = Math.max(rightMax, output.outputRight[index]);
    }
    for (let index = inFirst; index < inLast; index += 1) {
      inputMax = Math.max(inputMax, Math.abs(state.input.left[index]));
    }

    leftPeaks[column] = Math.max(Math.abs(leftMin), Math.abs(leftMax));
    rightPeaks[column] = Math.max(Math.abs(rightMin), Math.abs(rightMax));
    inputPeaks[column] = inputMax;

    const x = plot.left + column + 0.5;
    context.strokeStyle = 'rgba(201, 255, 74, 0.58)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, center - leftMax * amplitude);
    context.lineTo(x, center - leftMin * amplitude);
    context.stroke();
  }

  drawEnvelopePath(context, plot, rightPeaks, center, amplitude, 'rgba(255, 179, 77, 0.6)', true);
  drawEnvelopePath(context, plot, inputPeaks, center, amplitude, 'rgba(99, 216, 230, 0.3)', false);
  context.restore();
}

function drawEnvelopePath(context, plot, peaks, center, amplitude, color, dashed) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.setLineDash(dashed ? [3, 4] : []);
  context.beginPath();
  peaks.forEach((peak, index) => {
    const x = plot.left + index + 0.5;
    const y = center - peak * amplitude;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();
  context.restore();
}

function drawRawRange(context, plot, startTime, endTime, label = '') {
  const output = state.result;
  const outputStart = Math.floor(startTime * OUTPUT_RATE);
  const outputEnd = Math.min(output.outputLeft.length, Math.ceil(endTime * OUTPUT_RATE));
  const inputStart = Math.floor(startTime * state.input.sampleRate);
  const inputEnd = Math.min(state.input.left.length, Math.ceil(endTime * state.input.sampleRate));
  const center = plot.top + plot.height / 2;
  const amplitude = plot.height * 0.42;
  const xForTime = (time) => (
    plot.left + (time - startTime) / (endTime - startTime) * plot.width
  );

  context.save();
  context.beginPath();
  context.rect(plot.left, plot.top, plot.width, plot.height);
  context.clip();
  context.strokeStyle = 'rgba(222, 239, 210, 0.14)';
  context.beginPath();
  context.moveTo(plot.left, center + 0.5);
  context.lineTo(plot.right, center + 0.5);
  context.stroke();

  context.strokeStyle = 'rgba(99, 216, 230, 0.28)';
  context.lineWidth = 1;
  context.beginPath();
  for (let index = inputStart; index < inputEnd; index += 1) {
    const x = xForTime(index / state.input.sampleRate);
    const y = center - state.input.left[index] * amplitude;
    if (index === inputStart) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();

  context.strokeStyle = COLORS.acid;
  context.lineWidth = 1.6;
  context.shadowColor = 'rgba(201, 255, 74, 0.22)';
  context.shadowBlur = 5;
  context.beginPath();
  for (let index = outputStart; index < outputEnd; index += 1) {
    const x = xForTime(index / OUTPUT_RATE);
    const y = center - output.outputLeft[index] * amplitude;
    if (index === outputStart) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
  context.shadowBlur = 0;

  context.strokeStyle = COLORS.amber;
  context.lineWidth = 1.2;
  context.setLineDash([4, 4]);
  context.beginPath();
  for (let index = outputStart; index < outputEnd; index += 1) {
    const x = xForTime(index / OUTPUT_RATE);
    const y = center - output.outputRight[index] * amplitude;
    if (index === outputStart) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
  context.setLineDash([]);

  if (startTime <= TRANSIENT_TIME && endTime >= TRANSIENT_TIME) {
    const x = xForTime(TRANSIENT_TIME);
    context.strokeStyle = 'rgba(255, 179, 77, 0.72)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, plot.top);
    context.lineTo(x, plot.bottom);
    context.stroke();
  }
  context.restore();

  if (label) {
    context.save();
    context.font = '8px "SFMono-Regular", "Cascadia Code", monospace';
    context.fillStyle = COLORS.muted;
    context.fillText(label, plot.left + 5, plot.top + 10);
    context.restore();
  }
}

function positionTransientPin(percent, hidden = false) {
  const pin = $('#transientPin');
  pin.style.left = `${percent}%`;
  pin.style.display = hidden ? 'none' : 'grid';
  if (state.waveWindow === 'transient') {
    pin.querySelector('span').textContent = 'ALIGNMENT CHECK';
    pin.querySelector('b').textContent = '± 40 ms';
  } else {
    pin.querySelector('span').textContent = 'TRANSIENT';
    pin.querySelector('b').textContent = `${TRANSIENT_TIME.toFixed(3)} s`;
  }
}

function drawGroupDelay() {
  const canvas = $('#delayCanvas');
  if (!canvas) {
    return;
  }
  const { context, width, height } = prepareCanvas(canvas);
  const plot = { left: 30, right: width - 7, top: 10, bottom: height - 16 };
  plot.width = plot.right - plot.left;
  plot.height = plot.bottom - plot.top;

  if (!state.result) {
    return;
  }

  const curve = state.result.groupDelay;
  const maxFrequency = 22050;
  const maxDelay = Math.max(0.1, curve.delayMs * 1.35);
  const xForFrequency = (frequency) => plot.left + frequency / maxFrequency * plot.width;
  const yForDelay = (delay) => plot.bottom - delay / maxDelay * plot.height;

  drawGrid(
    context,
    plot,
    [],
    [0, curve.delayMs / 2, curve.delayMs].map((delay) => ({
      value: delay / maxDelay,
      label: `${delay.toFixed(2)}`,
      emphasis: true,
    })),
  );

  const passbandEndX = xForFrequency(20000);
  context.save();
  context.fillStyle = 'rgba(201, 255, 74, 0.035)';
  context.fillRect(plot.left, plot.top, passbandEndX - plot.left, plot.height);
  const gradient = context.createLinearGradient(0, plot.top, 0, plot.bottom);
  gradient.addColorStop(0, 'rgba(201, 255, 74, 0.18)');
  gradient.addColorStop(1, 'rgba(201, 255, 74, 0)');
  context.beginPath();
  context.moveTo(xForFrequency(curve.frequency[0]), yForDelay(curve.delay[0]));
  for (let index = 1; index < curve.frequency.length; index += 1) {
    context.lineTo(xForFrequency(curve.frequency[index]), yForDelay(curve.delay[index]));
  }
  context.lineTo(xForFrequency(curve.frequency.at(-1)), plot.bottom);
  context.lineTo(xForFrequency(curve.frequency[0]), plot.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  for (let index = 0; index < curve.frequency.length; index += 1) {
    const x = xForFrequency(curve.frequency[index]);
    const y = yForDelay(curve.delay[index]);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle = COLORS.acid;
  context.lineWidth = 1.7;
  context.shadowColor = 'rgba(201, 255, 74, 0.28)';
  context.shadowBlur = 6;
  context.stroke();
  context.shadowBlur = 0;
  context.restore();

  context.save();
  context.strokeStyle = 'rgba(255, 179, 77, 0.32)';
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(passbandEndX, plot.top);
  context.lineTo(passbandEndX, plot.bottom);
  context.stroke();
  context.font = '7px "SFMono-Regular", "Cascadia Code", monospace';
  context.fillStyle = COLORS.muted;
  context.textAlign = 'right';
  context.fillText('20 k', passbandEndX - 4, plot.top + 8);
  context.restore();
}

function drawResidual() {
  const canvas = $('#errorCanvas');
  if (!canvas) {
    return;
  }
  const { context, width, height } = prepareCanvas(canvas);
  const plot = { left: 28, right: width - 2, top: 8, bottom: height - 6 };
  plot.width = plot.right - plot.left;
  plot.height = plot.bottom - plot.top;
  const residual = state.result?.residual;

  if (!residual) {
    context.strokeStyle = COLORS.gridSoft;
    context.beginPath();
    context.moveTo(plot.left, plot.bottom - 0.5);
    context.lineTo(plot.right, plot.bottom - 0.5);
    context.stroke();
    context.font = '8px "SFMono-Regular", "Cascadia Code", monospace';
    context.fillStyle = COLORS.muted;
    context.textAlign = 'center';
    context.fillText('REFERENCE RESIDUAL UNAVAILABLE', width / 2, height / 2);
    return;
  }

  const minDb = -120;
  const maxDb = -20;
  const yForDb = (db) => (
    plot.top + (maxDb - Math.max(minDb, Math.min(maxDb, db))) / (maxDb - minDb) * plot.height
  );

  drawGrid(
    context,
    plot,
    [],
    [-20, -40, -60, -80, -100, -120].map((db) => ({
      value: (db - minDb) / (maxDb - minDb),
      label: String(db),
      emphasis: true,
    })),
  );

  const gradient = context.createLinearGradient(0, plot.top, 0, plot.bottom);
  gradient.addColorStop(0, 'rgba(255, 179, 77, 0.28)');
  gradient.addColorStop(1, 'rgba(255, 179, 77, 0.015)');
  context.beginPath();
  context.moveTo(plot.left, plot.bottom);
  for (let index = 0; index < residual.residual.length; index += 1) {
    const x = plot.left + index / (residual.residual.length - 1) * plot.width;
    context.lineTo(x, yForDb(residual.residual[index]));
  }
  context.lineTo(plot.right, plot.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  for (let index = 0; index < residual.residual.length; index += 1) {
    const x = plot.left + index / (residual.residual.length - 1) * plot.width;
    const y = yForDb(residual.residual[index]);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle = COLORS.amber;
  context.lineWidth = 1.25;
  context.stroke();

  const centerX = plot.left + plot.width / 2;
  context.save();
  context.strokeStyle = 'rgba(255, 179, 77, 0.55)';
  context.setLineDash([2, 4]);
  context.beginPath();
  context.moveTo(centerX, plot.top);
  context.lineTo(centerX, plot.bottom);
  context.stroke();
  context.restore();
}

function updateSelectedTapUI() {
  $$('.tap-button').forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.taps) === state.taps);
  });
}

function updateTimelineLabels() {
  const labels = $$('.timeline-labels span');
  const values = state.waveWindow === 'all'
    ? ['0.00', '1.80', '3.00', '4.50', '6.00 s']
    : state.waveWindow === 'transient'
      ? ['1.760', '1.780', '1.800', '1.820', '1.840 s']
      : ['0.00', 'HEAD', '0.10', 'TAIL', '6.00 s'];
  labels.forEach((label, index) => {
    label.textContent = values[index];
  });
}

function stopPlayback() {
  if (state.playbackSource) {
    state.playbackSource.onended = null;
    try {
      state.playbackSource.stop();
    } catch {
      // The source may have already stopped.
    }
    state.playbackSource.disconnect();
    state.playbackSource = null;
  }
  $('#playIcon').textContent = '▶';
  if (state.result) {
    $('#playbackStatus').textContent = `${formatInteger(state.result.outputFrames)} frames · ${(state.result.outputFrames / OUTPUT_RATE).toFixed(2)} s`;
  }
}

async function togglePlayback() {
  if (!state.result) {
    showToast('Run a conversion before monitoring output.');
    return;
  }
  if (state.playbackSource) {
    stopPlayback();
    return;
  }

  const context = state.audioContext ?? new AudioContext({ sampleRate: OUTPUT_RATE });
  state.audioContext = context;
  if (context.state === 'suspended') {
    await context.resume();
  }

  const buffer = context.createBuffer(2, state.result.outputFrames, OUTPUT_RATE);
  buffer.copyToChannel(state.result.outputLeft, 0);
  buffer.copyToChannel(state.result.outputRight, 1);
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.value = 0.7;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(context.destination);
  source.onended = () => {
    if (state.playbackSource === source) {
      state.playbackSource = null;
      $('#playIcon').textContent = '▶';
      $('#playbackStatus').textContent = `${formatInteger(state.result.outputFrames)} frames · ${(state.result.outputFrames / OUTPUT_RATE).toFixed(2)} s`;
    }
  };
  state.playbackSource = source;
  state.playbackStartedAt = context.currentTime;
  $('#playIcon').textContent = '■';
  $('#playbackStatus').textContent = `PLAYING · ${state.taps} taps · 48 kHz`;
  source.start();
}

function exportWav() {
  if (!state.result) {
    showToast('Run a conversion before exporting.');
    return;
  }
  const wav = encodeFloat32Wav(
    state.result.outputLeft,
    state.result.outputRight,
    OUTPUT_RATE,
  );
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `phase-lock-48k-${state.taps}taps.wav`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${formatInteger(state.result.outputFrames)} stereo frames.`);
}

$$('.tap-button').forEach((button) => {
  button.addEventListener('click', () => {
    const taps = Number(button.dataset.taps);
    if (taps === state.taps) {
      return;
    }
    state.taps = taps;
    storeTaps(taps);
    updateSelectedTapUI();
    requestConversion('filter-length');
  });
});

$('#runButton').addEventListener('click', () => requestConversion('manual'));
$('#playButton').addEventListener('click', togglePlayback);
$('#exportButton').addEventListener('click', exportWav);

$$('.wave-tools .ghost-button').forEach((button) => {
  button.addEventListener('click', () => {
    state.waveWindow = button.dataset.window;
    $$('.wave-tools .ghost-button').forEach((other) => {
      other.classList.toggle('is-active', other === button);
    });
    updateTimelineLabels();
    scheduleDraw();
  });
});

worker.addEventListener('message', (event) => {
  const { type, payload, message } = event.data ?? {};
  if (type === 'result') {
    if (payload.tapsPerPhase !== state.taps) {
      return;
    }
    applyResult(payload);
    $('#footerClock').textContent = `RUN ${payload.tapsPerPhase} TAPS · ${payload.renderMs.toFixed(1)} MS`;
  } else if (type === 'error') {
    setBusy(false);
    setSystemStatus('error', 'CONVERSION ERROR');
    showToast(message || 'Conversion failed.');
  }
});

worker.addEventListener('error', (event) => {
  setBusy(false);
  setSystemStatus('error', 'WORKER OFFLINE');
  showToast(event.message || 'Audio worker failed to start.');
});

window.addEventListener('resize', scheduleDraw);

updateSelectedTapUI();
updateTimelineLabels();
setSystemStatus('loading', 'LOADING REFERENCE');
requestConversion('initial');
