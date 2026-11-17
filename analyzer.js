/*
 * DTS/PTS 序列分析模块（纯逻辑，Node 与浏览器共用）。
 * 输入：按解码顺序（解复用输出顺序）排列的包数组 [{ dts, pts }, ...]。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TsAnalyzer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    // 相邻时间戳间隔超过“中位间隔 × gapFactor”即判定为过大间隔
    gapFactor: 3,
    // 无法估计中位间隔（包数过少）时使用的绝对兜底阈值
    fallbackGap: 90000 * 5 // 90kHz 下 5 秒
  };

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = sorted.length >> 1;
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function count(frames, tag) {
    var c = 0;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].issues.indexOf(tag) >= 0) c++;
    }
    return c;
  }
  /**
   * 分析按解码顺序给出的 DTS/PTS 序列。
   * @param {Array<{dts:number, pts:number}>} packets
   * @param {object} [opts] 可覆盖 DEFAULTS
   */
  function analyze(packets, opts) {
    var cfg = {};
    var k;
    for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (opts) for (k in opts) cfg[k] = opts[k];

    var n = packets.length;
    var frames = [];
    var i, j;

    // ---- 第一遍：逐帧基础校验（负时间 / 非数值 / 重复 / DTS 单调性）----
    var dtsDeltas = [];
    for (i = 0; i < n; i++) {
      var p = packets[i] || {};
      var f = {
        index: i,          // 包索引 = 解码顺序
        dts: p.dts,
        pts: p.pts,
        issues: []         // 该帧命中的问题标签
      };
      if (!isNum(p.dts) || !isNum(p.pts)) {
        f.issues.push("invalid-value");
      } else {
        if (p.dts < 0 || p.pts < 0) f.issues.push("negative-time");
        if (i > 0 && isNum(packets[i - 1].dts)) {
          if (p.dts < packets[i - 1].dts) f.issues.push("dts-non-monotonic");
          if (p.dts === packets[i - 1].dts) f.issues.push("duplicate-dts");
          var dd = p.dts - packets[i - 1].dts;
          if (dd > 0) dtsDeltas.push(dd);
        }
        if (i > 0 && isNum(packets[i - 1].pts)) {
          if (p.pts === packets[i - 1].pts) f.issues.push("duplicate-pts");
        }
      }
      frames.push(f);
    }

    // PTS 全局重复检测（不限于相邻）
    var ptsSeen = {};
    for (i = 0; i < n; i++) {
      var pts = frames[i].pts;
      if (!isNum(pts)) continue;
      if (ptsSeen[pts] !== undefined) {
        if (frames[i].issues.indexOf("duplicate-pts") < 0) {
          frames[i].issues.push("duplicate-pts");
        }
        var firstIdx = ptsSeen[pts];
        if (frames[firstIdx].issues.indexOf("duplicate-pts") < 0) {
          frames[firstIdx].issues.push("duplicate-pts");
        }
      } else {
        ptsSeen[pts] = i;
      }
    }
    // ---- 展示顺序：按 PTS 稳定排序 ----
    var presentationOrder = frames
      .filter(function (f) { return isNum(f.pts); })
      .slice()
      .sort(function (a, b) { return a.pts - b.pts || a.index - b.index; })
      .map(function (f) { return f.index; });

    // ---- 过大间隔检测（基于中位间隔的自适应阈值）----
    // DTS 间隔在解码顺序上检测；PTS 间隔在展示顺序上检测，
    // 否则合法的 B 帧重排会被误判为过大间隔。
    var dtsGapLimit = dtsDeltas.length
      ? median(dtsDeltas) * cfg.gapFactor
      : cfg.fallbackGap;
    var ptsPresDeltas = [];
    for (i = 1; i < presentationOrder.length; i++) {
      var pd = frames[presentationOrder[i]].pts -
               frames[presentationOrder[i - 1]].pts;
      if (pd > 0) ptsPresDeltas.push(pd);
    }
    var ptsGapLimit = ptsPresDeltas.length
      ? median(ptsPresDeltas) * cfg.gapFactor
      : cfg.fallbackGap;
    for (i = 1; i < n; i++) {
      var prev = frames[i - 1], cur = frames[i];
      if (isNum(prev.dts) && isNum(cur.dts) &&
          cur.dts - prev.dts > dtsGapLimit) {
        cur.issues.push("large-dts-gap");
      }
    }
    for (i = 1; i < presentationOrder.length; i++) {
      var pa = frames[presentationOrder[i - 1]];
      var pb = frames[presentationOrder[i]];
      if (pb.pts - pa.pts > ptsGapLimit) {
        pb.issues.push("large-pts-gap");
      }
    }

    // 每帧的展示位置
    var presentationPos = new Array(n).fill(-1);
    presentationOrder.forEach(function (decodeIdx, pos) {
      presentationPos[decodeIdx] = pos;
    });

    // ---- 重排窗口长度 ----
    // 定义：展示位置 p 处的帧在解码序列中的位置为 d(p)，
    // 重排窗口 = max(d(p) - p) + 1，即解码端重排缓冲所需的最小帧数。
    var reorderWindow = 0;
    presentationOrder.forEach(function (decodeIdx, pos) {
      var depth = decodeIdx - pos + 1;
      if (depth > reorderWindow) reorderWindow = depth;
    });

    // ---- 前向参考帧依赖（B 帧重排特征）----
    // 仅凭时间戳无法获知真实参考关系，采用如下启发式：
    //  “重排帧” = PTS 小于此前已解码帧的最大 PTS（典型 B 帧特征），
    //  它依赖一个展示顺序更晚（PTS 更大）的参考帧，即“后续参考帧”；
    //  “参考帧特征” = 解码到该帧时 PTS 创新高（I/P 帧）。
    //  对重排帧取展示顺序上最近的参考帧作为其前向参考；
    //  若该参考帧包索引大于自身（forwardRefLate），说明参考帧晚到，
    //  属于异常（严格解码顺序下不会发生，仅在数据损坏时出现）。
    var maxPtsBefore = -Infinity;
    for (i = 0; i < n; i++) {
      var fr = frames[i];
      fr.reordered = isNum(fr.pts) && fr.pts < maxPtsBefore;
      fr.refLike = isNum(fr.pts) && fr.pts > maxPtsBefore;
      if (isNum(fr.pts) && fr.pts > maxPtsBefore) maxPtsBefore = fr.pts;
    }
    for (i = 0; i < n; i++) {
      var fi = frames[i];
      fi.forwardRefIndex = -1; // 展示顺序上最近的前向参考帧包索引
      fi.dependsOnFuture = false;
      fi.forwardRefLate = false;
      if (!isNum(fi.pts) || !fi.reordered) continue;
      var best = -1;
      for (j = 0; j < n; j++) {
        if (!frames[j].refLike) continue;
        if (frames[j].pts > fi.pts &&
            (best < 0 || frames[j].pts < frames[best].pts)) {
          best = j;
        }
      }
      fi.forwardRefIndex = best;
      fi.dependsOnFuture = best >= 0;
      fi.forwardRefLate = best > i;
    }
    // ---- 展示顺序合法性：重排后 PTS 应严格递增 ----
    var presentationOk = true;
    for (i = 1; i < presentationOrder.length; i++) {
      var a = frames[presentationOrder[i - 1]].pts;
      var b = frames[presentationOrder[i]].pts;
      if (!(b > a)) { presentationOk = false; break; }
    }

    // ---- 解码顺序合法性：DTS 应非递减 ----
    var decodeOk = true;
    for (i = 1; i < n; i++) {
      if (isNum(frames[i].dts) && isNum(frames[i - 1].dts) &&
          frames[i].dts < frames[i - 1].dts) {
        decodeOk = false;
        break;
      }
    }

    // ---- 首个非法时间戳包索引 ----
    var firstInvalidIndex = -1;
    for (i = 0; i < n; i++) {
      if (frames[i].issues.length) { firstInvalidIndex = i; break; }
    }

    return {
      frames: frames,
      presentationOrder: presentationOrder,
      presentationPos: presentationPos,
      reorderWindow: reorderWindow,
      decodeOrderOk: decodeOk,
      presentationOrderOk: presentationOk,
      firstInvalidIndex: firstInvalidIndex,
      thresholds: { dtsGapLimit: dtsGapLimit, ptsGapLimit: ptsGapLimit },
      summary: {
        packetCount: n,
        negativeCount: count(frames, "negative-time"),
        duplicateCount: count(frames, "duplicate-dts") +
                        count(frames, "duplicate-pts"),
        largeGapCount: count(frames, "large-dts-gap") +
                       count(frames, "large-pts-gap"),
        dtsNonMonotonicCount: count(frames, "dts-non-monotonic"),
        futureRefCount: frames.filter(function (f) {
          return f.dependsOnFuture;
        }).length
      }
    };
  }

  return { analyze: analyze, DEFAULTS: DEFAULTS };
});
