import { Signaling, formatClock, quantile } from "./signal.js";

const $ = (selector) => document.querySelector(selector);
const room = new URLSearchParams(location.search).get("room") || "default";
const signal = new Signaling("receiver", room);
const remoteVideo = $("#remoteVideo");
const SAMPLE_MS = 1000;
const HISTORY_SIZE = 10;
const RECOVERY_SAMPLES = 3;
const LOSS_STREAK = 3;
const INTERVAL_STREAK = 3;
const WARMUP_SAMPLES = 4;

const metricDefinitions = {
  video: [
    { key: "lossPct", label: "区间丢包", unit: "%", digits: 1, threshold: 15 },
    { key: "jitterMs", label: "网络抖动", unit: "ms", digits: 1, threshold: 30 },
    { key: "jitterBufferMs", label: "抖动缓冲延迟", unit: "ms", digits: 0, threshold: 120 },
    { key: "frameIntervalMs", label: "帧到达间隔", unit: "ms", digits: 0, threshold: 90 },
    { key: "decodeMs", label: "解码耗时", unit: "ms", digits: 2, threshold: 25 },
  ],
  audio: [
    { key: "lossPct", label: "区间丢包", unit: "%", digits: 1, threshold: 15 },
    { key: "jitterMs", label: "网络抖动", unit: "ms", digits: 1, threshold: 30 },
    { key: "jitterBufferMs", label: "抖动缓冲延迟", unit: "ms", digits: 0, threshold: 120 },
    { key: "concealmentPct", label: "PLC 隐藏比例", unit: "%", digits: 1, threshold: 1 },
    { key: "decodeMs", label: "解码耗时", unit: "ms", digits: 2, threshold: 25 },
  ],
};

const state = {
  pc: null,
  remoteStream: null,
  pendingCandidates: [],
  previous: { video: null, audio: null },
  history: { video: [], audio: [] },
  health: {
    video: createHealthState(),
    audio: createHealthState(),
  },
  frameTimes: [],
  latest: { video: null, audio: null },
  trackInfo: { video: false, audio: false },
  senderProfileKbps: null,
  startedAt: new Date(),
  timeline: [],
};

function createHealthState() {
  return {
    phase: "waiting",
    incident: null,
    healthyStreak: 0,
    conditions: {
      loss: { count: 0, start: null },
      interval: { count: 0, start: null },
      concealment: { count: 0, start: null },
      buffer: { count: 0, start: null },
    },
  };
}

function metricFormatted(definition, sample) {
  if (!sample) return "—";
  if (definition.key === "resolution") {
    return `${sample.frameWidth || 0}×${sample.frameHeight || 0}`;
  }
  const value = Number(sample[definition.key]);
  return Number.isFinite(value) ? value.toFixed(definition.digits) : "—";
}

function metricNumber(definition, sample) {
  if (!sample) return 0;
  if (definition.key === "resolution") return Number(sample.frameWidth) || 0;
  return Number(sample[definition.key]) || 0;
}

function buildMetricCards() {
  for (const kind of ["video", "audio"]) {
    const container = $(`#${kind}Metrics`);
    for (const definition of metricDefinitions[kind]) {
      const card = document.createElement("article");
      card.className = "metric-card";
      card.dataset.metric = definition.key;
      card.innerHTML = `
        <div class="metric-label">${definition.label}</div>
        <div class="metric-value" data-testid="${kind}-${definition.key}">—</div>
        <svg class="spark" viewBox="0 0 160 44" preserveAspectRatio="none" aria-hidden="true">
          <line class="grid-line" x1="0" y1="30" x2="160" y2="30"></line>
          <line class="grid-line" x1="0" y1="15" x2="160" y2="15"></line>
          <polyline class="series" points=""></polyline>
          <line class="incident-line" x1="0" y1="3" x2="0" y2="42" visibility="hidden"></line>
          <circle class="incident-dot" cx="0" cy="0" r="2.2" visibility="hidden"></circle>
        </svg>
      `;
      container.append(card);
    }
  }
}

function setMetricValue(kind, definition, sample) {
  const value = $(`[data-testid="${kind}-${definition.key}"]`);
  const base = metricFormatted(definition, sample);
  value.textContent = sample ? `${base}${definition.unit ? ` ${definition.unit}` : ""}` : "—";
}

function renderSpark(kind, definition) {
  const card = $(`#${kind}Metrics [data-metric="${definition.key}"]`);
  const samples = state.history[kind];
  const series = card.querySelector(".series");
  const incident = state.health[kind].incident;
  if (!samples.length) {
    series.setAttribute("points", "");
    return;
  }

  const values = samples.map((sample) => metricNumber(definition, sample));
  const maxValue = Math.max(definition.threshold, ...values, 0.0001);
  const minValue = Math.min(0, ...values);
  const span = Math.max(maxValue - minValue, 0.0001);
  const points = values.map((value, index) => {
    const x = samples.length === 1 ? 80 : (index / (HISTORY_SIZE - 1)) * 160;
    const y = 38 - ((value - minValue) / span) * 33;
    return `${x.toFixed(1)},${Math.max(3, Math.min(41, y)).toFixed(1)}`;
  });
  series.setAttribute("points", points.join(" "));

  const incidentLine = card.querySelector(".incident-line");
  const incidentDot = card.querySelector(".incident-dot");
  const incidentTime = incident?.startedAt?.getTime();
  const markerIndex = samples.findIndex((sample) => sample.at.getTime() === incidentTime);
  const hasMarker = markerIndex >= 0;
  incidentLine.setAttribute("visibility", hasMarker ? "visible" : "hidden");
  incidentDot.setAttribute("visibility", hasMarker ? "visible" : "hidden");
  if (hasMarker) {
    const x = (markerIndex / (HISTORY_SIZE - 1)) * 160;
    incidentLine.setAttribute("x1", x.toFixed(1));
    incidentLine.setAttribute("x2", x.toFixed(1));
    const [pointX, pointY] = points[markerIndex].split(",");
    incidentDot.setAttribute("cx", pointX);
    incidentDot.setAttribute("cy", pointY);
  }
}

function renderTrends() {
  for (const kind of ["video", "audio"]) {
    const latest = state.history[kind].at(-1);
    for (const definition of metricDefinitions[kind]) {
      setMetricValue(kind, definition, latest);
      renderSpark(kind, definition);
    }
    const count = state.history[kind].length;
    $(`#${kind}SampleCount`).textContent = `${count} / ${HISTORY_SIZE} 样本`;
  }
}

function findInbound(report, kind) {
  let inbound = null;
  let codec = null;
  report.forEach((item) => {
    if (item.type === "inbound-rtp" && (item.kind === kind || item.mediaType === kind)) {
      inbound = item;
    }
  });
  if (inbound?.codecId) {
    report.forEach((item) => {
      if (item.id === inbound.codecId) codec = item;
    });
  }
  return { inbound, codec };
}

function delta(current, previous, key) {
  if (!previous) return 0;
  const nextValue = Number(current?.[key]);
  const previousValue = Number(previous[key]);
  if (!Number.isFinite(nextValue) || !Number.isFinite(previousValue)) return 0;
  return Math.max(0, nextValue - previousValue);
}

function recentFrameInterval() {
  const cutoff = performance.now() - 1500;
  const recent = state.frameTimes.filter((time) => time >= cutoff);
  if (recent.length < 2) return 0;
  const intervals = [];
  for (let index = 1; index < recent.length; index += 1) {
    intervals.push(recent[index] - recent[index - 1]);
  }
  return quantile(intervals, 0.9);
}

function buildVideoSample(item, previous, elapsedMs, now, codecName) {
  const receivedDelta = delta(item, previous, "packetsReceived");
  const lostDelta = delta(item, previous, "packetsLost");
  const packetsForInterval = receivedDelta + lostDelta;
  const lossPct = packetsForInterval ? (lostDelta / packetsForInterval) * 100 : 0;
  const framesDelta = delta(item, previous, "framesDecoded");
  const decodeDelta = delta(item, previous, "totalDecodeTime");
  const emittedDelta = delta(item, previous, "jitterBufferEmittedCount");
  const bufferDelta = delta(item, previous, "jitterBufferDelay");
  const observedInterval = recentFrameInterval();
  const statsInterval = framesDelta > 0 ? elapsedMs / framesDelta : 0;
  const frameIntervalMs = observedInterval || statsInterval;
  const fps = framesDelta > 0 ? (framesDelta * 1000) / elapsedMs : Number(item.framesPerSecond) || 0;
  const decodeMs = framesDelta > 0 ? (decodeDelta / framesDelta) * 1000 : 0;
  const jitterBufferMs =
    emittedDelta > 0
      ? (bufferDelta / emittedDelta) * 1000
      : Number(item.jitterBufferEmittedCount)
        ? (Number(item.jitterBufferDelay) / Number(item.jitterBufferEmittedCount)) * 1000
        : 0;
  const packetsLost = Number(item.packetsLost) || 0;
  const packetsReceived = Number(item.packetsReceived) || 0;

  return {
    at: now,
    lossPct,
    cumulativeLossPct: packetsLost + packetsReceived ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0,
    lostDelta,
    packetsLost,
    packetsReceived,
    jitterMs: (Number(item.jitter) || 0) * 1000,
    jitterBufferMs,
    jitterBufferDelay: Number(item.jitterBufferDelay) || 0,
    jitterBufferEmittedCount: Number(item.jitterBufferEmittedCount) || 0,
    frameIntervalMs,
    fps,
    framesDelta,
    framesDecoded: Number(item.framesDecoded) || 0,
    frameWidth: Number(item.frameWidth) || 0,
    frameHeight: Number(item.frameHeight) || 0,
    decodeMs,
    totalDecodeTime: Number(item.totalDecodeTime) || 0,
    bytesReceived: Number(item.bytesReceived) || 0,
    freezeCount: Number(item.freezeCount) || 0,
    nackCount: Number(item.nackCount) || 0,
    pliCount: Number(item.pliCount) || 0,
    firCount: Number(item.firCount) || 0,
    codec: codecName || item.codecId || "—",
  };
}

function buildAudioSample(item, previous, elapsedMs, now, codecName) {
  const receivedDelta = delta(item, previous, "packetsReceived");
  const lostDelta = delta(item, previous, "packetsLost");
  const packetsForInterval = receivedDelta + lostDelta;
  const lossPct = packetsForInterval ? (lostDelta / packetsForInterval) * 100 : 0;
  const totalSamplesDelta = delta(item, previous, "totalSamplesReceived");
  const concealedDelta = delta(item, previous, "concealedSamples");
  const concealmentPct = totalSamplesDelta ? (concealedDelta / totalSamplesDelta) * 100 : 0;
  const emittedDelta = delta(item, previous, "jitterBufferEmittedCount");
  const bufferDelta = delta(item, previous, "jitterBufferDelay");
  const decodeDelta = delta(item, previous, "totalDecodeTime");
  const framesDelta = delta(item, previous, "framesDecoded");
  const jitterBufferMs =
    emittedDelta > 0
      ? (bufferDelta / emittedDelta) * 1000
      : Number(item.jitterBufferEmittedCount)
        ? (Number(item.jitterBufferDelay) / Number(item.jitterBufferEmittedCount)) * 1000
        : 0;
  const packetsLost = Number(item.packetsLost) || 0;
  const packetsReceived = Number(item.packetsReceived) || 0;

  return {
    at: now,
    lossPct,
    cumulativeLossPct: packetsLost + packetsReceived ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0,
    lostDelta,
    packetsLost,
    packetsReceived,
    jitterMs: (Number(item.jitter) || 0) * 1000,
    jitterBufferMs,
    jitterBufferDelay: Number(item.jitterBufferDelay) || 0,
    jitterBufferEmittedCount: Number(item.jitterBufferEmittedCount) || 0,
    concealmentPct,
    concealedSamples: Number(item.concealedSamples) || 0,
    totalSamplesReceived: Number(item.totalSamplesReceived) || 0,
    concealmentEvents: Number(item.concealmentEvents) || 0,
    totalDecodeTime: Number(item.totalDecodeTime) || 0,
    decodeMs: framesDelta > 0 ? (decodeDelta / framesDelta) * 1000 : 0,
    framesDecoded: Number(item.framesDecoded) || 0,
    bytesReceived: Number(item.bytesReceived) || 0,
    nackCount: Number(item.nackCount) || 0,
    pliCount: Number(item.pliCount) || 0,
    firCount: Number(item.firCount) || 0,
    codec: codecName || item.codecId || "—",
  };
}

const deltaKeys = [
  "packetsLost",
  "packetsReceived",
  "framesDecoded",
  "jitterBufferDelay",
  "jitterBufferEmittedCount",
  "totalDecodeTime",
  "totalSamplesReceived",
  "concealedSamples",
];

function snapshotForDelta(sample) {
  return Object.fromEntries(deltaKeys.map((key) => [key, Number(sample[key]) || 0]));
}

function updateCondition(condition, active, at) {
  if (active) {
    condition.count += 1;
    if (!condition.start) condition.start = at;
  } else {
    condition.count = 0;
    condition.start = null;
  }
}

function conditionSummary(kind, sample) {
  if (kind === "video") {
    return `丢包 ${sample.lossPct.toFixed(1)}% · 抖动 ${sample.jitterMs.toFixed(1)} ms · 帧间隔 ${sample.frameIntervalMs.toFixed(0)} ms`;
  }
  return `丢包 ${sample.lossPct.toFixed(1)}% · 抖动 ${sample.jitterMs.toFixed(1)} ms · 缓冲 ${sample.jitterBufferMs.toFixed(0)} ms`;
}

function conditionReason(kind, health, sample) {
  const reasons = [];
  const conditions = health.conditions;
  if (conditions.loss.count >= LOSS_STREAK) {
    reasons.push(`连续 ${LOSS_STREAK} 个采样周期出现新增丢包，最近区间丢包 ${sample.lossPct.toFixed(1)}%`);
  }
  if (kind === "video" && conditions.interval.count >= INTERVAL_STREAK) {
    reasons.push(
      `帧到达间隔连续 ${INTERVAL_STREAK} 个采样周期异常，当前 ${sample.frameIntervalMs.toFixed(0)} ms（阈值 90 ms）`,
    );
  }
  if (conditions.buffer.count >= 3) {
    reasons.push(`抖动缓冲延迟持续升高，当前 ${sample.jitterBufferMs.toFixed(0)} ms`);
  }
  if (kind === "audio" && conditions.concealment.count >= 3) {
    reasons.push(`PLC 隐藏比例连续异常，当前 ${sample.concealmentPct.toFixed(1)}%`);
  }
  return reasons.join("；");
}

function updateHealth(kind, sample) {
  const health = state.health[kind];
  if (state.history[kind].length <= WARMUP_SAMPLES) {
    health.phase = "healthy";
    return;
  }
  const at = sample.at;
  updateCondition(health.conditions.loss, sample.lostDelta > 0, at);
  if (kind === "video") {
    updateCondition(health.conditions.interval, sample.frameIntervalMs > 90, at);
  } else {
    updateCondition(health.conditions.concealment, sample.concealmentPct > 1, at);
  }
  updateCondition(
    health.conditions.buffer,
    sample.jitterBufferMs > (kind === "video" ? 250 : 120),
    at,
  );

  const alerting = Object.entries(health.conditions).some(([key, condition]) => {
    if (kind === "video" && key === "interval") return condition.count >= INTERVAL_STREAK;
    if (key === "loss") return condition.count >= LOSS_STREAK;
    return condition.count >= 3;
  });

  if (alerting) {
    if (!health.incident || health.phase === "recovered") {
      const starts = Object.values(health.conditions)
        .filter((condition) => condition.count >= 3)
        .map((condition) => condition.start)
        .filter(Boolean);
      const startedAt = starts.sort((a, b) => a - b)[0] || at;
      health.incident = {
        kind,
        startedAt,
        detectedAt: at,
        recoveredAt: null,
        reason: conditionReason(kind, health, sample),
      };
      addTimeline({
        type: "alert",
        at: startedAt,
        title: `${kind === "video" ? "视频" : "音频"}首次异常`,
        body: `${health.incident.reason}。检测耗时 ${Math.max(0, at - startedAt)} ms。`,
      });
    } else {
      health.incident.reason = conditionReason(kind, health, sample);
    }
    health.phase = "alert";
    health.healthyStreak = 0;
  } else if (health.incident && health.phase === "alert") {
    health.healthyStreak += 1;
    if (health.healthyStreak >= RECOVERY_SAMPLES) {
      health.phase = "recovered";
      health.incident.recoveredAt = at;
      addTimeline({
        type: "recovered",
        at,
        title: `${kind === "video" ? "视频" : "音频"}已恢复`,
        body: `连续 ${RECOVERY_SAMPLES} 个健康样本，指标已回落。本次首次异常保持为 ${formatClock(
          health.incident.startedAt,
        )}。`,
      });
    }
  } else if (!health.incident) {
    health.phase = "healthy";
  }
}

function addTimeline(entry) {
  state.timeline.push(entry);
  if (state.timeline.length > 16) state.timeline.shift();
  renderTimeline();
}

function renderTimeline() {
  const container = $("#timeline");
  container.replaceChildren();
  for (const entry of [...state.timeline].reverse()) {
    const row = document.createElement("div");
    row.className = `timeline-entry ${entry.type}`;
    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    const time = document.createElement("span");
    time.className = "timeline-time";
    time.textContent = formatClock(entry.at);
    const body = document.createElement("div");
    body.className = "timeline-body";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    body.append(title, document.createTextNode(entry.body));
    row.append(dot, time, body);
    container.append(row);
  }
}

function renderQuality(kind) {
  const health = state.health[kind];
  const sample = state.latest[kind];
  const card = $(`#${kind}Quality`);
  const stateElement = $(`#${kind}QualityState`);
  const summary = $(`#${kind}QualitySummary`);
  const subline = $(`#${kind}QualitySubline`);
  const firstAnomaly = $(`#${kind}FirstAnomaly`);
  const detail = $(`#${kind}QualityDetail`);
  const label = kind === "video" ? "视频" : "音频";

  card.classList.toggle("is-alert", health.phase === "alert");
  card.classList.toggle("is-recovered", health.phase === "recovered");

  if (!sample) {
    stateElement.textContent = "WAITING";
    summary.textContent = `等待${label}轨道`;
    subline.textContent = "—";
    firstAnomaly.textContent = "—";
    detail.textContent = `当前尚未触发${label}链路质量问题`;
    return;
  }

  if (health.phase === "alert") {
    stateElement.textContent = kind === "video" ? "VIDEO ALERT" : "AUDIO ALERT";
    summary.textContent = `${label}链路告警`;
    detail.textContent = health.incident?.reason || "检测到持续质量异常";
  } else if (health.phase === "recovered") {
    stateElement.textContent = "RECOVERED";
    summary.textContent = `${label}已恢复`;
    detail.textContent = `指标已回落并连续 ${RECOVERY_SAMPLES} 个样本保持健康；本次首次异常时间保持不变。`;
  } else {
    stateElement.textContent = "HEALTHY";
    summary.textContent = kind === "video" ? "视频链路正常" : "音频链路正常";
    detail.textContent = `当前尚未触发${label}链路质量问题`;
  }
  subline.textContent = conditionSummary(kind, sample);
  firstAnomaly.textContent = health.incident ? formatClock(health.incident.startedAt) : "—";
}

function addStatRow(container, name, value, unit = "") {
  const row = document.createElement("div");
  row.className = "stat-row";
  const nameElement = document.createElement("span");
  nameElement.className = "name";
  nameElement.textContent = name;
  const valueElement = document.createElement("span");
  valueElement.className = "value";
  valueElement.textContent = value;
  if (unit) {
    const unitElement = document.createElement("small");
    unitElement.textContent = ` ${unit}`;
    valueElement.append(unitElement);
  }
  row.append(nameElement, valueElement);
  container.append(row);
}

function renderVideoStats(sample) {
  const container = $("#videoRawStats");
  container.replaceChildren();
  addStatRow(container, "frameWidth", String(sample.frameWidth), "px");
  addStatRow(container, "frameHeight", String(sample.frameHeight), "px");
  addStatRow(container, "packetsReceived", sample.packetsReceived.toLocaleString("en-US"));
  addStatRow(container, "packetsLost", sample.packetsLost.toLocaleString("en-US"));
  addStatRow(container, "jitter", sample.jitterMs.toFixed(2), "ms");
  addStatRow(container, "jitterBufferDelay / emitted", sample.jitterBufferMs.toFixed(1), "ms");
  addStatRow(container, "framesDecoded", sample.framesDecoded.toLocaleString("en-US"));
  addStatRow(container, "framesPerSecond", sample.fps.toFixed(1), "fps");
  addStatRow(container, "frameArrival (derived)", sample.frameIntervalMs.toFixed(1), "ms");
  addStatRow(container, "totalDecodeTime / frame", sample.decodeMs.toFixed(2), "ms");
  addStatRow(container, "intervalLoss", sample.lossPct.toFixed(2), "%");
  addStatRow(container, "cumulativeLoss", sample.cumulativeLossPct.toFixed(3), "%");
  addStatRow(container, "bytesReceived", sample.bytesReceived.toLocaleString("en-US"));
  addStatRow(container, "freezeCount", String(sample.freezeCount));
  addStatRow(container, "nack / pli / fir", `${sample.nackCount} / ${sample.pliCount} / ${sample.firCount}`);
  addStatRow(container, "codec", sample.codec);
  $("#videoStatsTime").textContent = formatClock(sample.at);
}

function renderAudioStats(sample) {
  const container = $("#audioRawStats");
  container.replaceChildren();
  addStatRow(container, "packetsReceived", sample.packetsReceived.toLocaleString("en-US"));
  addStatRow(container, "packetsLost", sample.packetsLost.toLocaleString("en-US"));
  addStatRow(container, "jitter", sample.jitterMs.toFixed(2), "ms");
  addStatRow(container, "jitterBufferDelay / emitted", sample.jitterBufferMs.toFixed(1), "ms");
  addStatRow(container, "totalSamplesReceived", sample.totalSamplesReceived.toLocaleString("en-US"));
  addStatRow(container, "concealedSamples", sample.concealedSamples.toLocaleString("en-US"));
  addStatRow(container, "concealmentEvents", String(sample.concealmentEvents));
  addStatRow(container, "PLC concealment", sample.concealmentPct.toFixed(2), "%");
  addStatRow(container, "totalDecodeTime / frame", sample.decodeMs.toFixed(2), "ms");
  addStatRow(container, "intervalLoss", sample.lossPct.toFixed(2), "%");
  addStatRow(container, "cumulativeLoss", sample.cumulativeLossPct.toFixed(3), "%");
  addStatRow(container, "bytesReceived", sample.bytesReceived.toLocaleString("en-US"));
  addStatRow(container, "nack / pli / fir", `${sample.nackCount} / ${sample.pliCount} / ${sample.firCount}`);
  addStatRow(container, "codec", sample.codec);
  $("#audioStatsTime").textContent = formatClock(sample.at);
}

function renderMediaMeta() {
  const video = state.latest.video;
  if (!video) return;
  $("#stageEmpty").classList.add("hidden");
  $("#receivePill").textContent = "RECEIVING";
  $("#receivePill").className = "pill live";
  $("#streamMeta").textContent = `${video.frameWidth || 640}×${video.frameHeight || 360} · ${video.fps.toFixed(
    0,
  )} FPS · VIDEO + AUDIO`;
  $("#frameClock").textContent = `FRAME ${String(video.framesDecoded).padStart(8, "0")}`;
  $("#trendRecovered").textContent = state.health.video.incident?.recoveredAt
    ? `最近恢复 ${formatClock(state.health.video.incident.recoveredAt)}`
    : "";
}

async function sampleReceiverStats() {
  if (!state.pc || state.pc.connectionState === "closed") return;
  let report;
  try {
    report = await state.pc.getStats();
  } catch {
    return;
  }

  const now = new Date();
  for (const kind of ["video", "audio"]) {
    const { inbound, codec } = findInbound(report, kind);
    if (!inbound) continue;
    const previous = state.previous[kind];
    const elapsedMs = previous ? Math.max(1, now.getTime() - previous.at) : SAMPLE_MS;
    const sample =
      kind === "video"
        ? buildVideoSample(inbound, previous, elapsedMs, now, codec?.mimeType)
        : buildAudioSample(inbound, previous, elapsedMs, now, codec?.mimeType);
    state.previous[kind] = { ...snapshotForDelta(sample), at: now.getTime() };
    state.latest[kind] = sample;
    state.history[kind].push(sample);
    if (state.history[kind].length > HISTORY_SIZE) state.history[kind].shift();
    updateHealth(kind, sample);
  }

  if (state.latest.video) renderVideoStats(state.latest.video);
  if (state.latest.audio) renderAudioStats(state.latest.audio);
  renderTrends();
  renderQuality("video");
  renderQuality("audio");
  renderMediaMeta();
}

function resetReceiverSession() {
  state.previous = { video: null, audio: null };
  state.history = { video: [], audio: [] };
  state.latest = { video: null, audio: null };
  state.frameTimes = [];
  state.health = { video: createHealthState(), audio: createHealthState() };
  $("#videoRawStats").innerHTML = '<div class="raw-empty">等待第一个统计样本</div>';
  $("#audioRawStats").innerHTML = '<div class="raw-empty">等待第一个统计样本</div>';
  renderTrends();
  renderQuality("video");
  renderQuality("audio");
}

function createReceiverPeer() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  state.pc = pc;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signal.send({ type: "candidate", candidate });
  };
  pc.ontrack = (event) => {
    const track = event.track;
    state.trackInfo[track.kind] = true;
    if (event.streams[0]) {
      state.remoteStream = event.streams[0];
    } else {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      state.remoteStream.addTrack(track);
    }
    remoteVideo.srcObject = state.remoteStream;
    remoteVideo.play().catch(() => {});
    $("#stageEmpty").classList.add("hidden");
    $("#receivePill").textContent = "RECEIVING";
    $("#receivePill").className = "pill live";
    if (!state.timeline.some((entry) => entry.title === "媒体已连接")) {
      addTimeline({
        type: "ready",
        at: new Date(),
        title: "媒体已连接",
        body: `已接收${track.kind === "video" ? "视频" : "音频"}轨道，开始每秒采样 getStats。`,
      });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      $("#mediaPill").textContent = "媒体已连接";
      $("#mediaPill").className = "pill live";
    } else if (["failed", "disconnected"].includes(pc.connectionState)) {
      $("#mediaPill").textContent = "媒体重连中";
      $("#mediaPill").className = "pill alert";
    }
  };
  return pc;
}

async function handleOffer(message) {
  resetReceiverSession();
  if (state.pc) state.pc.close();
  const pc = createReceiverPeer();
  await pc.setRemoteDescription(message.sdp);
  for (const candidate of state.pendingCandidates.splice(0)) {
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // Ignore candidates that predate the latest renegotiation.
    }
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal.send({ type: "answer", sdp: pc.localDescription });
}

async function handleSignalMessage(message) {
  if (message.type === "offer") {
    await handleOffer(message);
    return;
  }
  if (message.type === "candidate" && message.candidate) {
    if (state.pc?.remoteDescription) {
      try {
        await state.pc.addIceCandidate(message.candidate);
      } catch {
        // Trickle candidates are best-effort during renegotiation.
      }
    } else {
      state.pendingCandidates.push(message.candidate);
    }
    return;
  }
  if (message.type === "profileChanged") {
    const kbps = Number(message.kbps);
    if (!Number.isFinite(kbps)) return;
    state.senderProfileKbps = kbps;
    addTimeline({
      type: kbps <= 32 ? "alert" : "recovered",
      at: new Date(),
      title: kbps <= 32 ? "发送端注入限速" : "发送端恢复带宽",
      body:
        kbps <= 32
          ? "发送上限已设为 32 kbps，保持分辨率优先；观察视频帧到达间隔是否连续异常。"
          : "发送上限已恢复为 2000 kbps；等待接收端连续健康样本解除告警。",
    });
  }
}

function watchVideoFrames() {
  remoteVideo.requestVideoFrameCallback((now) => {
    state.frameTimes.push(now);
    const cutoff = now - 5000;
    state.frameTimes = state.frameTimes.filter((time) => time >= cutoff);
    watchVideoFrames();
  });
}

signal.addEventListener("status", (event) => {
  const connected = event.detail.state === "open";
  $("#signalPill").textContent = connected ? "信令已连接" : "信令重连中";
  $("#signalPill").className = connected ? "pill live" : "pill alert";
});
signal.addEventListener("message", (event) => {
  handleSignalMessage(event.detail).catch((error) => {
    $("#mediaPill").textContent = `信令错误：${error.message}`;
    $("#mediaPill").className = "pill alert";
  });
});

buildMetricCards();
renderTrends();
renderQuality("video");
renderQuality("audio");
state.timeline.push({
  type: "ready",
  at: state.startedAt,
  title: "接收端已就绪",
  body: "WebSocket 信令正在加入 default 房间，等待发送端 Offer。",
});
renderTimeline();
watchVideoFrames();
signal.connect();
setInterval(sampleReceiverStats, SAMPLE_MS);
setInterval(() => {
  $("#timelineClock").textContent = formatClock();
}, 500);

window.__receiver = {
  getSnapshot: () => ({
    history: state.history,
    health: state.health,
    latest: state.latest,
    senderProfileKbps: state.senderProfileKbps,
    connectionState: state.pc?.connectionState || "new",
  }),
};
