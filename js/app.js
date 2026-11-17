/* UI wiring for the Opus packet sequence inspector. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const report = $("report");
  const audio = $("audio");
  const playerBar = $("player-bar");
  const playerLabel = $("player-label");

  const TYPE_LABELS = {
    timestamp_rollback: "时间戳回退",
    timestamp_overlap: "时间戳重叠",
    duplicate_packet: "重复包",
    gap: "丢包空档",
    rate_mismatch: "采样率声明不一致",
    preskip_inconsistent: "预跳不一致",
    invalid_toc: "TOC 非法",
  };
  const SEV_LABELS = { error: "错误", warning: "警告", info: "提示" };

  let result = null;
  let objectUrl = null;
  let stopTimer = null;

  function fmtMs(ms) {
    return (ms / 1000).toFixed(3) + " s";
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        result = OpusInspector.analyze(reader.result);
      } catch (err) {
        alert("解析失败：" + err.message);
        return;
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      audio.src = objectUrl;
      renderAll();
    };
    reader.readAsArrayBuffer(file);
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  function renderAll() {
    report.hidden = false;
    renderSummary();
    renderTrack();
    renderAnomalies();
  }

  function renderSummary() {
    const h = result.header;
    const s = result.stats;
    const items = [
      ["声明输入采样率", h.inputRate + " Hz"],
      ["声道数", h.channels],
      ["预跳样本", `${h.preSkip}（${s.preSkipMs.toFixed(1)} ms）`],
      ["Ogg 页数", result.pageCount],
      ["音频包数", result.audioPacketCount],
      ["总时长", fmtMs(s.totalDurationMs)],
      ["丢包空档数", s.gapCount],
      ["丢失样本", `${s.lostSamples}（约 ${(s.lostSamples / 48).toFixed(1)} ms）`],
      ["异常数", result.anomalies.length],
    ];
    const dl = $("summary-list");
    dl.innerHTML = "";
    for (const [k, v] of items) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = k;
      dd.textContent = v;
      div.append(dt, dd);
      dl.appendChild(div);
    }
  }

  function renderAnomalies() {
    $("anomaly-count").textContent = `（${result.anomalies.length} 条）`;
    const tbody = document.querySelector("#anomaly-table tbody");
    tbody.innerHTML = "";
    if (!result.anomalies.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.id = "empty-anomalies";
      td.colSpan = 6;
      td.textContent = "未发现时间异常。";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const a of result.anomalies) {
      const tr = document.createElement("tr");
      tr.dataset.timeMs = a.timeMs;
      const cells = [
        "#" + a.packetIndex,
        TYPE_LABELS[a.type] || a.type,
        SEV_LABELS[a.severity] || a.severity,
        fmtMs(a.timeMs),
        a.message,
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 2) td.className = "sev-" + a.severity;
        tr.appendChild(td);
      });
      const tdBtn = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "play-btn";
      btn.textContent = "试听";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        audition(a.timeMs, `包 #${a.packetIndex}`);
      });
      tdBtn.appendChild(btn);
      tr.appendChild(tdBtn);
      tr.addEventListener("click", () => {
        selectAnomaly(a);
        audition(a.timeMs, `包 #${a.packetIndex}`);
      });
      tbody.appendChild(tr);
    }
  }

  // ---- packet track ----------------------------------------------------

  const SEV_COLORS = { error: "#ff5d5d", warning: "#ffb84d", info: "#57c7d4" };
  let trackGeom = null;
  let selectedAnomaly = null;

  function computeGeometry() {
    const packets = result.packets;
    const spans = [];
    let maxEnd = 1;
    for (const p of packets) {
      if (p.timeMs === null || !p.parsed) continue;
      const end = p.timeMs;
      const start = Math.max(0, end - p.durationMs);
      spans.push({ packet: p, start, end });
      if (end > maxEnd) maxEnd = end;
    }
    const gaps = [];
    for (let i = 1; i < spans.length; i++) {
      const hole = spans[i].start - spans[i - 1].end;
      if (hole > 0.01) gaps.push({ start: spans[i - 1].end, end: spans[i].start, before: spans[i].packet.index });
    }
    return { spans, gaps, maxEnd };
  }

  function durationColor(ms) {
    const hue = Math.max(0, Math.min(220, 220 - ms * 3));
    return `hsl(${hue}, 55%, 45%)`;
  }

  function renderTrack() {
    const canvas = $("track");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
    const cssHeight = 120;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    trackGeom = computeGeometry();
    const { spans, gaps, maxEnd } = trackGeom;
    const pad = 8;
    const w = cssWidth - pad * 2;
    const x = (ms) => pad + (ms / maxEnd) * w;
    trackGeom.x = x;
    trackGeom.cssWidth = cssWidth;

    const trackTop = 34;
    const trackBottom = cssHeight - 22;
    const trackH = trackBottom - trackTop;

    for (const g of gaps) {
      ctx.fillStyle = "rgba(176, 48, 48, 0.75)";
      const gx = x(g.start);
      ctx.fillRect(gx, trackTop, Math.max(2, x(g.end) - gx), trackH);
    }

    for (const s of spans) {
      const sx = x(s.start);
      const sw = Math.max(1, x(s.end) - sx - 0.5);
      const h = Math.max(6, Math.min(trackH, (s.packet.durationMs / 20) * trackH));
      ctx.fillStyle = durationColor(s.packet.durationMs);
      ctx.fillRect(sx, trackBottom - h, sw, h);
    }

    ctx.fillStyle = "#8b96a6";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const t = (maxEnd / ticks) * i;
      const tx = x(t);
      ctx.fillRect(tx, trackBottom, 1, 4);
      ctx.fillText((t / 1000).toFixed(1) + "s", tx, cssHeight - 8);
    }

    for (const a of result.anomalies) {
      const ax = x(a.timeMs);
      ctx.fillStyle = SEV_COLORS[a.severity] || "#fff";
      ctx.beginPath();
      ctx.moveTo(ax, 14);
      ctx.lineTo(ax - 5, 4);
      ctx.lineTo(ax + 5, 4);
      ctx.closePath();
      ctx.fill();
      if (a === selectedAnomaly) {
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.fillRect(ax - 0.5, 16, 1, trackBottom - 16);
      }
    }

    const legend = $("track-legend");
    legend.innerHTML = "";
    const entries = [
      ["包（色块高度∝时长）", "hsl(160, 55%, 45%)"],
      ["丢包空档", "#b03030"],
      ["错误", SEV_COLORS.error],
      ["警告", SEV_COLORS.warning],
      ["提示", SEV_COLORS.info],
    ];
    for (const [label, color] of entries) {
      const span = document.createElement("span");
      span.style.setProperty("--c", color);
      span.textContent = label;
      legend.appendChild(span);
    }
  }

  function selectAnomaly(a) {
    selectedAnomaly = a;
    renderTrack();
  }

  $("track").addEventListener("click", (e) => {
    if (!result || !trackGeom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    let best = null;
    let bestDist = 12;
    for (const a of result.anomalies) {
      const d = Math.abs(trackGeom.x(a.timeMs) - cx);
      if (d < bestDist && cy < 30) {
        best = a;
        bestDist = d;
      }
    }
    if (best) {
      selectAnomaly(best);
      audition(best.timeMs, `包 #${best.packetIndex}`);
    } else {
      const pad = 8;
      const ms = ((cx - pad) / (trackGeom.cssWidth - pad * 2)) * trackGeom.maxEnd;
      if (ms >= 0) audition(ms, `位置 ${fmtMs(ms)}`);
    }
  });

  window.addEventListener("resize", () => {
    if (result) renderTrack();
  });

  // ---- audition ---------------------------------------------------------

  function audition(timeMs, label) {
    const target = timeMs / 1000;
    const start = Math.max(0, target - 1);
    const stop = target + 1;
    playerBar.hidden = false;
    playerLabel.textContent = `试听 ${label}：${start.toFixed(2)}s → ${stop.toFixed(2)}s`;
    clearTimeout(stopTimer);
    audio.currentTime = start;
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(() => {
        playerLabel.textContent = `无法解码该文件试听（浏览器需支持 Ogg Opus），目标位置 ${target.toFixed(2)}s`;
      });
    }
    const arm = () => {
      const remain = (stop - audio.currentTime) * 1000;
      stopTimer = setTimeout(() => {
        if (audio.currentTime >= stop - 0.05) audio.pause();
        else arm();
      }, Math.max(50, remain));
    };
    arm();
  }

  $("player-stop").addEventListener("click", () => {
    clearTimeout(stopTimer);
    audio.pause();
    playerBar.hidden = true;
  });

  // ---- export -----------------------------------------------------------

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  $("export-csv").addEventListener("click", () => {
    if (!result) return;
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [["packet_index", "type", "severity", "time_ms", "gap_samples", "message"].map(esc).join(",")];
    for (const a of result.anomalies) {
      rows.push([a.packetIndex, a.type, a.severity, a.timeMs.toFixed(1), a.gapSamples || "", a.message].map(esc).join(","));
    }
    download("opus-anomalies.csv", "﻿" + rows.join("\r\n"), "text/csv;charset=utf-8");
  });

  $("export-json").addEventListener("click", () => {
    if (!result) return;
    const payload = {
      header: result.header,
      stats: result.stats,
      anomalyCount: result.anomalies.length,
      anomalies: result.anomalies,
    };
    download("opus-anomalies.json", JSON.stringify(payload, null, 2), "application/json");
  });
})();
