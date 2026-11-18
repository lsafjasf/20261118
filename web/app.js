/* SLATE/SYNC 前端：统一主时钟播放，镜头切换只换视频源，音频不重置。 */
"use strict";

const state = { data: null, selected: null, nudges: {} };

const $ = (id) => document.getElementById(id);
const api = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error((await response.json()).error || "请求失败");
  return response.json();
};
const fmtMs = (value) => `${value >= 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
const fmtTc = (sec) => {
  const total = Math.max(0, sec);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(total % 60)).padStart(2, "0");
  const frame = String(Math.floor((total % 1) * 24)).padStart(2, "0");
  return `${h}:${m}:${s}:${frame}`;
};
const fmtClock = (sec) => {
  const total = Math.max(0, sec);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const whole = String(Math.floor(total % 60)).padStart(2, "0");
  const ms = String(Math.round((total % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${whole}.${ms}`;
};
const toast = (message) => {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.remove("show"), 2600);
};

async function refresh(payload) {
  state.data = payload || await api("/api/state");
  for (const row of state.data.matrix) {
    if (!(row.trackId in state.nudges)) state.nudges[row.trackId] = row.manualNudgeMs;
  }
  if (!state.selected) state.selected = state.data.matrix.find((r) => r.status !== "master")?.trackId;
  renderAll();
}

function renderAll() {
  renderSources();
  renderMatrix();
  renderFineTune();
  renderVerification();
  renderTimeline();
  renderCameraCards();
  $("detect-pct").textContent = "99.6%";
  $("detect-bar").style.width = "99.6%";
}

function renderSources() {
  const list = $("source-list");
  $("source-count").textContent = state.data.tracks.length;
  list.innerHTML = state.data.tracks.map((track) => `
    <div class="source-item ${track.kind}">
      <div class="source-icon">${track.kind === "audio" ? "♪" : "▣"}</div>
      <div class="meta">
        <b>${track.name}</b>
        <p>${track.role} · ${track.duration.toFixed(1)} s</p>
      </div>
      <span class="pill ${track.id === state.data.masterTrackId ? "master" : "ready"}">
        ${track.id === state.data.masterTrackId ? "MASTER" : "READY"}
      </span>
    </div>`).join("");
}

function renderMatrix() {
  const rows = $("matrix-rows");
  rows.innerHTML = state.data.matrix.map((row) => `
    <div class="matrix-row ${row.status} ${row.trackId === state.selected ? "selected" : ""}"
         data-track="${row.trackId}">
      <div class="name"><i></i><div><b>${row.name}</b><br><span class="hint">${row.role}</span></div></div>
      <span class="cell">${row.status === "master" ? "0" : fmtMs(row.autoOffsetMs)}</span>
      <span class="cell">${row.status === "master" ? "—" : fmtMs(row.manualNudgeMs)}</span>
      <span class="cell final">${fmtMs(row.finalOffsetMs)}</span>
    </div>`).join("");
  rows.querySelectorAll(".matrix-row").forEach((node) => {
    node.addEventListener("click", () => {
      if (node.dataset.track === state.data.masterTrackId) return;
      state.selected = node.dataset.track;
      renderMatrix();
      renderFineTune();
      renderCameraCards();
    });
  });
}

function renderFineTune() {
  const row = state.data.matrix.find((r) => r.trackId === state.selected);
  $("fine-target").textContent = row ? row.name : "未选择";
  const nudge = row ? row.manualNudgeMs : 0;
  $("nudge-num").textContent = nudge > 0 ? `+${nudge}` : nudge;
  $("nudge-slider").value = nudge;
  $("nudge-slider").disabled = !row || row.status === "master";
}

function renderVerification() {
  const verification = state.data.verification;
  const badge = $("verify-badge");
  badge.textContent = verification.passed ? "● PASS" : "● FAIL";
  badge.className = `pass-badge ${verification.passed ? "" : "fail"}`;
  $("common-duration").textContent = `${verification.commonDurationSec.toFixed(3)} s`;
  $("v-longest").textContent = `${verification.longestTrackName} ${verification.longestDurationSec}s`;
  $("v-windows").textContent = `${verification.comparedWindows} 个`;
  $("v-max").textContent = `${verification.maxErrorMs} ms`;
  $("v-mean").textContent = `${verification.meanErrorMs} ms`;
  const span = state.data.commonOutSec - state.data.commonInSec;
  $("seg-fill").style.left = "0%";
  $("seg-fill").style.width = "100%";
  $("seg-in").textContent = `${verification.commonInSec.toFixed(3)}s`;
  $("seg-out").textContent = `${verification.commonOutSec.toFixed(3)}s`;
  $("verify-tracks").innerHTML = verification.perTrack.map((item) => `
    <div class="verify-track">
      <span>${item.name} · ${item.comparedWindows} 窗</span>
      <span class="${item.status === "pass" ? "ok" : "bad"}">
        ${item.status.toUpperCase()} · max ${item.maxErrorMs}ms
      </span>
    </div>`).join("");
}

function renderCameraCards() {
  const cameras = state.data.matrix.filter((r) => r.type === "camera");
  $("camera-cards").innerHTML = cameras.map((row, index) => `
    <div class="cam-card ${row.trackId === state.selected ? "active" : ""}" data-track="${row.trackId}">
      <div class="thumb">TAKE 04 · V REF</div>
      <b>${row.name}</b>
      <p>${row.role} · ${fmtMs(row.finalOffsetMs)} ms</p>
    </div>`).join("");
  $("camera-cards").querySelectorAll(".cam-card").forEach((node) => {
    node.addEventListener("click", () => {
      state.selected = node.dataset.track;
      renderMatrix();
      renderFineTune();
      renderCameraCards();
    });
  });
}

function renderTimeline() {
  const timeline = $("timeline");
  const commonIn = state.data.commonInSec;
  const commonOut = state.data.commonOutSec;
  const maxEnd = Math.max(...state.data.matrix.map((r) => r.commonOutMs / 1000));
  const pct = (sec) => `${(sec / maxEnd) * 100}%`;

  const rulerTicks = [];
  for (let t = 0; t <= maxEnd; t += 2) {
    rulerTicks.push(`<span style="left:${pct(t)}">${String(t).padStart(2, "0")}:00</span>`);
  }

  const rows = state.data.matrix.map((row) => {
    const offset = row.finalOffsetMs / 1000;
    const start = offset;
    const width = row.durationMs / 1000;
    const isMaster = row.status === "master";
    const waveBars = Array.from({ length: 48 }, (_, i) => {
      const height = 12 + Math.abs(Math.sin(i * 1.7 + row.trackId.length)) * 78;
      return `<b style="left:${(i / 48) * 100}%;height:${height}%"></b>`;
    }).join("");
    return `
      <div class="tl-row">
        <div class="tl-label">${row.name}</div>
        <div class="tl-track">
          <div class="tl-clip ${isMaster ? "audio" : "video"}"
               style="left:${pct(start)};width:${pct(width)};color:${isMaster ? "var(--lime)" : "var(--orange)"}">
            <div class="tl-wave">${waveBars}</div>
            <span class="clip-tag">${isMaster ? "MASTER · 48k" : "V REF"}</span>
          </div>
        </div>
      </div>`;
  }).join("");

  const programClips = state.data.programSegments.map((segment) => {
    const left = pct(segment.timelineInSec);
    const widthPct = ((segment.timelineOutSec - segment.timelineInSec) / maxEnd) * 100;
    return `<div class="tl-clip program" style="left:${left};width:${widthPct}%">
              <span class="clip-tag">${segment.cameraId.toUpperCase()}</span>
            </div>`;
  }).join("");

  timeline.innerHTML = `
    <div class="tl-ruler">${rulerTicks.join("")}</div>
    <div class="tl-row">
      <div class="tl-label">PROGRAM 成片</div>
      <div class="tl-track">
        ${programClips}
        <div id="playhead" class="tl-playhead" style="left:${pct(commonIn)}"></div>
      </div>
    </div>
    ${rows}`;
}

/* ---------- 统一主时钟播放 ---------- */
const player = {
  playing: false,
  masterStartCtx: 0,
  masterStartSec: 0,
  rafId: null,
  videoCache: {},

  get commonIn() { return state.data.commonInSec; },
  get commonOut() { return state.data.commonOutSec; },
  get duration() { return this.commonOut - this.commonIn; },

  currentSec() {
    if (!this.playing) return this.masterStartSec;
    const audio = $("master-audio");
    return this.commonIn + audio.currentTime;
  },

  cameraAt(masterSec) {
    const cuts = state.data.programCuts;
    let active = cuts[0].cameraId;
    for (const cut of cuts) {
      if (masterSec + 1e-6 >= cut.at) active = cut.cameraId;
    }
    return active;
  },

  videoElement(cameraId) {
    if (!this.videoCache[cameraId]) {
      const track = state.data.tracks.find((t) => t.id === cameraId);
      const video = document.createElement("video");
      video.src = `/${track.videoPath}`;
      video.muted = true;
      video.playsInline = true;
      this.videoCache[cameraId] = video;
    }
    return this.videoCache[cameraId];
  },

  showCamera(cameraId, masterSec) {
    const row = state.data.matrix.find((r) => r.trackId === cameraId);
    const localTime = masterSec - row.finalOffsetMs / 1000;
    const target = this.videoElement(cameraId);
    const holder = $("program-video");
    if (holder.src !== target.src) {
      holder.src = target.src;
    }
    holder.currentTime = Math.max(0, localTime);
    $("program-camera").textContent = row.name;
  },

  async play() {
    const audio = $("master-audio");
    audio.src = `/${state.data.tracks.find((t) => t.id === state.data.masterTrackId).audioPath}`;
    audio.currentTime = this.masterStartSec;
    this.playing = true;
    $("viewer-placeholder").style.display = "none";
    await audio.play();
    this.tick();
    $("btn-play").textContent = "⏸";
  },

  pause() {
    this.playing = false;
    const audio = $("master-audio");
    this.masterStartSec = this.commonIn + audio.currentTime;
    audio.pause();
    cancelAnimationFrame(this.rafId);
    $("btn-play").textContent = "▶";
  },

  tick() {
    const audio = $("master-audio");
    const masterSec = this.commonIn + audio.currentTime;
    if (masterSec >= this.commonOut) {
      this.stop();
      return;
    }
    const camera = this.cameraAt(masterSec);
    const shown = $("program-camera").textContent.toLowerCase().replace(" ", "_");
    if (shown !== camera) {
      // 仅替换画面：音频元素与 currentTime 完全不动，保证声音时间线连续
      this.showCamera(camera, masterSec);
    } else {
      const row = state.data.matrix.find((r) => r.trackId === camera);
      $("program-video").currentTime = masterSec - row.finalOffsetMs / 1000;
    }
    $("clock-main").textContent = fmtClock(masterSec);
    $("viewer-tc").textContent = fmtTc(masterSec);
    const maxEnd = Math.max(...state.data.matrix.map((r) => r.commonOutMs / 1000));
    $("playhead").style.left = `${(masterSec / maxEnd) * 100}%`;
    this.rafId = requestAnimationFrame(() => this.tick());
  },

  stop() {
    this.pause();
    this.masterStartSec = 0;
    const audio = $("master-audio");
    audio.currentTime = 0;
    this.showCamera(this.cameraAt(this.commonIn), this.commonIn);
    $("clock-main").textContent = fmtClock(this.commonIn);
    $("viewer-tc").textContent = fmtTc(this.commonIn);
    const maxEnd = Math.max(...state.data.matrix.map((r) => r.commonOutMs / 1000));
    $("playhead").style.left = `${(this.commonIn / maxEnd) * 100}%`;
  },

  seek(deltaSec) {
    const audio = $("master-audio");
    const wasPlaying = this.playing;
    const target = Math.min(this.duration, Math.max(0,
      (wasPlaying ? audio.currentTime : this.masterStartSec - this.commonIn) + deltaSec));
    audio.currentTime = target;
    this.masterStartSec = this.commonIn + target;
    const masterSec = this.commonIn + target;
    this.showCamera(this.cameraAt(masterSec), masterSec);
  },
};

async function applyNudge(trackId, nudgeMs) {
  const payload = await api("/api/nudge", {
    method: "POST",
    body: JSON.stringify({ trackId, nudgeMs: Number(nudgeMs) }),
  });
  await refresh(payload);
}

function bindEvents() {
  $("btn-play").addEventListener("click", () => {
    player.playing ? player.pause() : player.play();
  });
  document.querySelectorAll(".step").forEach((button) => {
    button.addEventListener("click", () => player.seek(Number(button.dataset.step)));
  });
  $("nudge-slider").addEventListener("change", async (event) => {
    if (!state.selected) return;
    await applyNudge(state.selected, event.target.value);
    toast(`${state.selected} 微调 ${event.target.value} ms 并重新校验`);
  });
  document.querySelectorAll(".nudge-presets button").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state.selected) return;
      const next = Number(button.dataset.nudge);
      await applyNudge(state.selected, next);
      toast(`${state.selected} 微调设为 ${next} ms`);
    });
  });
  $("btn-reset-nudge").addEventListener("click", async () => {
    if (!state.selected) return;
    const payload = await api("/api/reset", {
      method: "POST",
      body: JSON.stringify({ trackId: state.selected }),
    });
    state.nudges[state.selected] = 0;
    await refresh(payload);
    toast(`${state.selected} 微调已归零`);
  });
  $("btn-reanalyze").addEventListener("click", async () => {
    const payload = await api("/api/reanalyze", { method: "POST" });
    state.nudges = {};
    await refresh(payload);
    toast("已重新检测全部起音点并重建统一时间线");
  });
  $("btn-export").addEventListener("click", async () => {
    const result = await api("/api/export");
    toast(`同步矩阵 CSV 已导出 · ${result.tracks} 条轨道 → ${result.csv}`);
  });
}

(async function init() {
  bindEvents();
  await refresh();
  player.showCamera(player.cameraAt(player.commonIn), player.commonIn);
  $("viewer-placeholder").style.display = "none";
})().catch((error) => toast(`初始化失败: ${error.message}`));
