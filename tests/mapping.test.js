"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TC = require("../timecode.js");
const MAP = require("../mapping.js");

require("../demo.js");
const DEMO = globalThis.SyncDemo;

function analyzeDemoRows(rows) {
  const parsed = MAP.parseSyncRows(rows, DEMO.DEMO_DOMAINS);
  const mappings = MAP.analyzeAllMappings(parsed.points, DEMO.DEMO_DOMAINS, 1);
  return { parsed, mappings };
}

test("three manual syncs across an hour fit one affine mapping", () => {
  const { parsed, mappings } = analyzeDemoRows(DEMO.DEMO_SYNC_POINTS);
  assert.equal(parsed.points.length, 3);
  assert.deepEqual(parsed.rowErrors, {});

  const cameraToTimeline = mappings["camera->timeline"];
  const audioToTimeline = mappings["audio->timeline"];
  assert.equal(cameraToTimeline.status, "consistent");
  assert.equal(audioToTimeline.status, "consistent");
  assert.ok(Math.abs(cameraToTimeline.driftPpm + 120.4764) < 0.01);
  assert.ok(Math.abs(audioToTimeline.driftPpm - 83.4237) < 0.01);
  assert.ok(cameraToTimeline.maxErrorFrames < 1);
  assert.ok(audioToTimeline.maxErrorFrames < 1);
  assert.equal(cameraToTimeline.conflictPair.length, 0);
});

test("mapping converts each manual sync back within one frame", () => {
  const { mappings } = analyzeDemoRows(DEMO.DEMO_SYNC_POINTS);
  const rows = [
    ["camera", "00:59:50;00", "timeline", "00:00:00;00"],
    ["camera", "01:29:50;06", "timeline", "00:30:00;00"],
    ["camera", "01:59:50;13", "timeline", "01:00:00;00"],
    ["audio", "02:30:00;00", "timeline", "00:00:00;00"],
    ["audio", "02:59:59;26", "timeline", "00:30:00;00"],
    ["audio", "03:29:59;21", "timeline", "01:00:00;00"]
  ];

  rows.forEach(([source, sourceTc, target, targetTc]) => {
    const result = MAP.convertTimecode(sourceTc, source, target, DEMO.DEMO_DOMAINS, mappings);
    const actualFrames = TC.timecodeToFrames(targetTc, DEMO.DEMO_DOMAINS[target]);
    assert.ok(
      Math.abs(result.targetFrames - actualFrames) <= 1,
      `${sourceTc} -> ${targetTc}, got ${result.targetTimecode}`
    );
  });
});

test("conflicting syncs name the two points that cannot both fit", () => {
  const { mappings } = analyzeDemoRows(DEMO.CONFLICT_SYNC_POINTS);
  const cameraToTimeline = mappings["camera->timeline"];
  assert.equal(cameraToTimeline.status, "conflict");
  assert.equal(cameraToTimeline.conflict, true);
  assert.deepEqual(cameraToTimeline.conflictPair, [2, 3]);
  assert.match(cameraToTimeline.message, /同步点 #2 与 #3/);
  assert.ok(cameraToTimeline.maxErrorFrames > 1);
  assert.ok(cameraToTimeline.conflicts.length >= 1);
});

test("conversion table spans the hour and exports CSV rows", () => {
  const { mappings } = analyzeDemoRows(DEMO.DEMO_SYNC_POINTS);
  const rows = MAP.buildConversionTable({
    sourceKey: "timeline",
    startTimecode: "00:00:00;00",
    endTimecode: "01:00:00;00",
    stepSeconds: 60,
    domains: DEMO.DEMO_DOMAINS,
    mappings
  });
  assert.equal(rows.length, 61);
  assert.equal(rows[0].domains.camera.timecode, "00:59:50;00");
  assert.equal(rows.at(-1).domains.camera.timecode, "01:59:50;13");
  assert.equal(rows.at(-1).domains.timeline.timecode, "01:00:00;00");

  const csv = MAP.conversionTableToCsv(rows, {
    title: "test",
    sourceKey: "timeline",
    rates: { camera: "29.97 DF", audio: "29.97 DF", timeline: "29.97 DF" }
  });
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /基准时间码/);
  assert.match(csv, /00:59:50;00/);
  assert.equal(csv.trimEnd().split("\n").length, 65);
});

test("two-point line survives inverse and direct conversion", () => {
  const points = MAP.parseSyncRows(DEMO.DEMO_SYNC_POINTS.slice(0, 2), DEMO.DEMO_DOMAINS).points;
  const forward = MAP.analyzeMapping(points, "camera", "audio", DEMO.DEMO_DOMAINS, 1);
  const inverse = MAP.invertMapping(forward);
  const sample = points[0].camera.seconds + 123.456;
  const mapped = MAP.applyMapping(forward, sample);
  assert.ok(Math.abs(MAP.applyMapping(inverse, mapped) - sample) < 1e-9);
});
