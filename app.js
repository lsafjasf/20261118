import { SCENARIOS, getScenario } from "./src/scenarios.js";
import { solveTimeline } from "./src/solver.js";

const TRACK_TONES = {
  v1: { color: "#52e5d3", label: "V1" },
  v2: { color: "#a896ff", label: "V2" },
  a1: { color: "#ffc466", label: "A1" },
};

const els = {
  scenarioGrid: document.querySelector("#scenarioGrid"),
  caseNote: document.querySelector("#caseNote"),
  trackStack: document.querySelector("#trackStack"),
  ruler: document.querySelector("#ruler"),
  timelineContent: document.querySelector("#timelineContent"),
  timelineSubtitle: document.querySelector("#timelineSubtitle"),
  selectedClip: document.querySelector("#selectedClip"),
  selectedName: document.querySelector("#selectedName"),
  selectedRange: document.querySelector("#selectedRange"),
  selectedTrack: document.querySelector("#selectedTrack"),
  selectedSwatch: document.querySelector("#selectedSwatch"),
  prioritySelector: document.querySelector("#prioritySelector"),
  lockToggle: document.querySelector("#lockToggle"),
  gapRange: document.querySelector("#gapRange"),
  gapOutput: document.querySelector("#gapOutput"),
  headerGap: document.querySelector("#headerGap"),
  globalStatus: document.querySelector("#globalStatus"),
  globalStatusLight: document.querySelector("#globalStatusLight"),
  solverReadout: document.querySelector("#solverReadout"),
  historyList: document.querySelector("#historyList"),
  solveButton: document.querySelector("#solveButton"),
  runAllButton: document.querySelector("#runAllButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  toast: document.querySelector("#toast"),
};

let scenario = getScenario("shift");
let state = scenario.state;
let activeScenarioId = scenario.id;
let selectedId = "intro";
let conflictIds = new Set();
let justMovedIds = new Set();
let logs = [];
let solveSequence = 0;
let drag = null;
let toastTimer = null;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const fmt = (value) => Number(value).toFixed(2);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function getPps() {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--pps"),
  );
  return Number.isFinite(value) ? value : 58;
}

function clipById(id) {
  return state.clips.find((clip) => clip.id === id);
}

function timelineEnd() {
  const latest = state.clips.reduce(
    (end, clip) => Math.max(end, clip.start + clip.duration),
    0,
  );
  return Math.ceil(Math.max(20, latest + 3) / 2) * 2;
}

function formatDelta(move) {
  if (move.fromTrack !== move.toTrack) return `${move.fromTrack.toUpperCase()}→${move.toTrack.toUpperCase()}`;
  const sign = move.delta > 0 ? "+" : "";
  return `${sign}${fmt(move.delta)}s`;
}

function showToast(message, danger = false) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("danger", danger);
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function renderScenarioGrid() {
  els.scenarioGrid.innerHTML = SCENARIOS.map((item) => {
    const active = item.id === activeScenarioId;
    const danger = item.tone === "danger";
    return `
      <button class="scenario-card ${danger ? "danger" : ""} ${active ? "active" : ""}"
        data-scenario="${item.id}" type="button">
        <span class="scenario-number">
          <span>CASE ${item.number}</span>
          <span>${danger ? "NO SOLUTION" : "SOLVABLE"}</span>
        </span>
        <strong>${escapeHtml(item.title)}</strong>
        <span class="scenario-act">${escapeHtml(item.act)}</span>
      </button>
    `;
  }).join("");
}

function renderCaseNote() {
  els.caseNote.classList.toggle("danger", scenario.tone === "danger");
  els.caseNote.innerHTML = `<strong>${escapeHtml(scenario.title)}</strong> · ${escapeHtml(scenario.subtitle)}`;
  els.timelineSubtitle.textContent =
    scenario.id === "shift" ? "同轨互斥 · 跨轨并行" : "无解时拒绝覆盖原布局";
}

function priorityPips(priority) {
  return Array.from(
    { length: 5 },
    (_, index) => `<i class="priority-pip ${index < priority ? "on" : ""}"></i>`,
  ).join("");
}

function renderRuler(end) {
  const pps = getPps();
  const ticks = [];
  for (let time = 0; time <= end + 0.001; time += 0.5) {
    const major = Math.abs(time % 2) < 0.001;
    ticks.push(`<i class="ruler-tick ${major ? "major" : ""}" style="left:${time * pps}px"></i>`);
    if (major) {
      ticks.push(
        `<span class="ruler-label-text" style="left:${time * pps}px">${String(Math.round(time)).padStart(2, "0")}s</span>`,
      );
    }
  }
  els.ruler.style.width = `${end * pps}px`;
  els.ruler.innerHTML = ticks.join("");
}

function renderClip(clip) {
  const pps = getPps();
  const width = clip.duration * pps;
  const classes = [
    "clip",
    clip.tone || "cyan",
    clip.locked ? "locked" : "",
    clip.id === selectedId ? "selected" : "",
    conflictIds.has(clip.id) ? "conflict" : "",
    justMovedIds.has(clip.id) ? "just-moved" : "",
    width < 92 ? "narrow" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const conflictMessage = conflictIds.has(clip.id)
    ? "该片段参与了当前无法满足的约束"
    : "";
  return `
    <div class="${classes}" data-clip-id="${clip.id}" data-track="${clip.track}"
      style="left:${clip.start * pps}px;width:${Math.max(34, width - 2)}px;--clip-color:${TRACK_TONES[clip.track]?.color || "#52e5d3"}"
      title="${escapeHtml(conflictMessage || `${clip.label} · ${fmt(clip.start)}s – ${fmt(clip.start + clip.duration)}s`)}">
      <div class="clip-title-row">
        <span class="clip-title">${escapeHtml(clip.label)}</span>
        ${clip.locked ? '<span class="clip-lock">▣</span>' : ""}
      </div>
      <span class="clip-time">${fmt(clip.start)} – ${fmt(clip.start + clip.duration)}s</span>
      <span class="clip-meta">${priorityPips(clip.priority)}</span>
    </div>
  `;
}

function renderTracks() {
  const pps = getPps();
  const end = timelineEnd();
  const width = end * pps;
  renderRuler(end);

  els.trackStack.innerHTML = state.tracks.map((track) => {
    const tone = TRACK_TONES[track.id] || TRACK_TONES.v1;
    const clips = state.clips.filter((clip) => clip.track === track.id);
    return `
      <div class="track-row" data-track="${track.id}" style="--track-color:${tone.color}">
        <div class="track-label">
          <strong>${track.label}</strong>
          <span>${escapeHtml(track.name)}</span>
        </div>
        <div class="track-lane" data-track="${track.id}"
          style="width:${width}px;background-size:${pps * 2}px 100%,${pps / 2}px 100%">
          ${clips.map(renderClip).join("")}
        </div>
      </div>
    `;
  }).join("");

  els.trackStack.querySelectorAll(".clip").forEach((element) => {
    element.addEventListener("pointerdown", onClipPointerDown);
  });

  window.setTimeout(() => {
    justMovedIds = new Set();
  }, 700);
}

function renderInspector() {
  const clip = clipById(selectedId) || state.clips[0];
  if (!clip) return;
  selectedId = clip.id;
  const tone = TRACK_TONES[clip.track] || TRACK_TONES.v1;

  els.selectedName.textContent = clip.label;
  els.selectedRange.textContent = `${fmt(clip.start)} – ${fmt(clip.start + clip.duration)}s`;
  els.selectedTrack.textContent = clip.track.toUpperCase();
  els.selectedSwatch.style.background = tone.color;
  els.selectedSwatch.style.boxShadow = `0 0 12px ${tone.color}33`;

  els.prioritySelector.innerHTML = [1, 2, 3, 4, 5]
    .map(
      (priority) => `
        <button class="priority-option ${clip.priority === priority ? "active" : ""}"
          data-priority="${priority}" type="button">P${priority}</button>
      `,
    )
    .join("");

  els.lockToggle.setAttribute("aria-checked", String(clip.locked));
  els.lockToggle.querySelector(".switch-text").textContent = clip.locked ? "LOCKED" : "UNLOCKED";

  els.gapRange.value = String(state.minGap);
  els.gapOutput.textContent = `${fmt(state.minGap)}s`;
  els.headerGap.textContent = `${fmt(state.minGap)}s`;
  const percentage = (state.minGap / 1.5) * 100;
  els.gapRange.style.background = `linear-gradient(90deg, var(--cyan) 0 ${percentage}%, #2b3340 ${percentage}% 100%)`;
}

function renderLogEntry(log) {
  const result = log.result;
  const ok = result.ok;
  const summary = result.summary;
  const time = new Date(log.at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const head = `
    <div class="log-top">
      <span class="log-id">#${String(log.number).padStart(2, "0")} · ${time}</span>
      <span class="log-status">${ok ? "APPLIED" : "BLOCKED"}</span>
    </div>
    <p class="log-title">${escapeHtml(log.title)}</p>
  `;

  if (ok) {
    const moves = result.moves.length
      ? result.moves
          .map(
            (move) => `
          <div class="move-row ${move.userMoved ? "user" : ""}">
            <span class="move-name">${escapeHtml(move.label)}</span>
            <span class="move-route">${move.fromTrack.toUpperCase()} ${fmt(move.fromStart)} → ${move.toTrack.toUpperCase()} ${fmt(move.toStart)}</span>
            <span class="move-delta">${formatDelta(move)}</span>
          </div>
        `,
          )
          .join("")
      : '<div class="log-note">约束已满足，无需移动片段。</div>';

    return `
      <article class="log-entry">
        ${head}
        <div class="log-summary">
          <span>解算调整 <b>${summary.adjusted}</b></span>
          <span>总移动 <b>${summary.totalMoved}</b></span>
          <span>保持 <b>${summary.kept}</b></span>
          <span>空隙 <b>${fmt(summary.minGap)}s</b></span>
          <span>触轨 <b>${summary.tracksTouched}</b></span>
        </div>
        <div class="move-list">${moves}</div>
      </article>
    `;
  }

  const conflicts = result.conflicts
    .map((conflict) => {
      const labels = conflict.clips
        .map((id) => log.labels[id] || id)
        .join(" ↔ ");
      return `
        <div class="conflict-row">
          <span class="conflict-ids">${escapeHtml(conflict.clips.join(" / "))}</span>
          <strong>${escapeHtml(labels)}</strong><br />
          ${escapeHtml(conflict.message)}
        </div>
      `;
    })
    .join("");

  return `
    <article class="log-entry danger">
      ${head}
      <div class="log-summary">
        <span>应用移动 <b>0</b></span>
        <span>冲突组 <b>${result.conflicts.length}</b></span>
      </div>
      <div class="conflict-list">${conflicts}</div>
      <p class="log-note">已拒绝本次解算；时间线保持原位置，绝不会以重叠结果覆盖。</p>
    </article>
  `;
}

function renderHistory() {
  if (!logs.length) {
    els.historyList.innerHTML = '<div class="history-empty">拖动片段或点击“重新解算”<br />每次结果都会记录在这里</div>';
    return;
  }
  els.historyList.innerHTML = [...logs]
    .reverse()
    .map(renderLogEntry)
    .join("");
}

function renderStatus(result) {
  const ok = result.ok;
  els.globalStatus.textContent = ok ? "约束满足" : "检测到冲突";
  els.globalStatusLight.classList.toggle("danger", !ok);

  if (ok) {
    els.solverReadout.classList.remove("danger");
    els.solverReadout.innerHTML = `
      <span>SOLVED</span>
      <strong>最少调整 ${result.summary.adjusted} 个 · 总移动 ${result.summary.totalMoved} 个 · 保持 ${result.summary.kept} 个</strong>
    `;
  } else {
    const ids = result.conflicts.flatMap((conflict) => conflict.clips);
    const names = [...new Set(ids)].join(" ↔ ");
    els.solverReadout.classList.add("danger");
    els.solverReadout.innerHTML = `
      <span>BLOCKED</span>
      <strong>冲突：${escapeHtml(names)} · 未应用移动</strong>
    `;
  }
}

function renderAll() {
  renderScenarioGrid();
  renderCaseNote();
  renderTracks();
  renderInspector();
  renderHistory();
}

function applyScenario(id, autoSolve = true) {
  if (drag) {
    drag = null;
    clearDragVisuals();
  }
  scenario = getScenario(id);
  state = scenario.state;
  activeScenarioId = scenario.id;
  selectedId = scenario.request?.draggedId || state.clips[0]?.id;
  conflictIds = new Set();
  justMovedIds = new Set();
  renderAll();
  if (autoSolve) {
    runSolve(scenario.request, { title: scenario.title });
  }
}

function runSolve(request, meta = {}) {
  if (drag) {
    drag = null;
    clearDragVisuals();
  }
  const result = solveTimeline(state, {
    ...(request || {}),
    minGap: state.minGap,
  });
  solveSequence += 1;
  const labels = Object.fromEntries(state.clips.map((clip) => [clip.id, clip.label]));
  const log = {
    number: solveSequence,
    at: Date.now(),
    title: meta.title || (result.ok ? "手动解算" : "约束拒绝"),
    scenarioId: activeScenarioId,
    labels,
    result,
  };

  if (result.ok) {
    state.clips = result.positions;
    state.orders = result.orders;
    state.minGap = result.summary.minGap;
    conflictIds = new Set();
    justMovedIds = new Set(result.moves.map((move) => move.id));
    if (!clipById(selectedId)) selectedId = state.clips[0]?.id;
    showToast(
      result.summary.totalMoved
        ? `解算完成：最少调整 ${result.summary.adjusted} 个片段`
        : "约束已满足，无需移动",
    );
  } else {
    conflictIds = new Set(result.conflicts.flatMap((conflict) => conflict.clips));
    justMovedIds = new Set();
    showToast(`无解：${result.conflicts[0]?.message || "约束冲突"}`, true);
  }

  logs.push(log);
  renderTracks();
  renderInspector();
  renderHistory();
  renderStatus(result);
  return result;
}

function selectClip(id) {
  selectedId = id;
  els.trackStack.querySelectorAll(".clip").forEach((element) => {
    element.classList.toggle("selected", element.dataset.clipId === id);
  });
  renderInspector();
}

function trackAtPoint(clientX, clientY) {
  const lanes = [...els.trackStack.querySelectorAll(".track-lane")];
  const direct = lanes.find((lane) => {
    const rect = lane.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left && clientX <= rect.right;
  });
  if (direct) return direct.dataset.track;
  const nearest = lanes.reduce(
    (best, lane) => {
      const rect = lane.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.bottom) / 2);
      return distance < best.distance ? { track: lane.dataset.track, distance } : best;
    },
    { track: drag?.targetTrack, distance: Number.POSITIVE_INFINITY },
  );
  return nearest.track || drag?.targetTrack || state.tracks[0].id;
}

function snapStart(rawStart, trackId, shiftKey) {
  const clip = clipById(drag.clipId);
  const grid = Math.round(rawStart * 4) / 4;
  if (shiftKey) return Math.max(0, grid);

  const candidates = [0, grid];
  for (const other of state.clips.filter((item) => item.track === trackId && item.id !== clip.id)) {
    candidates.push(other.start + other.duration + state.minGap);
    candidates.push(other.start - state.minGap - clip.duration);
    candidates.push(other.start);
  }

  let best = grid;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate < -0.001) continue;
    const distance = Math.abs(candidate - rawStart);
    if (distance < bestDistance && distance <= 0.42) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return Math.max(0, Math.round(best * 1000) / 1000);
}

function drawGhost() {
  if (!drag) return;
  const pps = getPps();
  const clip = clipById(drag.clipId);
  const lane = [...els.trackStack.querySelectorAll(".track-lane")].find(
    (item) => item.dataset.track === drag.targetTrack,
  );
  if (!lane) return;

  els.trackStack.querySelectorAll(".clip-ghost").forEach((element) => element.remove());
  els.trackStack.querySelectorAll(".track-row").forEach((row) => {
    row.classList.toggle("drop-target", row.dataset.track === drag.targetTrack);
  });

  const ghost = document.createElement("div");
  ghost.className = "clip-ghost";
  ghost.style.left = `${drag.targetStart * pps}px`;
  ghost.style.width = `${Math.max(34, clip.duration * pps - 2)}px`;
  ghost.dataset.time = `${fmt(drag.targetStart)}s · ${drag.targetTrack.toUpperCase()}`;
  lane.appendChild(ghost);
}

function clearDragVisuals() {
  els.trackStack.querySelectorAll(".clip-ghost").forEach((element) => element.remove());
  els.trackStack.querySelectorAll(".track-row").forEach((row) => row.classList.remove("drop-target"));
  els.trackStack.querySelectorAll(".clip.dragging-source").forEach((element) => {
    element.classList.remove("dragging-source");
  });
  document.body.classList.remove("is-dragging");
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
}

function onClipPointerDown(event) {
  if (event.button !== 0) return;
  const element = event.currentTarget;
  const clip = clipById(element.dataset.clipId);
  if (!clip) return;
  event.preventDefault();
  selectClip(clip.id);

  if (clip.locked) {
    showToast(`${clip.label} 已锁定；先解除锁定再拖动。`, true);
    return;
  }

  drag = {
    clipId: clip.id,
    label: clip.label,
    sourceElement: element,
    pointerId: event.pointerId,
    originX: event.clientX,
    originStart: clip.start,
    targetStart: clip.start,
    targetTrack: clip.track,
    moved: false,
  };
  element.setPointerCapture?.(event.pointerId);
  element.classList.add("dragging-source");
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
}

function onDragMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const distance = Math.abs(event.clientX - drag.originX);
  if (!drag.moved && distance < 4) return;
  drag.moved = true;

  const pps = getPps();
  const rawStart = Math.max(0, drag.originStart + (event.clientX - drag.originX) / pps);
  drag.targetTrack = trackAtPoint(event.clientX, event.clientY) || drag.targetTrack;
  drag.targetStart = snapStart(rawStart, drag.targetTrack, event.shiftKey);
  drawGhost();
}

function onDragEnd(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const finished = drag;
  try {
    finished.sourceElement.releasePointerCapture?.(finished.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
  drag = null;
  clearDragVisuals();

  if (!finished.moved) return;
  runSolve(
    {
      draggedId: finished.clipId,
      targetStart: finished.targetStart,
      targetTrack: finished.targetTrack,
    },
    { title: `拖动 ${finished.label}` },
  );
}

function onDragCancel(event) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  drag = null;
  clearDragVisuals();
}

async function runAllCases() {
  els.runAllButton.disabled = true;
  const originalLabel = els.runAllButton.innerHTML;
  els.runAllButton.innerHTML = '<span class="button-icon">◌</span>正在解算 4 个案例';
  logs = [];
  solveSequence = 0;
  renderHistory();

  try {
    for (const item of SCENARIOS) {
      applyScenario(item.id, false);
      runSolve(item.request, { title: item.title });
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    }
    showToast("4 次解算完成，记录已写入右侧日志");
  } finally {
    els.runAllButton.disabled = false;
    els.runAllButton.innerHTML = originalLabel;
  }
}

function updateGap(value) {
  state.minGap = Number(value);
  els.gapOutput.textContent = `${fmt(state.minGap)}s`;
  els.headerGap.textContent = `${fmt(state.minGap)}s`;
  const percentage = (state.minGap / 1.5) * 100;
  els.gapRange.style.background = `linear-gradient(90deg, var(--cyan) 0 ${percentage}%, #2b3340 ${percentage}% 100%)`;
}

function bindEvents() {
  els.scenarioGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-scenario]");
    if (!card) return;
    applyScenario(card.dataset.scenario, true);
  });

  els.prioritySelector.addEventListener("click", (event) => {
    const button = event.target.closest("[data-priority]");
    const clip = clipById(selectedId);
    if (!button || !clip) return;
    clip.priority = Number(button.dataset.priority);
    renderInspector();
    renderTracks();
    showToast(`${clip.label} 优先级设为 P${clip.priority}`);
  });

  els.lockToggle.addEventListener("click", () => {
    const clip = clipById(selectedId);
    if (!clip) return;
    clip.locked = !clip.locked;
    conflictIds.clear();
    renderInspector();
    renderTracks();
    showToast(clip.locked ? `${clip.label} 已锁定` : `${clip.label} 已解锁`);
  });

  els.gapRange.addEventListener("input", (event) => updateGap(event.target.value));
  els.gapRange.addEventListener("change", (event) => {
    updateGap(event.target.value);
    runSolve(null, { title: `最小空隙 ${fmt(state.minGap)}s` });
  });

  els.solveButton.addEventListener("click", () => {
    runSolve(null, { title: scenario.title });
  });
  els.runAllButton.addEventListener("click", runAllCases);
  els.clearLogButton.addEventListener("click", () => {
    logs = [];
    solveSequence = 0;
    renderHistory();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderTracks, 120);
  });
}

renderAll();
bindEvents();
applyScenario("shift", true);
