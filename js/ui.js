/* UI 渲染: 指标表 / 时间轴状态带 / RTCP 日志 / 重放历史 */
(function (global) {
  const COLORS = {
    ok: "#3ecf6f", late: "#ff5a5a", reorder: "#ffa63e",
    lost: "#7a4dff", rtcp: "#39c5d8", playout: "#e8ecff",
    grid: "#22304f", text: "#8fa3c8", occupancy: "rgba(98,140,255,0.35)",
  };

  function renderMetricsTable(metrics, bufResults) {
    const tbody = document.querySelector("#metrics-table tbody");
    tbody.innerHTML = "";
    for (const m of metrics) {
      const b = bufResults.find((x) => x.ssrc === m.ssrc);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td class='mono'>0x" + m.ssrc.toString(16) + "</td>" +
        "<td>" + m.received + " / " + m.sentCount + " / " + m.lostCount +
        " (" + m.lossPct.toFixed(1) + "%)</td>" +
        "<td>" + m.jitter.toFixed(2) + "</td>" +
        "<td>" + m.gapCount + " 个 / " + m.gaps.length + " 段</td>" +
        "<td>" + m.reorderCount + "</td>" +
        "<td>" + (b ? b.expiredCount : "-") + "</td>" +
        "<td>" + (b ? b.avgDelay.toFixed(1) : "-") + "</td>" +
        "<td class='" + m.diagClass + "'>" + m.diagnosis + "</td>";
      tbody.appendChild(tr);
    }
  }

  function renderRtcpLog(rtcp) {
    const el = document.getElementById("rtcp-log");
    const lines = rtcp.map((r) => {
      if (r.kind === "SR") {
        return "<span class='sr'>[SR] t=" + r.time.toFixed(0) + "ms ssrc=0x" +
          r.ssrc.toString(16) + " ntp=" + r.ntp.toFixed(0) + " rtp_ts=" + r.rtpTs +
          " sent=" + r.pktCount + " octets=" + r.octets + "</span>";
      }
      return "<span class='rr'>[RR] t=" + r.time.toFixed(0) + "ms ssrc=0x" +
        r.ssrc.toString(16) + " frac_lost=" + (r.fractionLost * 100).toFixed(1) +
        "% cum_lost=" + r.cumLost + " highest_seq=" + r.highestSeq +
        " jitter=" + r.jitter.toFixed(2) + "ms lsr=" + r.lsr + " dlsr=" + r.dlsr + "</span>";
    });
    el.innerHTML = lines.join("\n");
  }

  function drawStreamTimeline(container, stream, metrics, bufResult, rtcp, durationMs) {
    const block = document.createElement("div");
    block.className = "stream-block";
    const title = document.createElement("h3");
    title.textContent = "流 0x" + stream.ssrc.toString(16) +
      "  (收 " + metrics.received + " / 丢 " + metrics.lostCount +
      " / 过期 " + bufResult.expiredCount + " / 平均缓冲 " + bufResult.avgDelay.toFixed(1) + "ms)";
    block.appendChild(title);

    const canvas = document.createElement("canvas");
    const W = Math.max(600, container.clientWidth - 40);
    const H = 110;
    canvas.width = W * (window.devicePixelRatio || 1);
    canvas.height = H * (window.devicePixelRatio || 1);
    canvas.style.height = H + "px";
    block.appendChild(canvas);
    container.appendChild(block);

    const ctx = canvas.getContext("2d");
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const x = (t) => (t / durationMs) * (W - 60) + 40;

    // 网格与秒刻度
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px monospace";
    for (let t = 0; t <= durationMs; t += 1000) {
      ctx.beginPath(); ctx.moveTo(x(t), 0); ctx.lineTo(x(t), H - 14); ctx.stroke();
      ctx.fillText((t / 1000) + "s", x(t) - 6, H - 3);
    }
    // 行分隔: 上=包状态带(0-46), 中=缓冲占用(50-84), 下=播放事件(88-100)
    ctx.fillText("包", 8, 30);
    ctx.fillText("缓冲", 4, 68);
    ctx.fillText("播放", 4, 96);

    // RTCP 标记
    for (const r of rtcp) {
      if (r.ssrc !== stream.ssrc) continue;
      ctx.strokeStyle = COLORS.rtcp;
      ctx.globalAlpha = r.kind === "SR" ? 0.9 : 0.5;
      ctx.beginPath(); ctx.moveTo(x(r.time), 0); ctx.lineTo(x(r.time), 8); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 缓冲占用面积
    if (bufResult.occupancy.length) {
      ctx.fillStyle = COLORS.occupancy;
      ctx.beginPath();
      ctx.moveTo(x(bufResult.occupancy[0].t), 84);
      const maxOcc = Math.max(1, ...bufResult.occupancy.map((o) => o.depth));
      for (const o of bufResult.occupancy) {
        ctx.lineTo(x(o.t), 84 - (o.depth / maxOcc) * 30);
      }
      ctx.lineTo(x(bufResult.occupancy[bufResult.occupancy.length - 1].t), 84);
      ctx.closePath(); ctx.fill();
    }

    // 播放事件
    ctx.fillStyle = COLORS.playout;
    for (const e of bufResult.playoutEvents) {
      ctx.fillRect(x(e.t), 90, 1.5, 8);
    }

    // 包状态带
    for (const p of bufResult.packets) {
      let color = COLORS.ok;
      if (p.status === "expired") color = COLORS.late;
      else if (p.reordered) color = COLORS.reorder;
      ctx.fillStyle = color;
      ctx.fillRect(x(p.arrival) - 1, 14, 2.5, 30);
    }
    // 序列号空洞: 在检测到空洞的到达时刻画紫色竖线
    ctx.strokeStyle = COLORS.lost;
    ctx.lineWidth = 2;
    for (const g of metrics.gaps) {
      ctx.beginPath();
      ctx.moveTo(x(g.atArrival), 12);
      ctx.lineTo(x(g.atArrival), 46);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  function renderTimelines(simResult, metrics, bufResults) {
    const container = document.getElementById("timelines");
    container.innerHTML = "";
    const durationMs = simResult.cfg.duration * 1000;
    for (const s of simResult.streams) {
      const m = metrics.find((x) => x.ssrc === s.ssrc);
      const b = bufResults.find((x) => x.ssrc === s.ssrc);
      drawStreamTimeline(container, s, m, b, simResult.rtcp, durationMs);
    }
  }

  function renderReplayHistory(runs) {
    const el = document.getElementById("replay-history");
    if (!runs.length) { el.innerHTML = ""; return; }
    let html = "<table><thead><tr><th>#</th><th>策略</th><th>深度上限 (ms)</th>" +
      "<th>流</th><th>过期帧</th><th>平均延迟 (ms)</th><th>P95 延迟 (ms)</th></tr></thead><tbody>";
    runs.forEach((run, i) => {
      run.perStream.forEach((b, j) => {
        html += "<tr>" +
          (j === 0 ? "<td rowspan='" + run.perStream.length + "'>" + (i + 1) + "</td>" +
            "<td rowspan='" + run.perStream.length + "'>" + run.strategy + "</td>" +
            "<td rowspan='" + run.perStream.length + "'>" + run.depth + "</td>" : "") +
          "<td class='mono'>0x" + b.ssrc.toString(16) + "</td>" +
          "<td>" + b.expiredCount + "</td>" +
          "<td>" + b.avgDelay.toFixed(1) + "</td>" +
          "<td>" + b.p95Delay.toFixed(1) + "</td></tr>";
      });
    });
    el.innerHTML = html + "</tbody></table>";
  }

  global.JbUI = {
    renderMetricsTable, renderRtcpLog, renderTimelines, renderReplayHistory,
  };
})(typeof window !== "undefined" ? window : globalThis);
