import { CuePlayer } from "./player.js";
import { drawTimeline } from "./render.js";
import {
  buildCueModel,
  playbackState,
  toCsv,
  toCueEventsJson,
  toMarkdown
} from "./timeline.js";

const source = "media/stream/demo.m3u8";
const elements = {
  video: document.querySelector("#video"),
  videoShell: document.querySelector("#videoShell"),
  parseStatus: document.querySelector("#parseStatus"),
  playerReady: document.querySelector("#playerReady"),
  playButton: document.querySelector("#playButton"),
  playIcon: document.querySelector("#playIcon"),
  seekBar: document.querySelector("#seekBar"),
  currentTimeCode: document.querySelector("#currentTimeCode"),
  durationCode: document.querySelector("#durationCode"),
  hudFragment: document.querySelector("#hudFragment"),
  videoEvent: document.querySelector("#videoEvent"),
  videoEventLabel: document.querySelector("#videoEventLabel"),
  videoEventValue: document.querySelector("#videoEventValue"),
  phaseCard: document.querySelector("#phaseCard"),
  phaseValue: document.querySelector("#phaseValue"),
  phaseCue: document.querySelector("#phaseCue"),
  phaseCaption: document.querySelector("#phaseCaption"),
  phaseMeter: document.querySelector("#phaseMeter"),
  monitorTime: document.querySelector("#monitorTime"),
  monitorFragment: document.querySelector("#monitorFragment"),
  monitorSegmentStart: document.querySelector("#monitorSegmentStart"),
  monitorElapsed: document.querySelector("#monitorElapsed"),
  readoutTime: document.querySelector("#readoutTime"),
  readoutSegment: document.querySelector("#readoutSegment"),
  readoutReturn: document.querySelector("#readoutReturn"),
  readoutRemaining: document.querySelector("#readoutRemaining"),
  eventLog: document.querySelector("#eventLog"),
  timelineCanvas: document.querySelector("#timelineCanvas"),
  eventTableBody: document.querySelector("#eventTableBody"),
  checkGrid: document.querySelector("#checkGrid"),
  diagnosticList: document.querySelector("#diagnosticList"),
  diagnosticCount: document.querySelector("#diagnosticCount"),
  toast: document.querySelector("#toast")
};

let model;
let player;
let currentTime = 0;
let latestState = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function seconds(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2400);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderSummary() {
  const { summary } = model;
  document.querySelector("#summaryDuration").innerHTML = `${seconds(model.totalDuration)}<span>s</span>`;
  document.querySelector("#summaryCues").textContent = String(summary.cueCount);
  document.querySelector("#summaryAds").innerHTML = `${seconds(summary.adDuration)}<span>s</span>`;
  document.querySelector("#summaryContent").innerHTML = `${seconds(summary.contentDuration)}<span>s</span>`;
  document.querySelector("#summaryHealth").textContent = `${summary.errors} / ${summary.warnings}`;
  document.querySelector("#summaryHealthDetail").textContent =
    `${summary.errors} 错误 · ${summary.warnings} 告警`;
  const healthCard = document.querySelector("#healthCard");
  healthCard.classList.toggle("has-warning", summary.warnings > 0 && summary.errors === 0);
  healthCard.classList.toggle("has-error", summary.errors > 0);
  document.querySelector(".summary-card:nth-child(2) small").textContent =
    `${summary.preRollCount} 前插 · ${summary.midRollCount} 中插`;
  document.querySelector(".summary-card:nth-child(3) small").textContent =
    `${model.cues.reduce((sum, cue) => sum + (cue.declaredDuration || 0), 0).toFixed(2)}s 声明累计`;
  elements.durationCode.textContent = formatClock(model.totalDuration);
  elements.seekBar.max = String(model.totalDuration);
  document.querySelector("#tableFootnote").textContent =
    `${summary.segmentCount} 个分片 · 3.00s 定长`;
}

function renderTable() {
  const kindLabels = { "pre-roll": "前插 PRE", "mid-roll": "中插 MID", "post-roll": "后插 POST" };
  const statusLabels = { ok: "完整插回", warning: "错位告警", error: "解析错误" };
  elements.eventTableBody.innerHTML = model.cues.map(cue => {
    const deltaClass = (cue.durationDelta || 0) < -0.05 ? "delta-negative" : "";
    const delta = cue.durationDelta == null
      ? "—"
      : `${cue.durationDelta > 0 ? "+" : ""}${seconds(cue.durationDelta)}s`;
    const range = `${cue.startSegmentIndex}–${Math.max(cue.startSegmentIndex, cue.returnSegmentIndex - 1)}`;
    return `
      <tr>
        <td>${escapeHtml(cue.id)}</td>
        <td><span class="kind-chip ${cue.kind}">${kindLabels[cue.kind]}</span></td>
        <td class="time-chip">${seconds(cue.start)}s</td>
        <td class="time-chip">${seconds(cue.end)}s</td>
        <td>${seconds(cue.actualDuration)}s</td>
        <td>${cue.declaredDuration == null ? "—" : `${seconds(cue.declaredDuration)}s`}</td>
        <td class="${deltaClass}">${delta}</td>
        <td>#${String(cue.startSegmentIndex).padStart(2, "0")} – #${String(cue.returnSegmentIndex - 1).padStart(2, "0")}</td>
        <td class="return-cell">#${String(cue.returnSegmentIndex).padStart(2, "0")}</td>
        <td><span class="status-chip ${cue.status}">${statusLabels[cue.status]}</span></td>
      </tr>`;
  }).join("");
}

function renderChecks() {
  elements.checkGrid.innerHTML = model.checks.map(check => {
    const mark = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×";
    return `
      <article class="check-card ${check.status}">
        <span class="check-icon">${mark}</span>
        <div>
          <h3>${escapeHtml(check.label)}</h3>
          <p>${escapeHtml(check.detail)}</p>
        </div>
      </article>`;
  }).join("");
}

function renderDiagnostics() {
  elements.diagnosticCount.textContent =
    `${model.summary.errors} ERROR / ${model.summary.warnings} WARNING`;
  elements.diagnosticList.innerHTML = model.diagnostics.length
    ? model.diagnostics.map(item => `
      <div class="diagnostic-item ${item.severity}">
        <span class="severity-code">${item.severity.toUpperCase()}</span>
        <span class="diagnostic-code">${escapeHtml(item.code)}</span>
        <span class="diagnostic-message">${escapeHtml(item.message)}</span>
      </div>`).join("")
    : '<div class="diagnostic-empty">✓ 未发现时长错位、重叠或越界提示。</div>';
}

function renderLog(logs) {
  elements.eventLog.innerHTML = logs.length
    ? logs.map(entry => `
      <li class="${entry.isAd ? "is-ad" : ""}">
        <span>${escapeHtml(entry.label)}</span>
        <span class="log-value">${escapeHtml(entry.value)}</span>
        <i class="log-dot"></i>
      </li>`).join("")
    : '<li class="empty-log">播放或跳转分片后记录媒体时间映射。</li>';
}

function updatePlaybackUi(state) {
  latestState = state;
  currentTime = state.currentTime;
  const fragmentIndex = state.segmentIndex ?? 0;
  const segment = model.segments[fragmentIndex];
  const activeCue = state.cueId ? model.cues.find(cue => cue.id === state.cueId) : null;
  const nextCue = state.nextCue ? model.cues.find(cue => cue.id === state.nextCue.id) : null;
  const isAd = state.phase === "ad";

  elements.playerReady.textContent = state.ready ? "PLAYER READY" : "LOADING";
  elements.playerReady.classList.toggle("ready", state.ready);
  elements.currentTimeCode.textContent = formatClock(state.currentTime);
  elements.seekBar.value = String(state.currentTime);
  elements.seekBar.style.setProperty(
    "--progress",
    `${Math.min(100, (state.currentTime / model.totalDuration) * 100)}%`
  );
  elements.playIcon.textContent = state.paused ? "▶" : "Ⅱ";
  elements.hudFragment.textContent = `FRAG #${String(fragmentIndex).padStart(2, "0")}`;
  elements.videoEvent.classList.toggle("is-ad", isAd);
  elements.videoShell.classList.toggle("is-ad", isAd);

  elements.videoEventLabel.textContent = isAd ? "ACTIVE CUE" : "CURRENT EVENT";
  elements.videoEventValue.textContent = isAd
    ? `${activeCue.id} · AD ${seconds(Math.max(0, activeCue.end - state.currentTime))}s LEFT`
    : "CONTENT";
  elements.phaseCard.classList.toggle("is-ad", isAd);
  elements.phaseCaption.textContent = isAd ? "当前事件状态 / AD" : "当前事件状态 / CONTENT";
  elements.phaseValue.textContent = isAd ? "AD" : "CONTENT";
  if (isAd) {
    elements.phaseCue.textContent =
      `${activeCue.id} · ${seconds(activeCue.start)}–${seconds(activeCue.end)}s · ` +
      `elapsed ${seconds(state.elapsed)}s`;
    elements.phaseMeter.style.width =
      `${Math.min(100, (state.elapsed / Math.max(activeCue.actualDuration, 0.01)) * 100)}%`;
  } else {
    elements.phaseCue.textContent = nextCue
      ? `下一提示 ${nextCue.id} · ${seconds(nextCue.start)}s`
      : state.previousCue
        ? `已插回 ${state.previousCue.id} · #${String(
          model.cues.find(cue => cue.id === state.previousCue.id)?.returnSegmentIndex || 0
        ).padStart(2, "0")}`
        : "内容播放中";
    elements.phaseMeter.style.width = `${(state.currentTime / model.totalDuration) * 100}%`;
  }

  elements.monitorTime.textContent = `${seconds(state.currentTime)}s`;
  elements.monitorFragment.textContent = `#${String(fragmentIndex).padStart(2, "0")}`;
  elements.monitorSegmentStart.textContent = segment ? `${seconds(segment.start)}s` : "—";
  elements.monitorElapsed.textContent = `${seconds(state.elapsed)}s`;
  elements.readoutTime.textContent = `${seconds(state.currentTime)}s`;
  elements.readoutSegment.textContent = `#${String(fragmentIndex).padStart(2, "0")}`;
  elements.readoutReturn.textContent = activeCue
    ? `#${String(activeCue.returnSegmentIndex).padStart(2, "0")} / ${seconds(activeCue.end)}s`
    : nextCue ? `${seconds(nextCue.start)}s` : "—";
  elements.readoutRemaining.textContent = isAd ? `${seconds(state.remaining)}s` : "—";
  if (state.logs) renderLog(state.logs);
  drawTimeline(elements.timelineCanvas, model, state.currentTime);
}

function exportCsv() {
  downloadBlob(new Blob([toCsv(model)], { type: "text/csv;charset=utf-8" }), "cue-events.csv");
  showToast("已导出 cue-events.csv");
}

function exportTimeline() {
  elements.timelineCanvas.toBlob(blob => {
    downloadBlob(blob, "scte35-timeline.png");
    showToast("已导出时间线 PNG");
  }, "image/png");
}

async function downloadExportedScreenshot() {
  try {
    const response = await fetch("artifacts/screenshot.png", { cache: "no-store" });
    if (!response.ok) throw new Error("截图尚未生成");
    downloadBlob(await response.blob(), "scte35-cue-desk.png");
    showToast("已导出全页报告截图");
  } catch (error) {
    showToast(`${error.message}，请运行 npm run export`);
  }
}

function bindEvents() {
  elements.playButton.addEventListener("click", () => {
    if (elements.video.paused) player.play();
    else player.pause();
  });
  elements.seekBar.addEventListener("input", event => {
    currentTime = Number(event.target.value);
    player.seek(currentTime);
  });
  document.querySelector("#jumpCueButton").addEventListener("click", () => {
    const cue = model.cues.find(item => item.kind === "mid-roll");
    player.seek(cue.start + 0.35);
    player.play();
  });
  document.querySelector("#exportCsvButton").addEventListener("click", exportCsv);
  document.querySelector("#exportTimelineButton").addEventListener("click", exportTimeline);
  document.querySelector("#exportAllButton").addEventListener("click", downloadExportedScreenshot);
}

async function boot() {
  const response = await fetch(source, { cache: "no-store" });
  if (!response.ok) throw new Error(`清单加载失败：HTTP ${response.status}`);
  const playlist = await response.text();
  model = buildCueModel(playlist, { source });
  renderSummary();
  renderTable();
  renderChecks();
  renderDiagnostics();
  drawTimeline(elements.timelineCanvas, model, 0);
  bindEvents();

  player = new CuePlayer({
    video: elements.video,
    source,
    model,
    onState: updatePlaybackUi,
    onLog: renderLog,
    onError: error => {
      showToast(`播放器错误：${error.type || "unknown"}`);
      elements.playerReady.textContent = "PLAYER ERROR";
    }
  });

  window.__cueDesk = {
    model,
    player,
    exports: {
      json: () => toCueEventsJson(model),
      csv: () => toCsv(model),
      markdown: () => toMarkdown(model)
    },
    snapshot: () => player.snapshot(),
    seek: time => player.seek(time),
    seekSegment: async index => {
      const segment = model.segments[index];
      await player.seek(segment.start + 0.25);
      return player.snapshot();
    },
    inspectTime: time => {
      const state = playbackState(model, time);
      updatePlaybackUi({
        ...state,
        currentTime: time,
        ready: true,
        paused: true,
        duration: model.totalDuration,
        cueId: state.cue?.id || null,
        segmentIndex: state.segment?.index ?? null,
        logs: player?.logs || []
      });
      return player?.snapshot() || state;
    },
    drawTimeline: time => drawTimeline(elements.timelineCanvas, model, time)
  };
}

boot().catch(error => {
  elements.parseStatus.innerHTML = `<i></i>清单解析失败`;
  showToast(error.message);
  console.error(error);
});
