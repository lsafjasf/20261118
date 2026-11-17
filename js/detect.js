/* 检测层：把连续指标按阈值分类，构建候选区间并附带证据。
   正常静止镜头只会得到 uncertain，不会直接判为播放故障。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || (root.VFA = {});
  var Detect = VFA.Detect || (VFA.Detect = {});
  VFA.Detect = Detect;

  /* 低光下仍然“活着”的传感器噪声内部判据（与用户阈值解耦）。 */
  var NOISE_RMS = 0.8;
  var NOISE_BLOCK_FRACTION = 0.25;
  var NOISE_LUMA_DIFF = 0.8;

  function effectiveThresholds(cfg, lowlight) {
    var f = lowlight && cfg.lowlightFactor ? cfg.lowlightFactor : 1;
    return {
      luma: cfg.luma * f,
      edge: cfg.edge * f,
      motion: cfg.motion * f
    };
  }

  /* 每个帧对三分类：frozen（像素几乎完全相同）/ noise（低光扩散噪声）/ motion（有真实变化）。 */
  Detect.classifyPair = function (pair, cfg) {
    var lowlight = pair.meanLuma < cfg.lowlight;
    var th = effectiveThresholds(cfg, lowlight);
    var underThreshold =
      pair.lumaDiff <= th.luma &&
      pair.edgeDiff <= th.edge &&
      pair.blockMean <= th.motion;

    if (!underThreshold) {
      return { state: "motion", lowlight: lowlight };
    }
    var aliveNoise = lowlight && pair.rmsDiff > NOISE_RMS &&
      (pair.blockFraction >= NOISE_BLOCK_FRACTION ||
        pair.lumaDiff >= NOISE_LUMA_DIFF);
    return {
      state: aliveNoise ? "noise" : "frozen",
      lowlight: lowlight
    };
  };

  /* 折返点检测：周期运动在每个周期顶点/底点会出现规律性的低活动凹点。
     找出局部最小点，若相邻凹点间隔近似恒定且两侧有运动，则判定为周期折返。
     返回包含凹点 pair 索引与周期（秒）的结构。 */
  Detect.detectTurns = function (pairs, frames, cfg) {
    if (pairs.length < 20) return null;
    var step = frames.length > 1 ? frames[1].t - frames[0].t : 0.1;
    /* 自适应凹点门限：用整段局部运动中位数的 60%，避免依赖具体用户阈值。 */
    var sorted = pairs.map(function (p) { return p.blockMean; }).sort(function (a, b) {
      return a - b;
    });
    var median = sorted[Math.floor(sorted.length / 2)];
    var q75 = sorted[Math.floor(sorted.length * 0.75)];
    var troughCeil = Math.max(q75 * 0.7, median);
    var minima = [];
    for (var k = 2; k + 2 < pairs.length; k++) {
      var v = pairs[k].blockMean;
      if (v >= troughCeil) continue;
      /* 折返点两侧必须存在明显高于中位数的运动，静物段因此被排除。 */
      var flankMotion = pairs[k - 1].blockMean > median ||
        pairs[k + 1].blockMean > median ||
        pairs[k - 2].blockMean > median ||
        pairs[k + 2].blockMean > median;
      if (!flankMotion) continue;
      if (v <= pairs[k - 1].blockMean && v <= pairs[k + 1].blockMean &&
          v <= pairs[k - 2].blockMean && v <= pairs[k + 2].blockMean) {
        minima.push(k);
      }
    }
    if (minima.length < 3) return null;

    /* 滑动窗口：允许其他段落的不规则凹点存在，只在局部寻找等间隔簇。
       收集所有合格簇，选凹点最多、CV 最低者，避免被偶然等间隔的噪声带抢占。 */
    var candidates = [];
    for (var w = 0; w + 2 < minima.length; w++) {
      for (var size = Math.min(6, minima.length - w); size >= 3; size--) {
        var group = minima.slice(w, w + size);
        var lags = [];
        for (var i = 1; i < group.length; i++) {
          lags.push(group[i] - group[i - 1]);
        }
        var meanLag = VFA.mean(lags);
        if (meanLag * step < 0.6) continue;
        var variance = 0;
        lags.forEach(function (lg) {
          variance += (lg - meanLag) * (lg - meanLag);
        });
        var cv = Math.sqrt(variance / lags.length) / meanLag;
        if (cv > 0.2) continue;

        /* 凹点之外必须存在明显运动，排除把静止镜头当作周期。 */
        var motionAround = 0;
        for (var j = group[0] - 2; j <= group[group.length - 1] + 2; j++) {
          if (j >= 0 && j < pairs.length && pairs[j].blockMean > median) {
            motionAround++;
          }
        }
        if (motionAround < group.length) continue;

        candidates.push({
          pairIndexes: group,
          periodSeconds: meanLag * step,
          cv: cv,
          score: group.length - cv
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates[0];
  };

  function summarizeRun(pairs, start, end) {
    var run = pairs.slice(start, end + 1);
    var low = 0;
    var noisy = 0;
    var sumL = 0, sumE = 0, sumM = 0, sumR = 0;
    var maxL = 0, maxE = 0, maxBF = 0;
    run.forEach(function (p) {
      if (p._state === "noise") noisy++;
      if (p._lowlight) low++;
      sumL += p.lumaDiff; sumE += p.edgeDiff;
      sumM += p.blockMean; sumR += p.rmsDiff;
      if (p.lumaDiff > maxL) maxL = p.lumaDiff;
      if (p.edgeDiff > maxE) maxE = p.edgeDiff;
      if (p.blockFraction > maxBF) maxBF = p.blockFraction;
    });
    return {
      lowlightFraction: low / run.length,
      noiseFraction: noisy / run.length,
      avgLumaDiff: sumL / run.length,
      maxLumaDiff: maxL,
      avgEdgeDiff: sumE / run.length,
      maxEdgeDiff: maxE,
      avgBlockMotion: sumM / run.length,
      maxBlockFraction: maxBF,
      avgRms: sumR / run.length
    };
  }

  function ctxOf(pair) {
    if (!pair) return null;
    return {
      t0: pair.t0, t1: pair.t1,
      lumaDiff: pair.lumaDiff,
      edgeDiff: pair.edgeDiff,
      blockMean: pair.blockMean,
      state: pair._state
    };
  }

  function classifyInterval(run, stats, periodic, step) {
    var fromStart = run.start === 0;
    var before = !fromStart && pairsStateMotion(run.before);
    var after = run.after != null && run.after._state === "motion";
    var lowlight = stats.lowlightFraction >= 0.5;
    var noisy = stats.noiseFraction >= 0.5;
    var shortRun = run.duration <= step * 3;
    var center = (run.start + run.end) / 2;
    var nearTurn = false;
    if (periodic) {
      var reach = (periodic.periodSeconds / Math.max(step, 1e-6)) / 2 + 2;
      nearTurn = periodic.pairIndexes.some(function (idx) {
        return Math.abs(idx - center) <= reach;
      });
    }

    if (nearTurn && run.duration <= periodic.periodSeconds * 0.85) {
      return {
        status: "uncertain",
        confidence: "low",
        reason: "周期运动折返点短暂静止（折返间隔约 " +
          VFA.round2(periodic.periodSeconds) + "s，规律性间隔变异系数 " +
          VFA.round2(periodic.cv) + "），不构成冻结证据"
      };
    }
    if (noisy) {
      return {
        status: "uncertain",
        confidence: "low",
        reason: lowlight
          ? "低光段存在持续扩散的传感器噪声，画面仍在变化，更像实时采集而非冻结"
          : "画面存在扩散性细微变化，冻结证据不足"
      };
    }
    if (before && after) {
      return {
        status: "freeze",
        confidence: lowlight ? "medium" : "high",
        reason: lowlight
          ? "运动中低光画面连同传感器噪声一起停止，疑似播放冻结"
          : "运动过程中画面完全重复，前后均有运动上下文"
      };
    }
    if (!fromStart && (before || after)) {
      return {
        status: "freeze",
        confidence: "medium",
        reason: "单侧运动中断，另一侧为静止上下文，疑似冻结"
      };
    }
    return {
      status: "uncertain",
      confidence: "low",
      reason: "静止镜头且无运动上下文，无法区分正常静物与播放故障，需人工确认"
    };
  }

  function pairsStateMotion(pair) {
    return pair && pair._state === "motion";
  }

  Detect.detect = function (frames, pairs, cfg) {
    pairs.forEach(function (p) {
      var c = Detect.classifyPair(p, cfg);
      p._state = c.state;
      p._lowlight = c.lowlight;
    });

    var periodic = Detect.detectTurns(pairs, frames, cfg);

    var intervals = [];
    var k = 0;
    while (k < pairs.length) {
      if (pairs[k]._state === "motion") { k++; continue; }
      var start = k;
      while (k < pairs.length && pairs[k]._state !== "motion") k++;
      var end = k - 1;
      var t0 = frames[start].t;
      var t1 = frames[end + 1].t;
      var duration = t1 - t0;
      if (duration + 1e-9 < cfg.minDuration) continue;

      var stats = summarizeRun(pairs, start, end);
      var runInfo = {
        start: start,
        end: end,
        duration: duration,
        before: start > 0 ? pairs[start - 1] : null,
        after: end + 1 < pairs.length ? pairs[end + 1] : null
      };
      var step = frames.length > 1 ? frames[1].t - frames[0].t : 0;
      var verdict = classifyInterval(runInfo, stats, periodic, step);
      var pairStates = pairs.slice(start, end + 1).map(function (p) {
        return { t0: p.t0, t1: p.t1, state: p._state, lowlight: p._lowlight };
      });
      intervals.push({
        id: "cand@" + t0.toFixed(3) + "-" + t1.toFixed(3),
        t0: t0, t1: t1, duration: duration,
        status: verdict.status,
        confidence: verdict.confidence,
        reason: verdict.reason,
        lowlight: stats.lowlightFraction >= 0.5,
        evidence: Object.assign({}, stats, {
          contextBefore: ctxOf(runInfo.before),
          contextAfter: ctxOf(runInfo.after),
          periodic: !!periodic,
          pairStates: pairStates
        })
      });
    }

    return {
      intervals: intervals,
      pairStates: pairs.map(function (p) {
        return { t0: p.t0, t1: p.t1, state: p._state, lowlight: p._lowlight };
      }),
      periodicity: periodic
    };
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Detect;
  }
})(typeof window !== "undefined" ? window : globalThis);
