/**
 * 代理媒体一致性检查引擎。
 * 输入原片、代理、时间线事件，输出结构化检查报告。
 */

import { framesToTC, msToFrames } from './timecode.js';

export const DEFAULT_TOLERANCES = {
  startFrameTolerance: 0,
  durationTolerance: 1,
  audioOffsetToleranceMs: 5,
  markerToleranceFrames: 0,
};

function issue(type, severity, proxy, original, field, expected, actual, message, extra = {}) {
  return {
    type,
    severity,
    proxyId: proxy?.id ?? null,
    clipName: proxy?.clipName ?? null,
    reelName: proxy?.reelName ?? original?.reelName ?? null,
    sourceId: original?.id ?? proxy?.sourceId ?? null,
    field,
    expected,
    actual,
    message,
    ...extra,
  };
}

/** 代理 -> 原片配对：优先 sourceId，回退到卷轴名 + 片段名约定 */
export function pairProxies(originals, proxies) {
  const byId = new Map(originals.map((src) => [src.id, src]));
  const byName = new Map(originals.map((src) => [`${src.reelName}/${src.clipName}`, src]));

  const pairs = [];
  const orphanProxies = [];

  for (const proxy of proxies) {
    let original = proxy.sourceId ? byId.get(proxy.sourceId) : undefined;
    let matchedBy = 'sourceId';
    if (!original) {
      const baseName = proxy.clipName.replace(/_P\d+$/, '');
      original = byName.get(`${proxy.reelName}/${baseName}`);
      matchedBy = original ? 'clipName' : 'none';
    }
    if (original) {
      pairs.push({ proxy, original, matchedBy });
    } else {
      orphanProxies.push(proxy);
    }
  }

  const pairedSourceIds = new Set(pairs.map((p) => p.original.id));
  const missingProxies = originals.filter((src) => !pairedSourceIds.has(src.id));
  return { pairs, orphanProxies, missingProxies };
}

function checkPair({ proxy, original, matchedBy }, tolerances) {
  const issues = [];

  if (matchedBy === 'clipName') {
    issues.push(issue(
      'mapping_weak', 'warning', proxy, original, 'sourceId',
      original.id, proxy.sourceId ?? null,
      `代理 ${proxy.clipName} 缺少 sourceId，仅能按命名约定回退映射到 ${original.clipName}`,
    ));
  }

  if (proxy.reelName !== original.reelName) {
    issues.push(issue(
      'reel_mismatch', 'critical', proxy, original, 'reelName',
      original.reelName, proxy.reelName,
      `卷轴名不符：期望 ${original.reelName}，实际 ${proxy.reelName}`,
    ));
  }

  const expectedBaseName = `${original.clipName}_P01`;
  if (!proxy.clipName.startsWith(original.clipName)) {
    issues.push(issue(
      'clipname_mismatch', 'critical', proxy, original, 'clipName',
      expectedBaseName, proxy.clipName,
      `片段名无法对应：代理 ${proxy.clipName} 未以原片名 ${original.clipName} 开头`,
    ));
  }

  if (Number(proxy.fps) !== Number(original.fps)) {
    issues.push(issue(
      'fps_mismatch', 'critical', proxy, original, 'fps',
      original.fps, proxy.fps,
      `帧率写错：应为 ${original.fps}fps，代理标注 ${proxy.fps}fps`,
      { deltaFramesPerSecond: Number(proxy.fps) - Number(original.fps) },
    ));
  }

  const startDelta = proxy.sourceStartFrame - original.sourceStartFrame;
  if (Math.abs(startDelta) > tolerances.startFrameTolerance) {
    const type = startDelta < 0 ? 'start_early' : 'start_late';
    issues.push(issue(
      type, 'critical', proxy, original, 'sourceStartFrame',
      original.sourceStartFrame, proxy.sourceStartFrame,
      (startDelta < 0
        ? `起始帧提前 ${Math.abs(startDelta)} 帧（${framesToTC(Math.abs(startDelta), original.fps)}）`
        : `起始帧延后 ${startDelta} 帧（${framesToTC(startDelta, original.fps)}）`),
      { deltaFrames: startDelta },
    ));
  }

  const durationDelta = proxy.totalFrames - original.totalFrames;
  if (Math.abs(durationDelta) > tolerances.durationTolerance) {
    issues.push(issue(
      'duration_mismatch', 'critical', proxy, original, 'totalFrames',
      original.totalFrames, proxy.totalFrames,
      `总帧数不符：相差 ${durationDelta > 0 ? '+' : ''}${durationDelta} 帧`
        + `（期望 ${original.totalFrames}，实际 ${proxy.totalFrames}）`,
      { deltaFrames: durationDelta },
    ));
  }

  const audioDelta = proxy.audioOffsetMs - original.audioOffsetMs;
  if (Math.abs(audioDelta) > tolerances.audioOffsetToleranceMs) {
    issues.push(issue(
      'audio_offset', 'critical', proxy, original, 'audioOffsetMs',
      original.audioOffsetMs, proxy.audioOffsetMs,
      `音频偏移错误：相差 ${audioDelta > 0 ? '+' : ''}${audioDelta}ms`
        + `（约 ${msToFrames(audioDelta, original.fps)} 帧，期望 ${original.audioOffsetMs}ms，实际 ${proxy.audioOffsetMs}ms）`,
      { deltaMs: audioDelta, deltaFrames: msToFrames(audioDelta, original.fps) },
    ));
  }

  return issues;
}

/** 标记点交叉验证：同名标记在原片与代理上的源帧号必须对齐 */
function checkMarkers({ proxy, original }, tolerances) {
  const issues = [];
  const proxyMarkers = new Map(proxy.markers.map((m) => [m.name, m.frame]));
  const originalMarkers = new Map(original.markers.map((m) => [m.name, m.frame]));
  const markerResults = [];

  for (const [name, originalFrame] of originalMarkers) {
    if (!proxyMarkers.has(name)) {
      markerResults.push({ name, originalFrame, proxyFrame: null, delta: null, status: 'missing' });
      issues.push(issue(
        'marker_missing', 'major', proxy, original, `markers.${name}`,
        originalFrame, null,
        `代理缺少标记点 ${name}（原片位于帧 ${originalFrame}）`,
        { markerName: name },
      ));
      continue;
    }
    const proxyFrame = proxyMarkers.get(name);
    const delta = proxyFrame - originalFrame;
    const status = Math.abs(delta) <= tolerances.markerToleranceFrames ? 'ok' : 'drift';
    markerResults.push({ name, originalFrame, proxyFrame, delta, status });
    if (status === 'drift') {
      issues.push(issue(
        'marker_drift', 'major', proxy, original, `markers.${name}`,
        originalFrame, proxyFrame,
        `标记点 ${name} 漂移 ${delta > 0 ? '+' : ''}${delta} 帧`
          + `（原片 ${framesToTC(originalFrame, original.fps)} / 代理 ${framesToTC(proxyFrame, original.fps)}）`,
        { markerName: name, deltaFrames: delta },
      ));
    }
  }

  for (const [name, proxyFrame] of proxyMarkers) {
    if (!originalMarkers.has(name)) {
      markerResults.push({ name, originalFrame: null, proxyFrame, delta: null, status: 'unexpected' });
      issues.push(issue(
        'marker_unexpected', 'minor', proxy, original, `markers.${name}`,
        null, proxyFrame,
        `代理存在原片没有的标记点 ${name}（帧 ${proxyFrame}）`,
        { markerName: name },
      ));
    }
  }

  return { issues, markerResults };
}

export { checkPair, checkMarkers };

/**
 * 校验剪辑时间线：每条事件引用的代理必须能映射回原片，
 * 且事件的源入/出点必须落在原片可用范围内。
 */
function checkTimeline(events, pairs, orphanProxies) {
  const issues = [];
  const results = [];
  const pairByProxyId = new Map(pairs.map((p) => [p.proxy.id, p]));
  const orphanIds = new Set(orphanProxies.map((p) => p.id));

  for (const event of events) {
    const pair = pairByProxyId.get(event.proxyId);
    if (!pair) {
      const reason = orphanIds.has(event.proxyId)
        ? '代理无法映射回原片'
        : '时间线引用了不存在的代理片段';
      issues.push({
        type: 'timeline_unmapped',
        severity: 'critical',
        proxyId: event.proxyId,
        clipName: null,
        reelName: null,
        sourceId: null,
        field: 'proxyId',
        expected: '可映射的代理 ID',
        actual: event.proxyId,
        message: `时间线事件 ${event.id} 映射失败：${reason}`,
        timelineEventId: event.id,
      });
      results.push({ event, status: 'unmapped' });
      continue;
    }

    const { proxy, original } = pair;
    const sourceEnd = original.sourceStartFrame + original.totalFrames;
    const outOfBounds =
      event.sourceInFrame < original.sourceStartFrame
      || event.sourceOutFrame > sourceEnd
      || event.sourceInFrame >= event.sourceOutFrame;

    if (outOfBounds) {
      issues.push({
        type: 'timeline_out_of_bounds',
        severity: 'critical',
        proxyId: proxy.id,
        clipName: proxy.clipName,
        reelName: proxy.reelName,
        sourceId: original.id,
        field: 'sourceInFrame/sourceOutFrame',
        expected: `[${original.sourceStartFrame}, ${sourceEnd})`,
        actual: `[${event.sourceInFrame}, ${event.sourceOutFrame})`,
        message: `时间线事件 ${event.id} 的源入/出点超出原片 ${original.clipName} 可用范围`,
        timelineEventId: event.id,
      });
      results.push({ event, pair, status: 'out_of_bounds' });
    } else {
      results.push({ event, pair, status: 'ok' });
    }
  }
  return { issues, results };
}

/**
 * 执行完整一致性检查。
 * @returns 结构化报告，供界面、映射表导出与测试共同消费。
 */
export function runConsistencyCheck(originals, proxies, events, tolerances = DEFAULT_TOLERANCES) {
  const settings = { ...DEFAULT_TOLERANCES, ...tolerances };
  const { pairs, orphanProxies, missingProxies } = pairProxies(originals, proxies);
  const issues = [];
  const clipReports = [];

  for (const pair of pairs) {
    const fieldIssues = checkPair(pair, settings);
    const { issues: markerIssues, markerResults } = checkMarkers(pair, settings);
    const allIssues = [...fieldIssues, ...markerIssues];
    issues.push(...allIssues);
    clipReports.push({
      proxyId: pair.proxy.id,
      sourceId: pair.original.id,
      reelName: pair.proxy.reelName,
      clipName: pair.proxy.clipName,
      matchedBy: pair.matchedBy,
      proxy: pair.proxy,
      original: pair.original,
      markers: markerResults,
      issues: allIssues,
      status: allIssues.some((i) => i.severity === 'critical') ? 'critical'
        : allIssues.length ? 'warning' : 'ok',
    });
  }

  for (const proxy of orphanProxies) {
    const item = issue(
      'unlinked_proxy', 'critical', proxy, null, 'sourceId',
      '可匹配的原片', null,
      `代理 ${proxy.clipName}（${proxy.reelName}）无法映射回任何原片，替换前必须人工处理`,
    );
    issues.push(item);
    clipReports.push({
      proxyId: proxy.id,
      sourceId: null,
      reelName: proxy.reelName,
      clipName: proxy.clipName,
      matchedBy: 'none',
      proxy,
      original: null,
      markers: [],
      issues: [item],
      status: 'critical',
    });
  }

  for (const original of missingProxies) {
    issues.push({
      type: 'missing_proxy',
      severity: 'major',
      proxyId: null,
      clipName: original.clipName,
      reelName: original.reelName,
      sourceId: original.id,
      field: 'proxy',
      expected: '对应代理片段',
      actual: null,
      message: `原片 ${original.clipName} 缺少转码代理`,
    });
  }

  const timeline = checkTimeline(events, pairs, orphanProxies);
  issues.push(...timeline.issues);

  const severityRank = { critical: 3, major: 2, minor: 1, warning: 1 };
  const summary = {
    totalOriginal: originals.length,
    totalProxy: proxies.length,
    paired: pairs.length,
    orphanProxies: orphanProxies.length,
    missingProxies: missingProxies.length,
    timelineEvents: events.length,
    timelineUnmapped: timeline.results.filter((r) => r.status !== 'ok').length,
    issueCount: issues.length,
    criticalCount: issues.filter((i) => i.severity === 'critical').length,
    byType: issues.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {}),
    worstSeverity: issues.reduce((worst, item) =>
      Math.max(worst, severityRank[item.severity] || 0), 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    tolerances: settings,
    summary,
    issues: issues.sort((a, b) =>
      (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)),
    clipReports,
    timeline: timeline.results,
  };
}
