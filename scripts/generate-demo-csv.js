"use strict";

const fs = require("node:fs");
const path = require("node:path");
const TimecodeMath = require("../timecode.js");
const MappingMath = require("../mapping.js");

require("../demo.js");
const demo = globalThis.SyncDemo;

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "artifacts");
const csvPath = path.join(outputDir, "sync-tc-29.97df-conversion-table.csv");
const reportPath = path.join(outputDir, "sync-tc-29.97df-report.json");

function rateLabel(domain) {
  return `${TimecodeMath.describeRate(domain.rate)} ${domain.dropFrame ? "DF" : "NDF"}`;
}

const parsed = MappingMath.parseSyncRows(demo.DEMO_SYNC_POINTS, demo.DEMO_DOMAINS);
if (parsed.points.length !== 3 || parsed.hasError) {
  throw new Error("Demo sync points are invalid");
}

const mappings = MappingMath.analyzeAllMappings(
  parsed.points,
  demo.DEMO_DOMAINS,
  MappingMath.DEFAULT_TOLERANCE_FRAMES
);
const conflictParsed = MappingMath.parseSyncRows(
  demo.CONFLICT_SYNC_POINTS,
  demo.DEMO_DOMAINS
);
const conflictMappings = MappingMath.analyzeAllMappings(
  conflictParsed.points,
  demo.DEMO_DOMAINS,
  MappingMath.DEFAULT_TOLERANCE_FRAMES
);
const rows = MappingMath.buildConversionTable({
  sourceKey: demo.DEMO_TABLE.sourceKey,
  startTimecode: demo.DEMO_TABLE.startTimecode,
  endTimecode: demo.DEMO_TABLE.endTimecode,
  stepSeconds: demo.DEMO_TABLE.stepSeconds,
  domains: demo.DEMO_DOMAINS,
  mappings
});

const selected = [
  mappings["camera->timeline"],
  mappings["audio->timeline"],
  mappings["camera->audio"]
];
const csv = MappingMath.conversionTableToCsv(rows, {
  title: "SYNC / TC · 29.97 DF 跨整点三点同步换算表",
  rates: {
    camera: rateLabel(demo.DEMO_DOMAINS.camera),
    audio: rateLabel(demo.DEMO_DOMAINS.audio),
    timeline: rateLabel(demo.DEMO_DOMAINS.timeline)
  },
  sourceKey: demo.DEMO_TABLE.sourceKey,
  notes: [
    ...selected.map((mapping) => `${mapping.sourceLabel} → ${mapping.targetLabel}：${mapping.equation}；漂移 ${mapping.driftPpm.toFixed(3)} ppm；RMS ${mapping.rmsFrames.toFixed(3)} 帧`),
    "实际帧率：29.97 = 30000/1001；DF 跳号不丢帧",
    "样片同步点：#1 CAM 00:59:50;00 / AUD 02:30:00;00 / TL 00:00:00;00；#2 CAM 01:29:50;06 / AUD 02:59:59;26 / TL 00:30:00;00；#3 CAM 01:59:50;13 / AUD 03:29:59;21 / TL 01:00:00;00"
  ]
});

const report = {
  generatedAt: new Date().toISOString(),
  sample: "29.97 fps drop-frame, three manual syncs across the top of the hour",
  domains: demo.DEMO_DOMAINS,
  syncPoints: demo.DEMO_SYNC_POINTS,
  table: {
    sourceKey: demo.DEMO_TABLE.sourceKey,
    startTimecode: demo.DEMO_TABLE.startTimecode,
    endTimecode: demo.DEMO_TABLE.endTimecode,
    stepSeconds: demo.DEMO_TABLE.stepSeconds,
    rowCount: rows.length
  },
  mappings: Object.fromEntries(
    Object.entries(mappings).map(([key, mapping]) => [
      key,
      {
        status: mapping.status,
        slope: mapping.slope,
        interceptSeconds: mapping.intercept,
        driftPpm: mapping.driftPpm,
        offsetTimecode: mapping.offsetTimecode,
        rmsFrames: mapping.rmsFrames,
        maxErrorFrames: mapping.maxErrorFrames,
        conflictPair: mapping.conflictPair
      }
    ])
  ),
  conflictExample: {
    syncPoints: demo.CONFLICT_SYNC_POINTS,
    cameraToTimeline: {
      status: conflictMappings["camera->timeline"].status,
      message: conflictMappings["camera->timeline"].message,
      conflictPair: conflictMappings["camera->timeline"].conflictPair,
      maxErrorFrames: conflictMappings["camera->timeline"].maxErrorFrames,
      residuals: conflictMappings["camera->timeline"].residuals.map((item) => ({
        pointNumber: item.pointNumber,
        inputTimecode: item.actualTimecode,
        errorFrames: item.errorFrames
      }))
    }
  }
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(csvPath, csv, "utf8");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Wrote ${rows.length} rows to ${path.relative(root, csvPath)}`);
console.log(`Wrote mapping report to ${path.relative(root, reportPath)}`);
