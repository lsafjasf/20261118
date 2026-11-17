/* 帧间指标：亮度差、Sobel 边缘差、分块局部运动、低光/噪声统计。
   全部基于灰度数组运算，不依赖 DOM，可在 Node 中直接测试。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || (root.VFA = {});
  var Metrics = VFA.Metrics || (VFA.Metrics = {});
  VFA.Metrics = Metrics;

  /* RGBA ImageData -> 灰度 (Uint8Array, BT.601)。 */
  Metrics.toLuma = function (data, w, h) {
    var out = new Uint8Array(w * h);
    var p = 0;
    for (var i = 0; i < w * h; i++) {
      out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      p += 4;
    }
    return out;
  };

  /* Sobel 边缘强度，归一化到 0..1（|Gx|+|Gy| 理论上限 1020）。 */
  Metrics.sobel = function (luma, w, h) {
    var edge = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      var row = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = row + x;
        var gx =
          -luma[i - w - 1] + luma[i - w + 1]
          - 2 * luma[i - 1] + 2 * luma[i + 1]
          - luma[i + w - 1] + luma[i + w + 1];
        var gy =
          luma[i - w - 1] + 2 * luma[i - w] + luma[i - w + 1]
          - luma[i + w - 1] - 2 * luma[i + w] - luma[i + w + 1];
        edge[i] = (Math.abs(gx) + Math.abs(gy)) / 1020;
      }
    }
    return edge;
  };

  /* 单帧平均亮度。 */
  Metrics.meanLuma = function (luma) {
    var sum = 0;
    for (var i = 0; i < luma.length; i++) sum += luma[i];
    return sum / luma.length;
  };

  /* 相邻两帧的完整指标。
     gridCols/gridRows：局部运动分块数。
     返回字段均为连续量，阈值判定放在 detect 层，方便阈值扫描复用。 */
  Metrics.pairMetrics = function (prev, curr, w, h, gridCols, gridRows) {
    var n = w * h;
    var sumAbs = 0;
    var sumSq = 0;
    for (var i = 0; i < n; i++) {
      var d = curr[i] - prev[i];
      var ad = d < 0 ? -d : d;
      sumAbs += ad;
      sumSq += d * d;
    }
    var lumaDiff = sumAbs / n;
    var rmsDiff = Math.sqrt(sumSq / n);

    var edgePrev = Metrics.sobel(prev, w, h);
    var edgeCurr = Metrics.sobel(curr, w, h);
    var edgeSum = 0;
    for (var j = 0; j < n; j++) {
      var ed = edgeCurr[j] - edgePrev[j];
      edgeSum += ed < 0 ? -ed : ed;
    }
    var edgeDiff = edgeSum / n;

    var blockW = w / gridCols;
    var blockH = h / gridRows;
    var blockCount = gridCols * gridRows;
    var blockDiffs = new Float32Array(blockCount);
    var movingBlocks = 0;
    var BLOCK_CUTOFF = 0.02; /* 块内归一化变化超过 2% 视为活动块 */
    for (var by = 0; by < gridRows; by++) {
      var y0 = Math.round(by * blockH);
      var y1 = Math.round((by + 1) * blockH);
      for (var bx = 0; bx < gridCols; bx++) {
        var x0 = Math.round(bx * blockW);
        var x1 = Math.round((bx + 1) * blockW);
        var bsum = 0;
        var bn = 0;
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) {
            var bd = curr[y * w + x] - prev[y * w + x];
            bsum += bd < 0 ? -bd : bd;
            bn++;
          }
        }
        var norm = bsum / (bn * 255);
        blockDiffs[by * gridCols + bx] = norm;
        if (norm > BLOCK_CUTOFF) movingBlocks++;
      }
    }
    var blockMeanSum = 0;
    for (var k = 0; k < blockCount; k++) blockMeanSum += blockDiffs[k];

    return {
      lumaDiff: lumaDiff,
      rmsDiff: rmsDiff,
      edgeDiff: edgeDiff,
      blockMean: blockMeanSum / blockCount,
      blockFraction: movingBlocks / blockCount,
      blockDiffs: blockDiffs,
      meanLuma: Metrics.meanLuma(curr)
    };
  };

  /* 为一组帧批量计算相邻帧指标，结果与 pairs 对齐：pairs[k] 连接 frames[k] 与 frames[k+1]。 */
  Metrics.buildPairs = function (frames, gridCols, gridRows) {
    var pairs = [];
    for (var k = 0; k + 1 < frames.length; k++) {
      var m = Metrics.pairMetrics(
        frames[k].luma, frames[k + 1].luma,
        frames[k].w, frames[k].h, gridCols, gridRows
      );
      m.t0 = frames[k].t;
      m.t1 = frames[k + 1].t;
      m.index = k;
      pairs.push(m);
    }
    return pairs;
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Metrics;
  }
})(typeof window !== "undefined" ? window : globalThis);
