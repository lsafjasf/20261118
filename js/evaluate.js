/* 真值评估与阈值扫描：漏检、误报、区间边界误差。
   uncertain 候选不计作强误报（系统从未把静止镜头直接认定为故障）。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || (root.VFA = {});
  var Evaluate = VFA.Evaluate || (VFA.Evaluate = {});
  VFA.Evaluate = Evaluate;

  Evaluate.overlap = function (a, b) {
    var lo = Math.max(a.t0, b.t0);
    var hi = Math.min(a.t1, b.t1);
    return Math.max(0, hi - lo);
  };

  /* 贪心按重叠最大配对，返回 {matches, unmatchedTruth, unmatchedCand}。 */
  Evaluate.matchIntervals = function (truths, candidates) {
    var pool = candidates.map(function (c, i) {
      return { index: i, cand: c, used: false };
    });
    var matches = [];
    truths.forEach(function (gt) {
      var best = null;
      pool.forEach(function (entry) {
        if (entry.used) return;
        var ov = Evaluate.overlap(gt, entry.cand);
        if (ov <= 0) return;
        if (!best || ov > best.ov) best = { entry: entry, ov: ov };
      });
      if (best) {
        best.entry.used = true;
        matches.push({
          truth: gt,
          candidate: best.entry.cand,
          overlap: best.ov,
          startError: Math.abs(best.entry.cand.t0 - gt.t0),
          endError: Math.abs(best.entry.cand.t1 - gt.t1)
        });
      }
    });
    return {
      matches: matches,
      unmatchedTruth: truths.filter(function (gt) {
        return !matches.some(function (m) { return m.truth === gt; });
      }),
      unmatchedCand: pool.filter(function (e) { return !e.used; }).map(function (e) {
        return e.cand;
      })
    };
  };

  Evaluate.evaluate = function (intervals, groundTruth, tolerance) {
    tolerance = tolerance == null ? 0.3 : tolerance;
    var truths = (groundTruth && groundTruth.freezes) || [];
    var result = Evaluate.matchIntervals(truths, intervals);

    var startErrors = result.matches.map(function (m) { return m.startError; });
    var endErrors = result.matches.map(function (m) { return m.endError; });
    var boundary = startErrors.concat(endErrors);

    var strongFalse = result.unmatchedCand.filter(function (c) {
      return c.status === "freeze";
    });
    var uncertainOnly = result.unmatchedCand.filter(function (c) {
      return c.status === "uncertain";
    });

    var detected = result.matches.length;
    var precision = intervals.length
      ? detected / (detected + strongFalse.length) : 1;
    var recall = truths.length ? detected / truths.length : 1;

    return {
      truthCount: truths.length,
      detected: detected,
      misses: result.unmatchedTruth,
      strongFalseAlarms: strongFalse,
      uncertainCandidates: uncertainOnly,
      matches: result.matches,
      tolerance: tolerance,
      withinTolerance: result.matches.filter(function (m) {
        return m.startError <= tolerance && m.endError <= tolerance;
      }).length,
      boundary: {
        mean: boundary.length ? VFA.mean(boundary) : 0,
        max: boundary.length ? Math.max.apply(null, boundary) : 0,
        startMean: startErrors.length ? VFA.mean(startErrors) : 0,
        endMean: endErrors.length ? VFA.mean(endErrors) : 0
      },
      precision: precision,
      recall: recall
    };
  };

  /* 用同一批帧/指标在多套阈值下重算（缓存命中，不重新取样）。 */
  Evaluate.sweep = function (frames, pairs, presets, minDuration, groundTruth) {
    return Object.keys(presets).map(function (name) {
      var cfg = Object.assign({}, presets[name], { minDuration: minDuration });
      var localPairs = pairs.map(function (p) {
        return Object.assign({}, p, { blockDiffs: p.blockDiffs });
      });
      var result = VFA.Detect.detect(frames, localPairs, cfg);
      var metrics = groundTruth
        ? Evaluate.evaluate(result.intervals, groundTruth)
        : null;
      return {
        preset: name,
        label: presets[name].label,
        config: cfg,
        intervals: result.intervals,
        periodicity: result.periodicity,
        metrics: metrics
      };
    });
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Evaluate;
  }
})(typeof window !== "undefined" ? window : globalThis);
