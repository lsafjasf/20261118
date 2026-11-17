(function (root, factory) {
  const timecode = typeof module === "object" && module.exports
    ? require("./timecode.js")
    : root.TimecodeMath;
  const api = factory(timecode);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.MappingMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (TimecodeMath) {
  "use strict";

  const DOMAIN_KEYS = ["camera", "audio", "timeline"];
  const DOMAIN_LABELS = {
    camera: "摄像机",
    audio: "音频",
    timeline: "剪辑时间线"
  };
  const DOMAIN_SHORT = { camera: "CAM", audio: "AUD", timeline: "TL" };
  const DEFAULT_TOLERANCE_FRAMES = 1;

  function domainLabel(key) {
    return DOMAIN_LABELS[key] || key;
  }

  function parseSyncRows(rows, domains) {
    const points = [];
    const rowErrors = {};
    let hasError = false;

    rows.forEach((row, rowIndex) => {
      const point = { index: rowIndex, id: row.id, raw: row };
      DOMAIN_KEYS.forEach((key) => {
        try {
          const frames = TimecodeMath.timecodeToFrames(row[key], domains[key]);
          const seconds = TimecodeMath.framesToSeconds(frames, domains[key].rate);
          point[key] = { frames, seconds, timecode: row[key] };
        } catch (error) {
          point[key] = null;
          rowErrors[`${row.id}:${key}`] = error.message;
          hasError = true;
        }
      });
      if (DOMAIN_KEYS.every((key) => point[key])) {
        points.push(point);
      }
    });

    return { points, rowErrors, hasError };
  }

  function fitLine(points, sourceKey, targetKey) {
    const count = points.length;
    if (count < 2) {
      return null;
    }

    let meanX = 0;
    let meanY = 0;
    points.forEach((point) => {
      meanX += point[sourceKey].seconds;
      meanY += point[targetKey].seconds;
    });
    meanX /= count;
    meanY /= count;

    let covariance = 0;
    let variance = 0;
    points.forEach((point) => {
      const dx = point[sourceKey].seconds - meanX;
      covariance += dx * (point[targetKey].seconds - meanY);
      variance += dx * dx;
    });

    const slope = variance > 1e-12 ? covariance / variance : 0;
    const intercept = meanY - (slope * meanX);
    return {
      slope,
      intercept,
      meanX,
      variance,
      sampleCount: count
    };
  }

  function applyMapping(mapping, sourceSeconds) {
    return (mapping.slope * sourceSeconds) + mapping.intercept;
  }

  function invertMapping(mapping) {
    if (!mapping || Math.abs(mapping.slope) < 1e-15) {
      return null;
    }
    return {
      slope: 1 / mapping.slope,
      intercept: -mapping.intercept / mapping.slope,
      sampleCount: mapping.sampleCount
    };
  }

  function signedFrameError(predictedSeconds, actualSeconds, domain) {
    return TimecodeMath.secondsToFrames(predictedSeconds - actualSeconds, domain.rate);
  }

  function topTwoIndices(residuals) {
    return residuals
      .map((item, index) => ({ index, absolute: Math.abs(item.errorFrames) }))
      .sort((left, right) => right.absolute - left.absolute || left.index - right.index)
      .slice(0, 2)
      .map((item) => item.index);
  }

  function buildPairAudit(points, sourceKey, targetKey, domains, toleranceFrames) {
    const audits = [];
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const pair = [points[left], points[right]];
        const line = fitLine(pair, sourceKey, targetKey);
        let worst = null;
        points.forEach((point, pointIndex) => {
          if (pointIndex === left || pointIndex === right) {
            return;
          }
          const predicted = applyMapping(line, point[sourceKey].seconds);
          const errorFrames = signedFrameError(predicted, point[targetKey].seconds, domains[targetKey]);
          if (!worst || Math.abs(errorFrames) > Math.abs(worst.errorFrames)) {
            worst = { pointIndex, errorFrames };
          }
        });
        audits.push({
          pair: [left, right],
          pairNumbers: [points[left].index + 1, points[right].index + 1],
          slope: line.slope,
          atPoint: worst ? worst.pointIndex : null,
          atPointNumber: worst ? points[worst.pointIndex].index + 1 : null,
          maxErrorFrames: worst ? Math.abs(worst.errorFrames) : 0,
          signedErrorFrames: worst ? worst.errorFrames : 0,
          conflict: Boolean(worst && Math.abs(worst.errorFrames) > toleranceFrames)
        });
      }
    }
    return audits.sort((left, right) => right.maxErrorFrames - left.maxErrorFrames);
  }

  function analyzeMapping(points, sourceKey, targetKey, domains, toleranceFrames) {
    const tolerance = Number.isFinite(toleranceFrames)
      ? toleranceFrames
      : DEFAULT_TOLERANCE_FRAMES;
    if (!DOMAIN_KEYS.includes(sourceKey) || !DOMAIN_KEYS.includes(targetKey)) {
      throw new Error("未知的时间码域");
    }
    if (sourceKey === targetKey) {
      throw new Error("源域和目标域不能相同");
    }

    const base = {
      sourceKey,
      targetKey,
      sourceLabel: domainLabel(sourceKey),
      targetLabel: domainLabel(targetKey),
      toleranceFrames: tolerance,
      sampleCount: points.length,
      residuals: [],
      pairAudits: [],
      conflicts: [],
      status: "insufficient"
    };

    if (points.length < 2) {
      base.message = "至少需要两个有效同步点";
      return base;
    }

    const line = fitLine(points, sourceKey, targetKey);
    const targetFps = TimecodeMath.normalizeRate(domains[targetKey].rate).actual;
    const residuals = points.map((point) => {
      const predictedSeconds = applyMapping(line, point[sourceKey].seconds);
      const errorFrames = (predictedSeconds - point[targetKey].seconds) * targetFps;
      return {
        pointNumber: point.index + 1,
        predictedSeconds,
        predictedTimecode: TimecodeMath.secondsToTimecode(predictedSeconds, domains[targetKey]),
        actualSeconds: point[targetKey].seconds,
        actualTimecode: point[targetKey].timecode,
        errorFrames,
        errorMilliseconds: (predictedSeconds - point[targetKey].seconds) * 1000
      };
    });

    const meanSquareError = residuals.reduce(
      (sum, item) => sum + (item.errorFrames * item.errorFrames),
      0
    ) / residuals.length;
    const pairAudits = buildPairAudit(points, sourceKey, targetKey, domains, tolerance);
    const invalidSlope = !Number.isFinite(line.slope) || line.slope <= 1e-12;
    const residualsOverTolerance = residuals.filter(
      (item) => Math.abs(item.errorFrames) > tolerance
    );

    let conflictPair = [];
    if (invalidSlope) {
      conflictPair = [0, 1];
    } else if (residualsOverTolerance.length) {
      const ranked = topTwoIndices(residuals);
      conflictPair = ranked;
      if (ranked.length < 2) {
        conflictPair = [ranked[0], ranked[0] === 0 ? 1 : 0];
      }
    }

    const conflicts = pairAudits.filter((audit) => audit.conflict);
    base.slope = line.slope;
    base.intercept = line.intercept;
    base.driftPpm = (line.slope - 1) * 1e6;
    base.offsetSeconds = line.intercept;
    base.offsetFrames = line.intercept * targetFps;
    base.offsetTimecode = TimecodeMath.secondsToTimecode(line.intercept, domains[targetKey]);
    base.rmsFrames = Math.sqrt(meanSquareError);
    base.maxErrorFrames = residuals.reduce(
      (max, item) => Math.max(max, Math.abs(item.errorFrames)),
      0
    );
    base.residuals = residuals;
    base.pairAudits = pairAudits;
    base.conflicts = conflicts;
    base.conflictPair = conflictPair.map((index) => points[index].index + 1);
    base.conflict = invalidSlope || residualsOverTolerance.length > 0;
    base.status = base.conflict ? "conflict" : "consistent";
    base.equation = `T(${DOMAIN_SHORT[targetKey]}) = ${line.slope.toFixed(9)} × T(${DOMAIN_SHORT[sourceKey]}) ${line.intercept >= 0 ? "+" : "−"} ${Math.abs(line.intercept).toFixed(6)} s`;

    if (base.conflict) {
      const [left, right] = base.conflictPair;
      base.message = invalidSlope
        ? `同步点 #${left} 与 #${right} 会让映射时间倒流，无法同时满足`
        : `同步点 #${left} 与 #${right} 无法同时满足（残差超过 ${tolerance.toFixed(2)} 帧）`;
    } else {
      base.message = "所有同步点可被同一条线性映射满足";
    }
    return base;
  }

  function analyzeAllMappings(points, domains, toleranceFrames) {
    const mappings = {};
    DOMAIN_KEYS.forEach((sourceKey) => {
      DOMAIN_KEYS.forEach((targetKey) => {
        if (sourceKey !== targetKey) {
          mappings[`${sourceKey}->${targetKey}`] = analyzeMapping(
            points,
            sourceKey,
            targetKey,
            domains,
            toleranceFrames
          );
        }
      });
    });
    return mappings;
  }

  function mapFor(mappings, sourceKey, targetKey) {
    const direct = mappings[`${sourceKey}->${targetKey}`];
    if (direct && direct.slope) {
      return direct;
    }
    const reverse = mappings[`${targetKey}->${sourceKey}`];
    if (!reverse || !reverse.slope) {
      return null;
    }
    return invertMapping(reverse);
  }

  function convertTimecode(sourceTimecode, sourceKey, targetKey, domains, mappings) {
    const sourceFrames = TimecodeMath.timecodeToFrames(sourceTimecode, domains[sourceKey]);
    const sourceSeconds = TimecodeMath.framesToSeconds(
      sourceFrames,
      domains[sourceKey].rate
    );
    const mapping = mapFor(mappings, sourceKey, targetKey);
    if (!mapping) {
      throw new Error("没有可用的映射");
    }
    const targetSeconds = applyMapping(mapping, sourceSeconds);
    return {
      sourceFrames,
      sourceSeconds,
      targetSeconds,
      targetTimecode: TimecodeMath.secondsToTimecode(targetSeconds, domains[targetKey]),
      targetFrames: Math.round(
        TimecodeMath.secondsToFrames(targetSeconds, domains[targetKey].rate)
      ),
      offsetMilliseconds: (targetSeconds - sourceSeconds) * 1000
    };
  }

  function convertToAll(sourceTimecode, sourceKey, domains, mappings) {
    const result = {};
    DOMAIN_KEYS.forEach((targetKey) => {
      result[targetKey] = targetKey === sourceKey
        ? {
            sourceFrames: TimecodeMath.timecodeToFrames(sourceTimecode, domains[sourceKey]),
            sourceSeconds: TimecodeMath.timecodeToSeconds(sourceTimecode, domains[sourceKey]),
            targetSeconds: TimecodeMath.timecodeToSeconds(sourceTimecode, domains[sourceKey]),
            targetTimecode: sourceTimecode,
            targetFrames: TimecodeMath.timecodeToFrames(sourceTimecode, domains[sourceKey]),
            offsetMilliseconds: 0
          }
        : convertTimecode(sourceTimecode, sourceKey, targetKey, domains, mappings);
    });
    return result;
  }

  function buildConversionTable(options) {
    const {
      sourceKey,
      startTimecode,
      endTimecode,
      stepFrames,
      stepSeconds,
      domains,
      mappings,
      limit = 2000
    } = options;
    const startSeconds = TimecodeMath.timecodeToSeconds(startTimecode, domains[sourceKey]);
    let endSeconds = TimecodeMath.timecodeToSeconds(endTimecode, domains[sourceKey]);
    const rate = TimecodeMath.normalizeRate(domains[sourceKey].rate);
    const stride = Number.isFinite(stepSeconds) && stepSeconds > 0
      ? stepSeconds
      : (Number.isFinite(stepFrames) && stepFrames > 0
          ? stepFrames / rate.actual
          : 1);
    if (endSeconds < startSeconds) {
      endSeconds += 24 * 60 * 60;
    }
    const rowCount = Math.floor((endSeconds - startSeconds) / stride) + 1;
    if (rowCount > limit) {
      throw new Error(`换算表最多 ${limit} 行，请增大步长或缩短范围`);
    }

    const rows = [];
    for (let offset = 0; offset < rowCount; offset += 1) {
      const sourceSeconds = startSeconds + (offset * stride);
      const frame = Math.round(TimecodeMath.secondsToFrames(sourceSeconds, rate.actual));
      const row = {
        index: rows.length + 1,
        sourceFrames: frame,
        sourceSeconds,
        domains: {}
      };
      DOMAIN_KEYS.forEach((key) => {
        if (key === sourceKey) {
          row.domains[key] = {
            timecode: TimecodeMath.framesToTimecode(frame, domains[key]),
            seconds: sourceSeconds,
            offsetMilliseconds: 0
          };
          return;
        }
        const mapping = mapFor(mappings, sourceKey, key);
        if (!mapping) {
          row.domains[key] = null;
          return;
        }
        const seconds = applyMapping(mapping, sourceSeconds);
        row.domains[key] = {
          timecode: TimecodeMath.secondsToTimecode(seconds, domains[key]),
          seconds,
          offsetMilliseconds: (seconds - sourceSeconds) * 1000
        };
      });
      rows.push(row);
    }
    if (rows.length && Math.abs(rows[rows.length - 1].sourceSeconds - endSeconds) > 1e-7) {
      const frame = Math.round(TimecodeMath.secondsToFrames(endSeconds, rate.actual));
      const row = {
        index: rows.length + 1,
        sourceFrames: frame,
        sourceSeconds: endSeconds,
        domains: {}
      };
      DOMAIN_KEYS.forEach((key) => {
        if (key === sourceKey) {
          row.domains[key] = {
            timecode: TimecodeMath.framesToTimecode(frame, domains[key]),
            seconds: endSeconds,
            offsetMilliseconds: 0
          };
          return;
        }
        const mapping = mapFor(mappings, sourceKey, key);
        const seconds = mapping ? applyMapping(mapping, endSeconds) : NaN;
        row.domains[key] = mapping
          ? {
              timecode: TimecodeMath.secondsToTimecode(seconds, domains[key]),
              seconds,
              offsetMilliseconds: (seconds - endSeconds) * 1000
            }
          : null;
      });
      rows.push(row);
    }
    return rows;
  }

  function escapeCsv(value) {
    const text = String(value == null ? "" : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function conversionTableToCsv(rows, metadata) {
    const meta = metadata || {};
    const headers = [
      "序号",
      "基准域",
      "基准时间码",
      "基准实际秒",
      "摄像机时间码",
      "摄像机实际秒",
      "音频时间码",
      "音频实际秒",
      "剪辑时间线时间码",
      "剪辑时间线实际秒",
      "到摄像机偏移毫秒",
      "到音频偏移毫秒",
      "到时间线偏移毫秒"
    ];
    const lines = [];
    if (meta.title) {
      lines.push(`"${String(meta.title).replace(/"/g, '""')}"`);
    }
    if (meta.rates) {
      lines.push(`"摄像机 ${meta.rates.camera} | 音频 ${meta.rates.audio} | 时间线 ${meta.rates.timeline}"`);
    }
    if (Array.isArray(meta.notes)) {
      meta.notes.filter(Boolean).forEach((note) => {
        lines.push(`"${String(note).replace(/"/g, '""')}"`);
      });
    }
    if (lines.length) {
      lines.push("");
    }
    lines.push(headers.join(","));
    rows.forEach((row) => {
      const values = [
        row.index,
        DOMAIN_LABELS[meta.sourceKey] || meta.sourceKey || "",
        (row.domains[meta.sourceKey] || {}).timecode,
        row.sourceSeconds.toFixed(6),
        (row.domains.camera || {}).timecode,
        (row.domains.camera || {}).seconds?.toFixed(6),
        (row.domains.audio || {}).timecode,
        (row.domains.audio || {}).seconds?.toFixed(6),
        (row.domains.timeline || {}).timecode,
        (row.domains.timeline || {}).seconds?.toFixed(6),
        (row.domains.camera || {}).offsetMilliseconds?.toFixed(3),
        (row.domains.audio || {}).offsetMilliseconds?.toFixed(3),
        (row.domains.timeline || {}).offsetMilliseconds?.toFixed(3)
      ];
      lines.push(values.map(escapeCsv).join(","));
    });
    return `\uFEFF${lines.join("\n")}\n`;
  }

  return {
    DOMAIN_KEYS,
    DOMAIN_LABELS,
    DOMAIN_SHORT,
    DEFAULT_TOLERANCE_FRAMES,
    parseSyncRows,
    fitLine,
    applyMapping,
    invertMapping,
    analyzeMapping,
    analyzeAllMappings,
    mapFor,
    convertTimecode,
    convertToAll,
    buildConversionTable,
    conversionTableToCsv
  };
});
