/* 页面交互：解析输入、渲染摘要、双轨 SVG 与帧详情 */
(function () {
  "use strict";
  var ISSUE_LABELS = {
    "invalid-value": "非法数值",
    "negative-time": "负时间",
    "dts-non-monotonic": "DTS 非单调",
    "duplicate-dts": "DTS 重复",
    "duplicate-pts": "PTS 重复",
    "large-dts-gap": "DTS 间隔过大",
    "large-pts-gap": "PTS 间隔过大"
  };

  var result = null;
  var selected = -1;

  function parseInput(text) {
    var packets = [];
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === "#") return;
      var parts = line.split(/[,\s]+/);
      packets.push({
        dts: parseFloat(parts[0]),
        pts: parseFloat(parts[1])
      });
    });
    return packets;
  }

  function fmt(v) {
    return (typeof v === "number" && isFinite(v)) ? String(v) : "N/A";
  }

  function renderSummary(r) {
    var s = r.summary;
    function card(label, value, cls) {
      return '<div class="card"><div class="label">' + label +
        '</div><div class="value ' + (cls || "") + '">' + value +
        "</div></div>";
    }
    var html =
      card("包数量", s.packetCount) +
      card("重排窗口长度", r.reorderWindow,
        r.reorderWindow > 1 ? "" : "good") +
      card("首个非法时间戳包索引",
        r.firstInvalidIndex < 0 ? "无" : "#" + r.firstInvalidIndex,
        r.firstInvalidIndex < 0 ? "good" : "bad") +
      card("解码顺序(DTS)", r.decodeOrderOk ? "单调 ✓" : "回退 ✗",
        r.decodeOrderOk ? "good" : "bad") +
      card("展示顺序(PTS)", r.presentationOrderOk ? "递增 ✓" : "异常 ✗",
        r.presentationOrderOk ? "good" : "bad") +
      card("负时间帧", s.negativeCount, s.negativeCount ? "bad" : "good") +
      card("重复时间戳", s.duplicateCount, s.duplicateCount ? "bad" : "good") +
      card("过大间隔", s.largeGapCount, s.largeGapCount ? "bad" : "good") +
      card("依赖后续参考帧", s.futureRefCount, "");
    document.getElementById("summary").innerHTML = html;
  }
  function frameColor(f) {
    if (f.index === selected) return "#ffd43b";
    if (f.issues.length) return "#ff6b6b";
    if (f.reordered) return "#9775fa";
    return "#4c6ef5";
  }

  function renderTracks(r) {
    var frames = r.frames;
    var wrap = document.getElementById("trackWrap");
    if (!frames.length) { wrap.innerHTML = ""; return; }

    var W = Math.max(720, frames.length * 56);
    var H = 220, yDts = 60, yPts = 170, pad = 50;
    var min = Infinity, max = -Infinity;
    frames.forEach(function (f) {
      [f.dts, f.pts].forEach(function (v) {
        if (typeof v === "number" && isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      });
    });
    if (!isFinite(min)) { min = 0; max = 1; }
    if (max === min) max = min + 1;
    function x(v) {
      return pad + (v - min) / (max - min) * (W - 2 * pad);
    }

    var svg = ['<svg width="' + W + '" height="' + H +
      '" xmlns="http://www.w3.org/2000/svg">'];
    svg.push('<text class="lane-label" x="6" y="' + (yDts + 4) +
      '">DTS 解码顺序</text>');
    svg.push('<text class="lane-label" x="6" y="' + (yPts + 4) +
      '">PTS 展示顺序</text>');
    svg.push('<line x1="' + pad + '" y1="' + yDts + '" x2="' + (W - pad) +
      '" y2="' + yDts + '" stroke="#2a3550"/>');
    svg.push('<line x1="' + pad + '" y1="' + yPts + '" x2="' + (W - pad) +
      '" y2="' + yPts + '" stroke="#2a3550"/>');

    // 同一帧在两条轨道间的连线（体现重排）
    frames.forEach(function (f) {
      if (!isFinite(f.dts) || !isFinite(f.pts)) return;
      svg.push('<line x1="' + x(f.dts) + '" y1="' + yDts +
        '" x2="' + x(f.pts) + '" y2="' + yPts +
        '" stroke="' + (f.index === selected ? "#ffd43b" : "#3a4a75") +
        '" stroke-width="' + (f.index === selected ? 2 : 1) + '"/>');
    });

    // 帧节点：上轨按 DTS、下轨按 PTS 定位，标注包索引
    frames.forEach(function (f) {
      var color = frameColor(f);
      if (isFinite(f.dts)) {
        svg.push('<g class="frame" data-i="' + f.index + '">' +
          '<circle cx="' + x(f.dts) + '" cy="' + yDts + '" r="9" fill="' +
          color + '"/>' +
          '<text x="' + x(f.dts) + '" y="' + (yDts - 14) +
          '" text-anchor="middle">#' + f.index + "</text></g>");
      }
      if (isFinite(f.pts)) {
        svg.push('<g class="frame" data-i="' + f.index + '">' +
          '<circle cx="' + x(f.pts) + '" cy="' + yPts + '" r="9" fill="' +
          color + '"/>' +
          '<text x="' + x(f.pts) + '" y="' + (yPts + 24) +
          '" text-anchor="middle">#' + f.index + "</text></g>");
      }
    });
    svg.push("</svg>");
    wrap.innerHTML = svg.join("");

    wrap.querySelectorAll(".frame").forEach(function (el) {
      el.addEventListener("click", function () {
        selected = parseInt(el.getAttribute("data-i"), 10);
        renderTracks(result);
        renderDetail(result);
      });
    });
  }

  function renderDetail(r) {
    var box = document.getElementById("detail");
    var f = r.frames[selected];
    if (!f) {
      box.innerHTML = "<h2>帧详情</h2>" +
        '<p class="hint">点击轨道中的帧查看其参考帧依赖。</p>';
      return;
    }
    var rows = [
      ["包索引（解码顺序）", "#" + f.index],
      ["DTS", fmt(f.dts)],
      ["PTS", fmt(f.pts)],
      ["展示位置", r.presentationPos[f.index] >= 0
        ? "第 " + (r.presentationPos[f.index] + 1) + " 帧" : "N/A"],
      ["问题标记", f.issues.length
        ? f.issues.map(function (t) {
            return '<span class="tag">' + (ISSUE_LABELS[t] || t) + "</span>";
          }).join("")
        : '<span class="tag info">无</span>']
    ];
    if (f.reordered) {
      var dep = f.dependsOnFuture
        ? "是 — 前向参考帧 #" + f.forwardRefIndex +
          (f.forwardRefLate
            ? ' <span class="tag">参考帧晚到</span>'
            : ' <span class="tag info">参考已就绪</span>')
        : "是 — 但未找到可用的前向参考帧";
      rows.push(["重排帧（B 帧特征）", "是"]);
      rows.push(["依赖后续参考帧", dep]);
    } else {
      rows.push(["重排帧（B 帧特征）", "否（参考帧或顺序帧）"]);
      rows.push(["依赖后续参考帧", "否"]);
    }
    box.innerHTML = "<h2>帧详情 — 包 #" + f.index + "</h2><table>" +
      rows.map(function (kv) {
        return "<tr><td>" + kv[0] + "</td><td>" + kv[1] + "</td></tr>";
      }).join("") + "</table>";
  }
  function toText(packets) {
    return packets.map(function (p) {
      return p.dts + ", " + p.pts;
    }).join("\n");
  }

  function run() {
    var packets = parseInput(document.getElementById("input").value);
    result = TsAnalyzer.analyze(packets);
    selected = result.firstInvalidIndex >= 0 ? result.firstInvalidIndex : -1;
    renderSummary(result);
    renderTracks(result);
    renderDetail(result);
  }

  document.getElementById("btnBFrame").addEventListener("click", function () {
    document.getElementById("input").value =
      toText(TsSamples.makeBFrameSample(4));
    run();
  });
  document.getElementById("btnShuffled").addEventListener("click", function () {
    document.getElementById("input").value =
      toText(TsSamples.makeShuffledSample());
    run();
  });
  document.getElementById("btnAnalyze").addEventListener("click", run);

  // 默认载入 B 帧样例
  document.getElementById("input").value = toText(TsSamples.makeBFrameSample(4));
  run();
})();
