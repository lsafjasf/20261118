const EPSILON = 0.001;

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function splitAttributes(value) {
  const parts = [];
  let current = "";
  let quoted = false;

  for (const character of value) {
    if (character === "\"") quoted = !quoted;
    if (character === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export function parseAttributeList(value = "") {
  const attributes = {};
  for (const part of splitAttributes(value.trim())) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      if (/^-?\d+(?:\.\d+)?$/.test(part.trim())) attributes.DURATION = part.trim();
      continue;
    }
    const key = part.slice(0, separator).trim().toUpperCase();
    const raw = part.slice(separator + 1).trim();
    attributes[key] = raw.replace(/^"(.*)"$/, "$1");
  }
  return attributes;
}

function cueOperation(line) {
  if (line.startsWith("#EXT-OATCLS-SCTE35:")) {
    return { type: "scte35", payload: line.slice(line.indexOf(":") + 1).trim() };
  }
  if (line.startsWith("#EXT-X-DATERANGE:")) {
    return { type: "daterange", attrs: parseAttributeList(line.slice(line.indexOf(":") + 1)) };
  }
  if (line.startsWith("#EXT-X-SCTE35:")) {
    return { type: "scte35-attr", attrs: parseAttributeList(line.slice(line.indexOf(":") + 1)) };
  }
  if (line.startsWith("#EXT-X-CUE-OUT-CONT:")) {
    return { type: "cue-out-cont", raw: line.slice(line.indexOf(":") + 1).trim() };
  }
  if (line.startsWith("#EXT-X-CUE-OUT:")) {
    return { type: "cue-out", raw: line.slice(line.indexOf(":") + 1).trim() };
  }
  if (line.startsWith("#EXT-X-CUE-IN")) {
    const colon = line.indexOf(":");
    return { type: "cue-in", attrs: colon < 0 ? {} : parseAttributeList(line.slice(colon + 1)) };
  }
  return null;
}

function parseCueOut(operation, inheritedScte35 = null) {
  const raw = operation.raw || "";
  const looksLikeAttributes = /[A-Za-z-]+\s*=/.test(raw);
  const attrs = looksLikeAttributes ? parseAttributeList(raw) : {};
  const durationText = attrs.DURATION ?? (/^-?\d+(?:\.\d+)?$/.test(raw) ? raw : null);
  const scte35 = attrs["SCTE35-OUT"] ?? attrs.SCTE35 ?? inheritedScte35;
  return {
    attrs,
    duration: durationText == null ? null : Number(durationText),
    scte35
  };
}

function parseCueOutCont(operation, inheritedScte35 = null) {
  const raw = operation.raw || "";
  const numeric = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (numeric) {
    return {
      attrs: {},
      elapsed: Number(numeric[1]),
      duration: Number(numeric[2]),
      scte35: inheritedScte35
    };
  }
  const attrs = parseAttributeList(raw);
  return {
    attrs,
    elapsed: attrs.ELAPSEDTIME == null ? null : Number(attrs.ELAPSEDTIME),
    duration: attrs.DURATION == null ? null : Number(attrs.DURATION),
    scte35: attrs.SCTE35 ?? inheritedScte35
  };
}

function parseDaterange(attrs, inheritedScte35 = null) {
  const scte35 = attrs["SCTE35-OUT"] ?? attrs["SCTE35-IN"] ?? inheritedScte35;
  const isIn = Boolean(attrs["SCTE35-IN"]);
  const isOut = Boolean(attrs["SCTE35-OUT"]);
  return {
    type: isIn && !isOut ? "cue-in" : "cue-out",
    attrs,
    duration: attrs.DURATION == null ? null : Number(attrs.DURATION),
    scte35,
    id: attrs.ID || null
  };
}

export function extractSegments(playlist) {
  const lines = playlist.split(/\r?\n/);
  const segments = [];
  const operations = [];
  let pending = [];
  let duration = null;
  let start = 0;
  let inheritedScte35 = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      duration = Number(line.slice(8).split(",")[0]);
      continue;
    }

    const operation = cueOperation(line);
    if (operation) {
      if (operation.type === "scte35") {
        inheritedScte35 = operation.payload;
        pending.push({ ...operation, scte35: operation.payload });
      } else if (operation.type === "cue-out") {
        pending.push({ ...operation, ...parseCueOut(operation, inheritedScte35) });
      } else if (operation.type === "cue-out-cont") {
        pending.push({ ...operation, ...parseCueOutCont(operation, inheritedScte35) });
      } else if (operation.type === "daterange") {
        pending.push({ ...operation, ...parseDaterange(operation.attrs, inheritedScte35) });
      } else if (operation.type === "scte35-attr") {
        inheritedScte35 = operation.attrs.CUE || operation.attrs["SCTE35-OUT"] || inheritedScte35;
        pending.push({ ...operation, scte35: inheritedScte35 });
      } else {
        pending.push(operation);
      }
      continue;
    }

    if (line.startsWith("#") || duration == null) continue;

    const segment = {
      index: segments.length,
      start: round(start),
      duration: round(duration),
      end: round(start + duration),
      uri: line,
      cueTags: pending.map(item => item.type)
    };
    for (const item of pending) {
      operations.push({ ...item, time: segment.start, segmentIndex: segment.index });
    }
    segments.push(segment);
    start += duration;
    duration = null;
    pending = [];
  }

  const totalDuration = round(segments.reduce((sum, segment) => sum + segment.duration, 0));
  for (const item of pending) {
    operations.push({ ...item, time: totalDuration, segmentIndex: segments.length });
  }

  return { segments, operations, totalDuration };
}

function addDiagnostic(diagnostics, severity, code, message, details = {}) {
  diagnostics.push({ severity, code, message, ...details });
}

function segmentIndexAtBoundary(segments, time) {
  if (time <= EPSILON) return 0;
  for (const segment of segments) {
    if (time < segment.end - EPSILON) return segment.index;
    if (Math.abs(time - segment.end) <= EPSILON) return segment.index + 1;
  }
  return segments.length;
}

function returnsAtBoundary(segments, time) {
  if (time <= EPSILON) return true;
  if (Math.abs(time - segments[segments.length - 1]?.end) <= EPSILON) return true;
  return segments.some(segment => Math.abs(segment.start - time) <= EPSILON);
}

function normalizeOperations(operations) {
  const normalized = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.type === "scte35") {
      const previousOut = [...normalized].reverse().find(
        item => item.time === operation.time && item.type === "cue-out" && !item.scte35
      );
      if (previousOut) previousOut.scte35 = operation.payload;
      continue;
    }
    normalized.push(operation);
  }
  return normalized;
}

function finalizeCue(cue, totalDuration) {
  cue.start = round(cue.start);
  cue.end = round(Math.min(cue.end, totalDuration));
  cue.actualDuration = round(Math.max(0, cue.end - cue.start));
  cue.durationDelta = cue.declaredDuration == null
    ? null
    : round(cue.actualDuration - cue.declaredDuration);
  cue.declaredEnd = cue.declaredDuration == null
    ? null
    : round(cue.start + cue.declaredDuration);
  cue.returnSegmentIndex = cue.returnSegmentIndex ?? cue.endSegmentIndex;
  cue.closed = true;
  delete cue.endsAt;
  return cue;
}

export function buildCueModel(playlist, options = {}) {
  const source = options.source || "demo.m3u8";
  const { segments, operations, totalDuration } = extractSegments(playlist);
  const diagnostics = [];
  const cues = [];
  let active = null;
  let cueSequence = 0;
  let latestScte35 = null;

  const closeActive = (time, reason, segmentIndex) => {
    if (!active) return;
    active.end = time;
    active.endsAt = time;
    active.endReason = reason;
    active.endSegmentIndex = segmentIndex ?? segmentIndexAtBoundary(segments, time);
    active.returnSegmentIndex = active.endSegmentIndex;
    finalizeCue(active, totalDuration);
    active = null;
  };

  for (const operation of normalizeOperations(operations)) {
    if (operation.scte35) latestScte35 = operation.scte35;

    if (operation.type === "cue-out") {
      if (active) {
        addDiagnostic(
          diagnostics,
          "error",
          "CUE_OVERLAP",
          `${operation.time.toFixed(2)}s 出现新的 CUE-OUT，但 ${active.id} 尚未插回内容。`,
          { time: operation.time, cueId: active.id, conflictingCueId: `cue-${cueSequence + 1}` }
        );
        closeActive(operation.time, "overlap", operation.segmentIndex);
      }

      cueSequence += 1;
      const id = operation.id || `cue-${cueSequence}`;
      const startSegmentIndex = segmentIndexAtBoundary(segments, operation.time);
      active = {
        id,
        start: operation.time,
        end: operation.time,
        declaredDuration: Number.isFinite(operation.duration) ? operation.duration : null,
        startSegmentIndex,
        endSegmentIndex: startSegmentIndex,
        returnSegmentIndex: null,
        attrs: operation.attrs || {},
        scte35Out: operation.scte35 || latestScte35,
        scte35In: null,
        continuity: [],
        tagIndex: operation.segmentIndex,
        closed: false,
        endReason: null,
        inferred: false
      };
      cues.push(active);

      if (operation.time > totalDuration + EPSILON) {
        addDiagnostic(
          diagnostics,
          "error",
          "CUE_OUT_OF_BOUNDS",
          `${id} 的 CUE-OUT ${operation.time.toFixed(2)}s 超出媒体结尾 ${totalDuration.toFixed(2)}s。`,
          { time: operation.time, cueId: id }
        );
      }
      const projectedEnd = active.declaredDuration == null
        ? null
        : operation.time + active.declaredDuration;
      if (projectedEnd != null && projectedEnd > totalDuration + EPSILON) {
        addDiagnostic(
          diagnostics,
          "error",
          "CUE_OUT_OF_BOUNDS",
          `${id} 声明结束于 ${projectedEnd.toFixed(2)}s，超出媒体结尾 ${totalDuration.toFixed(2)}s。`,
          { time: projectedEnd, cueId: id }
        );
      }
      continue;
    }

    if (operation.type === "cue-out-cont") {
      if (!active) {
        addDiagnostic(
          diagnostics,
          "warning",
          "ORPHAN_CUE_CONT",
          `${operation.time.toFixed(2)}s 的 CUE-OUT-CONT 没有对应的进行中广告。`,
          { time: operation.time }
        );
        continue;
      }
      const elapsed = operation.elapsed ?? round(operation.time - active.start);
      active.continuity.push({
        time: operation.time,
        elapsed,
        duration: operation.duration,
        attrs: operation.attrs || {}
      });
      if (Math.abs(elapsed - (operation.time - active.start)) > 0.05) {
        addDiagnostic(
          diagnostics,
          "warning",
          "CUE_ELAPSED_MISMATCH",
          `${active.id} 的 CUE-OUT-CONT elapsed=${elapsed.toFixed(2)}s，与媒体时间偏差 ` +
            `${Math.abs(elapsed - (operation.time - active.start)).toFixed(2)}s。`,
          { time: operation.time, cueId: active.id }
        );
      }
      if (operation.duration != null && active.declaredDuration != null &&
          Math.abs(operation.duration - active.declaredDuration) > 0.05) {
        addDiagnostic(
          diagnostics,
          "warning",
          "CUE_CONT_DURATION_MISMATCH",
          `${active.id} 的 CUE-OUT-CONT duration=${operation.duration.toFixed(2)}s，` +
            `与 CUE-OUT 的 ${active.declaredDuration.toFixed(2)}s 不一致。`,
          { time: operation.time, cueId: active.id }
        );
      }
      continue;
    }

    if (operation.type === "cue-in") {
      if (!active) {
        addDiagnostic(
          diagnostics,
          "warning",
          "ORPHAN_CUE_IN",
          `${operation.time.toFixed(2)}s 的 CUE-IN 没有对应的进行中广告。`,
          { time: operation.time }
        );
        continue;
      }
      active.scte35In = operation.scte35 || operation.attrs?.["SCTE35-IN"] || null;
      if (!returnsAtBoundary(segments, operation.time)) {
        addDiagnostic(
          diagnostics,
          "warning",
          "RETURN_NOT_ON_SEGMENT_BOUNDARY",
          `${active.id} 的插回点 ${operation.time.toFixed(2)}s 未落在分片边界。`,
          { time: operation.time, cueId: active.id }
        );
      }
      closeActive(operation.time, "cue-in", operation.segmentIndex);
    }
  }

  if (active) {
    const declaredEnd = active.declaredDuration == null
      ? totalDuration
      : active.start + active.declaredDuration;
    const inferredEnd = Math.min(declaredEnd, totalDuration);
    addDiagnostic(
      diagnostics,
      "warning",
      "CUE_IN_MISSING",
      `${active.id} 缺少 CUE-IN，按声明时长推断在 ${inferredEnd.toFixed(2)}s 插回内容。`,
      { time: inferredEnd, cueId: active.id }
    );
    active.inferred = true;
    closeActive(inferredEnd, "inferred", segmentIndexAtBoundary(segments, inferredEnd));
  }

  for (const cue of cues) {
    if (cue.durationDelta != null && Math.abs(cue.durationDelta) > 0.05) {
      const direction = cue.durationDelta < 0 ? "早" : "晚";
      addDiagnostic(
        diagnostics,
        "warning",
        "CUE_DURATION_MISMATCH",
        `Cue ${cue.id} 声明 ${cue.declaredDuration.toFixed(2)}s，实际 ${cue.actualDuration.toFixed(2)}s；` +
          `CUE-IN 比声明${direction} ${Math.abs(cue.durationDelta).toFixed(2)}s。`,
        { time: cue.end, cueId: cue.id }
      );
    }
    cue.kind = cue.start <= EPSILON
      ? "pre-roll"
      : cue.end >= totalDuration - EPSILON
        ? "post-roll"
        : "mid-roll";
    cue.status = diagnostics.some(item => item.cueId === cue.id && item.severity === "error")
      ? "error"
      : diagnostics.some(item => item.cueId === cue.id && item.severity === "warning")
        ? "warning"
        : "ok";
  }

  const intervals = cues
    .map(cue => [cue.start, cue.end])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = 0;
  for (const [start, end] of intervals) {
    const from = Math.max(cursor, start);
    covered += Math.max(0, end - from);
    cursor = Math.max(cursor, end);
  }

  const errorCount = diagnostics.filter(item => item.severity === "error").length;
  const warningCount = diagnostics.filter(item => item.severity === "warning").length;
  return {
    source,
    segments,
    cues,
    diagnostics,
    totalDuration,
    summary: {
      segmentCount: segments.length,
      cueCount: cues.length,
      preRollCount: cues.filter(cue => cue.kind === "pre-roll").length,
      midRollCount: cues.filter(cue => cue.kind === "mid-roll").length,
      postRollCount: cues.filter(cue => cue.kind === "post-roll").length,
      adDuration: round(covered),
      contentDuration: round(Math.max(0, totalDuration - covered)),
      errors: errorCount,
      warnings: warningCount
    },
    checks: [
      {
        id: "overlap",
        label: "提示重叠",
        status: diagnostics.some(item => item.code === "CUE_OVERLAP") ? "fail" : "pass",
        detail: diagnostics.some(item => item.code === "CUE_OVERLAP")
          ? "存在未插回即再次 CUE-OUT 的广告。"
          : "所有广告区间互不重叠。"
      },
      {
        id: "bounds",
        label: "越界时间",
        status: diagnostics.some(item => item.code === "CUE_OUT_OF_BOUNDS") ? "fail" : "pass",
        detail: diagnostics.some(item => item.code === "CUE_OUT_OF_BOUNDS")
          ? "存在超出媒体时长的 cue。"
          : "所有 cue 均位于媒体时间轴内。"
      },
      {
        id: "return",
        label: "广告插回点",
        status: warningCount ? "warn" : "pass",
        detail: warningCount
          ? `${warningCount} 项插回告警，请核对时长偏差与分片边界。`
          : "所有广告均在分片边界完整插回内容。"
      }
    ]
  };
}

export function cueAtTime(model, mediaTime) {
  const time = Number(mediaTime);
  if (!Number.isFinite(time)) return null;
  return model.cues.find(cue => time >= cue.start - EPSILON && time < cue.end - EPSILON) || null;
}

export function segmentAtTime(model, mediaTime) {
  const time = Number(mediaTime);
  return model.segments.find(
    segment => time >= segment.start - EPSILON && time < segment.end - EPSILON
  ) || null;
}

export function cueForSegment(model, segmentIndex) {
  const segment = model.segments[segmentIndex];
  if (!segment) return null;
  return model.cues.find(
    cue => segment.start >= cue.start - EPSILON && segment.start < cue.end - EPSILON
  ) || null;
}

export function playbackState(model, mediaTime) {
  const time = Math.max(0, Number(mediaTime) || 0);
  const segment = segmentAtTime(model, time);
  const cue = cueAtTime(model, time);
  if (cue) {
    return {
      phase: "ad",
      label: `${cue.id} · AD`,
      cue,
      segment,
      elapsed: round(time - cue.start),
      remaining: round(cue.end - time)
    };
  }
  const nextCue = model.cues.find(item => item.start > time);
  const previousCue = [...model.cues].reverse().find(item => item.end <= time + EPSILON);
  return {
    phase: "content",
    label: previousCue ? "CONTENT · 已插回" : "CONTENT",
    cue: null,
    previousCue: previousCue || null,
    nextCue: nextCue || null,
    segment,
    elapsed: previousCue ? round(time - previousCue.end) : round(time),
    remaining: nextCue ? round(nextCue.start - time) : null
  };
}

export function toCueEventsJson(model, exportedAt = new Date().toISOString()) {
  return {
    source: model.source,
    exportedAt,
    summary: model.summary,
    totalDuration: model.totalDuration,
    cues: model.cues.map(cue => ({
      id: cue.id,
      start: cue.start,
      end: cue.end,
      declaredDuration: cue.declaredDuration,
      actualDuration: cue.actualDuration,
      durationDelta: cue.durationDelta,
      startSegmentIndex: cue.startSegmentIndex,
      endSegmentIndex: cue.endSegmentIndex,
      returnSegmentIndex: cue.returnSegmentIndex,
      attrs: cue.attrs,
      scte35Out: cue.scte35Out,
      scte35In: cue.scte35In,
      continuity: cue.continuity,
      tagIndex: cue.tagIndex,
      closed: cue.closed,
      endReason: cue.endReason,
      inferred: cue.inferred,
      kind: cue.kind,
      status: cue.status
    })),
    diagnostics: model.diagnostics,
    checks: model.checks
  };
}

export function toCsv(model) {
  const header = [
    "id", "kind", "start_media_s", "end_media_s", "actual_duration_s",
    "declared_duration_s", "delta_s", "start_segment", "end_segment",
    "return_segment", "scte35_out", "status"
  ];
  const lines = model.cues.map(cue => [
    cue.id,
    cue.kind,
    cue.start.toFixed(3),
    cue.end.toFixed(3),
    cue.actualDuration.toFixed(3),
    cue.declaredDuration == null ? "" : cue.declaredDuration.toFixed(3),
    cue.durationDelta == null ? "" : cue.durationDelta.toFixed(3),
    String(cue.startSegmentIndex),
    String(cue.endSegmentIndex),
    String(cue.returnSegmentIndex),
    cue.scte35Out || "",
    cue.status
  ]);
  return [header, ...lines]
    .map(row => row.map(value => `"${String(value).replaceAll("\"", "\"\"")}"`).join(","))
    .join("\n");
}

export function toMarkdown(model) {
  const header =
    "| ID | 类型 | CUE-OUT (s) | CUE-IN (s) | 实际时长 (s) | 声明时长 (s) | 偏差 (s) | 分片范围 | 插回分片 | 状态 |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = model.cues.map(cue => {
    const declared = cue.declaredDuration == null ? "—" : cue.declaredDuration.toFixed(2);
    const delta = cue.durationDelta == null ? "—" : cue.durationDelta.toFixed(2);
    const state = cue.status === "ok"
      ? "完整插回"
      : cue.status === "warning" ? `错位 ${Math.abs(cue.durationDelta || 0).toFixed(2)}s` : "错误";
    return `| ${cue.id} | ${cue.kind} | ${cue.start.toFixed(2)} | ${cue.end.toFixed(2)} | ` +
      `${cue.actualDuration.toFixed(2)} | ${declared} | ${delta} | ` +
      `${cue.startSegmentIndex}–${Math.max(cue.startSegmentIndex, cue.returnSegmentIndex - 1)} | ` +
      `#${cue.returnSegmentIndex} | ${state} |`;
  });
  const diagnostics = model.diagnostics.length
    ? model.diagnostics.map(item =>
      `- **${item.severity.toUpperCase()} ${item.code}**: ${item.message}`
    ).join("\n")
    : "- 无告警。";
  return [
    "# SCTE-35 广告事件表",
    "",
    `源清单：\`${model.source}\` · 媒体时长：${model.totalDuration.toFixed(2)}s · ` +
      `广告区间：${model.summary.adDuration.toFixed(2)}s`,
    "",
    header,
    ...rows,
    "",
    "## 校验结果",
    "",
    diagnostics
  ].join("\n");
}
