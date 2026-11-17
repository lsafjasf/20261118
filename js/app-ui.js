/* 渲染：指标时间线、候选证据卡片、阈值扫描表、人工修订区。 */
(function (root) {
  "use strict";

  var VFA = root.VFA;
  var UI = VFA.UI || (VFA.UI = {});
  VFA.UI = UI;

  var COLORS = {
    motion: "#4cc38a",
    frozen: "#ef6f6c",
    noise: "#e8b34b",
    uncertain: "#e8b34b",
    confirmed: "#4cc38a",
    excluded: "#7c8aa5",
    truth: "#8ab4ff"
  };

  function el(id) { return document.getElementById(id); }

  UI.drawTimeline = function () {
    var canvas = el("timeline");
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.parentElement.clientWidth - 36;
    canvas.style.width = cssW + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = 180 * dpr;
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    var W = cssW, H = 180;
    var state = VFA.App.state;
    var dur = state.duration || 1;
    var cfg = state.lastConfig;
    var L = 46, R = 12, T = 10, B = 46;
    var xOf = function (t) { return L + (t / dur) * (W - L - R); };

    ctx.fillStyle = "#1f2a40";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a3752";
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = T + g * (H - T - B) / 4;
      ctx.beginPath(); ctx.moveTo(L, gy); ctx.lineTo(W - R, gy); ctx.stroke();
      ctx.fillStyle = "#93a0b8";
      ctx.font = "10px sans-serif";
      ctx.fillText((2 - g * 0.5).toFixed(1) + "x", 6, gy + 3);
    }

    /* 指标曲线（相对阈值归一，1.0 即阈值线）。 */
    var series = [
      { key: "lumaDiff", th: cfg && cfg.luma, color: "#5aa7ff", name: "亮度差" },
      { key: "edgeDiff", th: cfg && cfg.edge, color: "#c792ea", name: "边缘差" },
      { key: "blockMean", th: cfg && cfg.motion, color: "#7fdbca", name: "局部运动" }
    ];
    var plotH = H - T - B;
    series.forEach(function (s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      state.pairs.forEach(function (p, i) {
        var ratio = s.th ? p[s.key] / s.th : 0;
        var y = T + plotH - Math.min(ratio, 2) / 2 * plotH;
        var x = xOf((p.t0 + p.t1) / 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    /* 阈值参考线。 */
    ctx.strokeStyle = "#93a0b8";
    ctx.setLineDash([4, 4]);
    var thY = T + plotH - plotH / 2;
    ctx.beginPath(); ctx.moveTo(L, thY); ctx.lineTo(W - R, thY); ctx.stroke();
    ctx.setLineDash([]);

    /* 帧对状态带。 */
    var bandY = H - 40, bandH = 8;
    state.result.pairStates.forEach(function (ps) {
      ctx.fillStyle = COLORS[ps.state] || "#888";
      ctx.fillRect(xOf(ps.t0), bandY, Math.max(1, xOf(ps.t1) - xOf(ps.t0)), bandH);
    });

    /* 候选区间带（含人工修订颜色）。 */
    state.merged.forEach(function (c) {
      var color = c.reviewStatus === "confirmed" ? COLORS.confirmed
        : c.reviewStatus === "excluded" ? COLORS.excluded
        : COLORS[c.status];
      ctx.fillStyle = color;
      ctx.fillRect(xOf(c.t0), bandY + 12, xOf(c.t1) - xOf(c.t0), 8);
    });

    /* 真值带。 */
    if (state.groundTruth) {
      state.groundTruth.freezes.forEach(function (gt) {
        ctx.strokeStyle = COLORS.truth;
        ctx.lineWidth = 2;
        ctx.strokeRect(xOf(gt.t0), bandY + 24, xOf(gt.t1) - xOf(gt.t0), 8);
      });
    }

    /* 时间刻度。 */
    ctx.fillStyle = "#93a0b8";
    ctx.font = "10px sans-serif";
    var ticks = Math.min(10, Math.floor(dur));
    for (var ti = 0; ti <= ticks; ti++) {
      var tt = dur * ti / ticks;
      ctx.fillText(VFA.fmtTime(tt), xOf(tt) - 14, H - 8);
    }

    el("timeline-legend").innerHTML =
      legend("#5aa7ff", "亮度差/阈值") +
      legend("#c792ea", "边缘差/阈值") +
      legend("#7fdbca", "局部运动/阈值") +
      legend(COLORS.motion, "运动帧对") +
      legend(COLORS.frozen, "冻结帧对") +
      legend(COLORS.noise, "低光噪声/不确定") +
      (state.groundTruth ? legend(COLORS.truth, "真值区间（描边）") : "");

    canvas.onclick = function (ev) {
      var rect = canvas.getBoundingClientRect();
      var t = (ev.clientX - rect.left - L) / (W - L - R) * dur;
      var video = el("video");
      video.currentTime = VFA.clamp(t, 0, dur);
      video.play().catch(function () {});
    };
  };

  function legend(color, text) {
    return '<span><i style="background:' + color + '"></i>' + text + "</span>";
  }

  UI.statusLabel = function (c) {
    if (c.reviewStatus === "confirmed") return ["confirmed", "人工确认冻结"];
    if (c.reviewStatus === "excluded") return ["excluded", "人工排除"];
    return c.status === "freeze" ? ["freeze", "疑似冻结"] : ["uncertain", "不确定（需人工确认）"];
  };

  UI.renderCandidates = function () {
    var host = el("candidate-list");
    var state = VFA.App.state;
    if (!state.merged.length) {
      host.innerHTML = '<p class="hint">未发现静止/重复区间。</p>';
      return;
    }
    host.innerHTML = state.merged.map(function (c) {
      var tag = UI.statusLabel(c);
      var e = c.evidence;
      return '<div class="card ' + tag[0] + '" data-id="' + c.id + '">' +
        '<div class="card-head"><span class="card-title">' +
        VFA.fmtTime(c.t0) + " – " + VFA.fmtTime(c.t1) +
        "（" + VFA.round2(c.duration) + "s）</span>" +
        '<span class="badge ' + tag[0] + '">' + tag[1] + "</span></div>" +
        '<div class="evidence">' +
        "<span>平均亮度差 <b>" + VFA.round2(e.avgLumaDiff) + "</b></span>" +
        "<span>最大亮度差 <b>" + VFA.round2(e.maxLumaDiff) + "</b></span>" +
        "<span>平均边缘差 <b>" + VFA.round3(e.avgEdgeDiff) + "</b></span>" +
        "<span>平均局部运动 <b>" + VFA.round3(e.avgBlockMotion) + "</b></span>" +
        "<span>最大活动块占比 <b>" + VFA.round2(e.maxBlockFraction) + "</b></span>" +
        "<span>低光帧占比 <b>" + VFA.round2(e.lowlightFraction) + "</b></span>" +
        "<span>噪声帧占比 <b>" + VFA.round2(e.noiseFraction) + "</b></span>" +
        "<span>置信度 <b>" + c.confidence + "</b></span>" +
        "</div>" +
        '<p class="hint">' + c.reason + "</p>" +
        '<div class="card-actions">' +
        '<button data-act="seek" data-id="' + c.id + '">跳到区间起点</button>' +
        '<button data-act="confirm" data-id="' + c.id + '">确认冻结</button>' +
        '<button data-act="exclude" data-id="' + c.id + '">排除（正常静止）</button>' +
        (c.annotation ? '<button data-act="clear" data-id="' + c.id + '">清除人工标注</button>' : "") +
        "</div>" +
        '<textarea class="note-input" placeholder="人工备注（可选）" data-note="' + c.id + '">' +
        (c.annotation ? c.annotation.note.replace(/"/g, "&quot;") : "") +
        "</textarea></div>";
    }).join("");
  };

  UI.renderReview = function () {
    var state = VFA.App.state;
    var host = el("review-list");
    var orphanHtml = state.orphans.length
      ? '<p class="hint">以下人工标注在当前阈值下没有对应候选，已保留且不会被覆盖：</p>' +
        state.orphans.map(function (a) {
          return '<div class="card ' + a.decision + '"><div class="card-head">' +
            '<span class="card-title">' + VFA.fmtTime(a.t0) + " – " + VFA.fmtTime(a.t1) +
            "</span><span class='badge " + a.decision + "'>" +
            (a.decision === "confirmed" ? "人工确认冻结" : "人工排除") + "</span></div>" +
            (a.note ? '<p class="hint">' + a.note + "</p>" : "") +
            '<div class="card-actions"><button data-act="del-orphan" data-id="' +
            a.id + '">删除该孤儿标注</button></div></div>';
        }).join("")
      : '<p class="hint">暂无人工修订。确认/排除操作会在阈值重算后自动保留。</p>';
    host.innerHTML = orphanHtml;
  };

  UI.renderSweep = function (rows, groundTruth) {
    var host = el("sweep-table");
    if (!groundTruth) {
      host.innerHTML = '<p class="hint">未载入真值：仅输出各预设的候选数量与分类，' +
        "载入测试片真值 JSON 后可计算漏检/误报/边界误差。</p>" +
        genericTable(rows);
      return;
    }
    var html = ['<table><thead><tr><th>预设</th><th>阈值(亮/边/动)</th>' +
      "<th>候选</th><th>漏检</th><th>强误报</th><th>不确定候选</th>" +
      "<th>边界误差均值(s)</th><th>最大误差(s)</th><th>容差内</th>" +
      "<th>精确率</th><th>召回率</th></tr></thead><tbody>"];
    rows.forEach(function (row) {
      var m = row.metrics;
      var htmlCell = function (v, cls) {
        return '<td class="' + (cls || "") + '">' + v + "</td>";
      };
      html.push("<tr><td class='left'>" + row.label + "</td><td>" +
        VFA.round2(row.config.luma) + " / " + VFA.round3(row.config.edge) +
        " / " + VFA.round3(row.config.motion) + "</td><td>" +
        row.intervals.length + "</td>" +
        htmlCell(m.misses.length, m.misses.length ? "miss" : "ok") +
        htmlCell(m.strongFalseAlarms.length, m.strongFalseAlarms.length ? "fp" : "ok") +
        "<td>" + m.uncertainCandidates.length + "</td>" +
        "<td>" + VFA.round3(m.boundary.mean) + "</td>" +
        "<td>" + VFA.round3(m.boundary.max) + "</td>" +
        "<td>" + m.withinTolerance + " / " + m.truthCount + "</td>" +
        "<td>" + VFA.round2(m.precision) + "</td>" +
        "<td>" + VFA.round2(m.recall) + "</td></tr>");
    });
    html.push("</tbody></table>");
    host.innerHTML = html.join("");
  };

  function genericTable(rows) {
    var html = ['<table><thead><tr><th>预设</th><th>疑似冻结</th>' +
      "<th>不确定</th><th>低光相关</th></tr></thead><tbody>"];
    rows.forEach(function (row) {
      var freeze = row.intervals.filter(function (c) {
        return c.status === "freeze";
      }).length;
      var uncertain = row.intervals.length - freeze;
      var low = row.intervals.filter(function (c) { return c.lowlight; }).length;
      html.push("<tr><td class='left'>" + row.label + "</td><td>" + freeze +
        "</td><td>" + uncertain + "</td><td>" + low + "</td></tr>");
    });
    html.push("</tbody></table>");
    return html.join("");
  }
})(typeof window !== "undefined" ? window : globalThis);
