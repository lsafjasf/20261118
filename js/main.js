// UI 装配：数据源切换、故障注入、告警横幅、首升指标表、证据窗口、历史区间。
import { CATEGORY_LABELS } from "./stats-normalize.js";
import { StutterDetector } from "./detector.js";
import { FaultSimulator } from "./simulator.js";
import { LoopbackSource } from "./rtc-source.js";
import { drawChart, drawEvidence } from "./chart.js";

const $ = (id) => document.getElementById(id);
const els = {
  start: $("btn-start"), stop: $("btn-stop"),
  bandwidth: $("btn-bandwidth"), block: $("btn-block"),
  alert: $("alert-banner"), chart: $("chart"),
  verdictBody: document.querySelector("#verdict-table tbody"),
  historyBody: document.querySelector("#history-table tbody"),
  evidenceEmpty: $("evidence-empty"), evidencePanel: $("evidence-panel"),
  evidenceMeta: $("evidence-meta"), evidenceChart: $("evidence-chart"),
};

const DT_MS = 500;
const TAG_CLASS = { network: "tag-net", decode: "tag-decode", jitterBuffer: "tag-jb", render: "tag-render" };
const SCENARIO_NAMES = { bandwidth: "带宽下降", mainthread: "主线程阻塞" };

let detector = null;
let sim = null;
let rtc = null;
let timer = null;
let running = false;
const verdicts = {}; // scenario -> {first, stutterAt, status}

const fmtT = (ms) => (ms / 1000).toFixed(1) + "s";

function tag(category) {
  return `<span class="tag ${TAG_CLASS[category]}">${CATEGORY_LABELS[category]}</span>`;
}

function showAlert(interval) {
  els.alert.classList.remove("hidden");
  els.alert.textContent = `⚠ 卡顿告警：${fmtT(interval.start)} 起检测到画面卡顿，正在采集前后 10 秒证据…`;
}

function hideAlert() {
  els.alert.classList.add("hidden");
}

function onDetectorEvent(evt) {
  if (evt.type === "stutter-start") {
    showAlert(evt.interval);
  } else if (evt.type === "stutter-end") {
    hideAlert(); // 恢复后告警停止
    addHistoryRow(evt.interval); // 历史区间保留
    showEvidence(evt.interval); // 自动展示前后 10 秒证据
    updateVerdicts(evt.interval);
  }
}

function addHistoryRow(iv) {
  const tr = document.createElement("tr");
  const dur = iv.end ? fmtT(iv.end - iv.start) : "-";
  const attr = iv.attribution
    ? `${tag(iv.attribution.category)} 领先卡顿 ${fmtT(iv.attribution.leadMs)}`
    : "-";
  tr.innerHTML = `<td>${iv.id}</td><td>${fmtT(iv.start)}</td>` +
    `<td>${iv.end ? fmtT(iv.end) : "进行中"}</td><td>${dur}</td>` +
    `<td>${attr}</td><td><button data-iv="${iv.id}">查看证据</button></td>`;
  tr.querySelector("button").onclick = () => showEvidence(iv);
  els.historyBody.appendChild(tr);
}

function showEvidence(iv) {
  if (!iv.evidence) return;
  els.evidenceEmpty.classList.add("hidden");
  els.evidencePanel.classList.remove("hidden");
  const attr = iv.attribution ? iv.attribution.label : "未知";
  els.evidenceMeta.textContent =
    `卡顿 #${iv.id}：${fmtT(iv.start)} ~ ${iv.end ? fmtT(iv.end) : "进行中"}，` +
    `归因「${attr}」。证据窗口 ${fmtT(iv.evidence.from)} ~ ${fmtT(iv.evidence.to)}（卡顿点前后各 10 秒）`;
  drawEvidence(els.evidenceChart, iv.evidence, iv);
}

function updateVerdicts(interval) {
  for (const [scenario, v] of Object.entries(verdicts)) {
    if (v.first && !v.stutterAt && interval.start >= v.injectedAt) {
      v.stutterAt = interval.start;
      v.status = "已归因";
    }
  }
  renderVerdicts();
}

function renderVerdicts() {
  els.verdictBody.innerHTML = "";
  for (const [scenario, v] of Object.entries(verdicts)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${SCENARIO_NAMES[scenario]}</td>` +
      `<td>${v.first ? tag(v.first) : "等待中…"}</td>` +
      `<td>${v.stutterAt ? fmtT(v.stutterAt) : "-"}</td>` +
      `<td>${v.status}</td>`;
    els.verdictBody.appendChild(tr);
  }
}

function onSample(sample) {
  detector.push(sample);
  for (const [scenario, v] of Object.entries(verdicts)) {
    if (!v.first && sample.t >= v.injectedAt) {
      const elev = detector.elevations.find((e) => e.start >= v.injectedAt);
      if (elev) {
        v.first = elev.category;
        v.status = "首升已锁定";
        renderVerdicts();
      }
    }
  }
  drawChart(els.chart, detector.history, detector.intervals);
}

function currentSource() {
  return document.querySelector('input[name="source"]:checked').value;
}

async function start() {
  detector = new StutterDetector();
  detector.onEvent = onDetectorEvent;
  els.historyBody.innerHTML = "";
  hideAlert();
  running = true;
  els.start.disabled = true;
  els.stop.disabled = false;
  els.bandwidth.disabled = false;
  els.block.disabled = false;

  if (currentSource() === "sim") {
    sim = new FaultSimulator({ dtMs: DT_MS, seed: 42 });
    timer = setInterval(() => onSample(sim.next()), DT_MS);
  } else {
    rtc = new LoopbackSource({ dtMs: DT_MS });
    await rtc.start(onSample);
  }
}

function stop() {
  running = false;
  clearInterval(timer);
  if (rtc) { rtc.stop(); rtc = null; }
  sim = null;
  if (detector && detector.openInterval) detector.closeInterval(detector.history.at(-1).t);
  els.start.disabled = false;
  els.stop.disabled = true;
  els.bandwidth.disabled = true;
  els.block.disabled = true;
  hideAlert();
}

function inject(kind) {
  if (!running) return;
  verdicts[kind] = { first: null, stutterAt: null, status: "监测中", injectedAt: now() };
  renderVerdicts();
  if (currentSource() === "sim") {
    sim.inject(kind, 20000);
  } else if (kind === "bandwidth") {
    rtc.injectBandwidth(20000);
  } else {
    rtc.injectMainThreadBlock(20000);
  }
}

function now() {
  if (currentSource() === "sim" && sim) return sim.t;
  if (rtc) return rtc.t;
  return 0;
}

els.start.onclick = () => start().catch((e) => {
  els.alert.classList.remove("hidden");
  els.alert.textContent = "启动失败: " + e.message;
  stop();
});
els.stop.onclick = stop;
els.bandwidth.onclick = () => inject("bandwidth");
els.block.onclick = () => inject("mainthread");
