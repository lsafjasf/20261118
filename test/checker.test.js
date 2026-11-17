import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ORIGINALS, TIMELINE_EVENTS } from '../src/core/data.js';
import { buildBaselineProxies } from '../src/core/data.js';
import { buildFaultyProxies, FAULT_LIBRARY } from '../src/core/faults.js';
import { runConsistencyCheck, pairProxies } from '../src/core/checker.js';
import { tcToFrames, framesToTC, msToFrames } from '../src/core/timecode.js';
import { buildMappingRows, toCSV, toJSON } from '../src/core/mapping.js';

test('时间码与帧号互转（24fps）', () => {
  assert.equal(tcToFrames('01:00:00:00', 24), 86400);
  assert.equal(framesToTC(86400, 24), '01:00:00:00');
  assert.equal(tcToFrames('00:00:10:00', 24), 240);
  assert.equal(framesToTC(240, 24), '00:00:10:00');
});

test('29.97 丢帧时间码使用分号且往返一致', () => {
  const frames = tcToFrames('00:01:00;02', 29.97);
  assert.equal(framesToTC(frames, 29.97), '00:01:00;02');
});

test('毫秒音频偏移换算为帧', () => {
  assert.equal(msToFrames(1000, 24), 24);
  assert.equal(msToFrames(120, 24), 3);
});

test('干净基线：全部片段配对且零问题', () => {
  const proxies = buildBaselineProxies();
  const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
  assert.equal(report.summary.paired, ORIGINALS.length);
  assert.equal(report.summary.orphanProxies, 0);
  assert.equal(report.summary.issueCount, 0);
  assert.equal(report.summary.criticalCount, 0);
  assert.equal(report.summary.timelineUnmapped, 0);
});

test('帧率写错被识别为 fps_mismatch 并定位到 P003', () => {
  const { proxies } = buildFaultyProxies(['F_FPS_WRONG']);
  const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
  const hit = report.issues.find((i) => i.type === 'fps_mismatch');
  assert.ok(hit);
  assert.equal(hit.proxyId, 'P003');
  assert.equal(hit.expected, 24);
  assert.equal(hit.actual, 25);
  const clip = report.clipReports.find((c) => c.proxyId === 'P003');
  assert.equal(clip.status, 'critical');
});

test('音频偏移错误被识别并量化到帧', () => {
  const { proxies } = buildFaultyProxies(['F_AUDIO_OFFSET']);
  const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
  const hit = report.issues.find((i) => i.type === 'audio_offset');
  assert.ok(hit);
  assert.equal(hit.proxyId, 'P009');
  assert.equal(hit.deltaMs, 120);
  assert.equal(hit.deltaFrames, 3);
});

test('起始帧提前与延后分别归类', () => {
  const early = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(['F_EARLY_START']).proxies, [],
  );
  assert.equal(early.issues[0].type, 'start_early');
  assert.equal(early.issues[0].deltaFrames, -6);

  const late = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(['F_LATE_START']).proxies, [],
  );
  assert.equal(late.issues[0].type, 'start_late');
  assert.equal(late.issues[0].deltaFrames, 8);
});

test('总帧数不符被识别', () => {
  const report = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(['F_DURATION_MISMATCH']).proxies, [],
  );
  const hit = report.issues.find((i) => i.type === 'duration_mismatch');
  assert.equal(hit.proxyId, 'P011');
  assert.equal(hit.deltaFrames, -120);
});

test('标记点交叉验证发现漂移与缺失', () => {
  const report = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(['F_MARKER_DRIFT']).proxies, [],
  );
  const hit = report.issues.find((i) => i.type === 'marker_drift');
  assert.equal(hit.markerName, 'ACTION');
  assert.equal(hit.deltaFrames, 12);
  const clip = report.clipReports.find((c) => c.proxyId === 'P006');
  assert.deepEqual(
    clip.markers.find((m) => m.name === 'ACTION'),
    { name: 'ACTION', originalFrame: 100600, proxyFrame: 100612, delta: 12, status: 'drift' },
  );
});

test('sourceId 丢失时代理无法映射并被时间线检查捕获', () => {
  const { proxies } = buildFaultyProxies(['F_UNLINKED']);
  const { orphanProxies, pairs } = pairProxies(ORIGINALS, proxies);
  assert.equal(orphanProxies.length, 1);
  assert.equal(orphanProxies[0].id, 'P014');
  assert.equal(pairs.length, ORIGINALS.length - 1);
  const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
  assert.ok(report.issues.some((i) => i.type === 'unlinked_proxy'));
});

test('全部故障同时注入时问题类型覆盖完整', () => {
  const allIds = FAULT_LIBRARY.map((f) => f.id);
  const report = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(allIds).proxies, TIMELINE_EVENTS,
  );
  const types = new Set(report.issues.map((i) => i.type));
  for (const expected of [
    'fps_mismatch', 'audio_offset', 'start_early', 'start_late',
    'duration_mismatch', 'marker_drift', 'unlinked_proxy',
  ]) {
    assert.ok(types.has(expected), `缺少问题类型 ${expected}`);
  }
  assert.ok(report.summary.criticalCount >= 6);
});

test('映射表导出包含替换前全部代理且 CSV/JSON 可解析', () => {
  const report = runConsistencyCheck(
    ORIGINALS, buildFaultyProxies(['F_FPS_WRONG', 'F_AUDIO_OFFSET']).proxies, TIMELINE_EVENTS,
  );
  const rows = buildMappingRows(report);
  assert.equal(rows.length, ORIGINALS.length);
  const csv = toCSV(rows);
  const header = csv.split('\r\n')[0].replace(/^﻿/, '');
  assert.ok(header.includes('proxyClipName') && header.includes('issueTypes'));
  const parsed = JSON.parse(toJSON(report, rows));
  assert.equal(parsed.stage, 'PRE_CONFORM_MAPPING');
  assert.equal(parsed.mapping.length, ORIGINALS.length);
});

test('时间线越界事件被拦截', () => {
  const proxies = buildBaselineProxies();
  const badEvents = [
    { id: 'EBAD', proxyId: 'P001', track: 'V1', sourceInFrame: 1, sourceOutFrame: 100 },
  ];
  const report = runConsistencyCheck(ORIGINALS, proxies, badEvents);
  assert.equal(report.issues[0].type, 'timeline_out_of_bounds');
  assert.equal(report.issues[0].timelineEventId, 'EBAD');
});
