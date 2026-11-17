"use strict";

var VFA = require("../js/util.js");
global.window = undefined;
var Metrics = require("../js/metrics.js");
var Detect = require("../js/detect.js");
var Evaluate = require("../js/evaluate.js");
var Review = require("../js/review.js");
var synth = require("./synth.js");

var passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
}

var clip = synth.buildClip();
var pairs = Metrics.buildPairs(clip.frames, 16, 9);
assert(pairs.length === clip.frames.length - 1, "帧对数量 = 取样帧数 - 1");

var cfg = Object.assign({}, VFA.PRESETS.standard, { minDuration: 0.3 });
var result = Detect.detect(clip.frames, pairs.map(function (p) {
  return Object.assign({}, p, { blockDiffs: p.blockDiffs });
}), cfg);

console.log("\n候选区间：");
result.intervals.forEach(function (c) {
  console.log("  " + c.t0.toFixed(1) + "-" + c.t1.toFixed(1) +
    "s [" + c.status + "/" + c.confidence + "] " + c.reason);
});

/* 1. 两个已知冻结窗口都被检出。 */
var gt = {
  freezes: [
    { t0: 5.2, t1: 7.0 },
    { t0: 10.8, t1: 12.2 }
  ]
};
var evalStd = Evaluate.evaluate(result.intervals, gt, 0.3);
assert(evalStd.detected === 2, "两个已知冻结区间均被检出");
assert(evalStd.misses.length === 0, "无漏检");

/* 2. 正常静物段只能是 uncertain，不允许 freeze。 */
var stillCand = result.intervals.filter(function (c) {
  return c.t0 < 0.5;
});
assert(stillCand.length >= 1, "静物段产生候选（供人工确认）");
assert(stillCand.every(function (c) { return c.status === "uncertain"; }),
  "正常静物只标记为 uncertain，不直接认定播放故障");

/* 3. 运动中冻结被判为 freeze 且置信度 high。 */
var motionFreeze = result.intervals.find(function (c) {
  return c.t0 <= 5.3 && c.t1 >= 6.9;
});
assert(!!motionFreeze, "运动段冻结区间存在");
assert(motionFreeze && motionFreeze.status === "freeze" &&
  motionFreeze.confidence === "high", "运动中重复帧判为高置信度 freeze");

/* 4. 边界误差在容差内。 */
var motionMatch = evalStd.matches.find(function (m) {
  return m.truth.t0 === 5.2;
});
assert(!!motionMatch && motionMatch.startError <= 0.3 &&
  motionMatch.endError <= 0.3, "区间边界误差 <= 0.3s 容差");

/* 5. 低光段：实时噪声窗口不允许出现 freeze 候选（允许 motion 或 uncertain）；
      连同噪声一起停止的冻结窗口必须带 lowlight 标记。 */
var lowCand = result.intervals.filter(function (c) { return c.lowlight; });
assert(lowCand.length >= 1, "低光区间带 lowlight 证据标记");
var liveWindowFreeze = result.intervals.some(function (c) {
  return c.t0 < 10.8 && c.t1 > 8.5 && c.status === "freeze";
});
assert(!liveWindowFreeze, "低光实时噪声窗口没有 freeze 误报");
var noiseStateSeen = result.pairStates.some(function (ps) {
  return ps.state === "noise";
});
var motionStateSeen = result.pairStates.some(function (ps) {
  return ps.lowlight && ps.state === "motion";
});
assert(noiseStateSeen || motionStateSeen,
  "低光实时变化被识别为 noise/motion 而非冻结帧对");

/* 6. 周期运动折返点不产生高置信度 freeze。 */
var periodicBad = result.intervals.some(function (c) {
  return c.t0 >= 12.6 && c.status === "freeze" && c.confidence === "high";
});
assert(!periodicBad, "周期运动段没有高置信度误报");

/* 6b. detectTurns 应识别出周期段的规律性凹点（周期约 2s，含半周期凹点）。 */
var turns = Detect.detectTurns(pairs, clip.frames, cfg);
assert(turns && turns.pairIndexes.length >= 3,
  "折返点检测识别出至少 3 个规律凹点");
assert(turns && turns.cv <= 0.2, "折返点间隔变异系数 <= 0.2");
assert(turns && turns.periodSeconds >= 0.5 && turns.periodSeconds <= 2.5,
  "折返间隔落在 0.5–2.5s 的合理范围");

/* 6c. 静物段（全 0 指标）不应被误判为周期运动。 */
var stillOnlyPairs = pairs.slice(0, 40).map(function (p) {
  return Object.assign({}, p, { blockDiffs: p.blockDiffs });
});
var stillFrames = clip.frames.slice(0, 41);
assert(Detect.detectTurns(stillOnlyPairs, stillFrames, cfg) === null,
  "纯静物段不产生折返点判定");

/* 7. 三档阈值扫描：宽松/标准/严格的检出与误报对比可计算。 */
var sweep = Evaluate.sweep(clip.frames, pairs, VFA.PRESETS, 0.3, gt);
assert(sweep.length === 3, "阈值扫描返回 3 种预设结果");
sweep.forEach(function (row) {
  assert(row.metrics && typeof row.metrics.recall === "number" &&
    typeof row.metrics.precision === "number",
    row.label + "预设输出精确率/召回率");
});

/* 8. 严格预设漏检不少于标准（阈值更严，更易漏），宽松强误报不少于严格。 */
var byName = {};
sweep.forEach(function (r) { byName[r.preset] = r; });
assert(byName.strict.metrics.detected <= byName.standard.metrics.detected,
  "严格预设检出数不超过标准预设");
assert(byName.loose.metrics.strongFalseAlarms.length >=
  byName.strict.metrics.strongFalseAlarms.length,
  "宽松预设强误报不少于严格预设");

/* 9. 人工标注保护：先确认一个候选，再用不同阈值重算，决定不被覆盖。 */
var store = Review.createStore();
var target = byName.standard.intervals.find(function (c) {
  return c.t0 <= 5.3 && c.t1 >= 6.9;
});
Review.upsertFromCandidate(store, target, "confirmed", "人工核实：确实卡帧");

var appliedLoose = Review.applyToCandidates(store, byName.loose.intervals);
var matched = appliedLoose.merged.find(function (c) {
  return c.reviewStatus === "confirmed";
});
assert(!!matched, "切换到宽松阈值后，已确认标注仍挂载在对应候选上");
assert(matched && matched.annotation.note === "人工核实：确实卡帧",
  "人工备注在阈值重算后保留");

/* 严格预设若该窗口没被检出，标注应作为孤儿保留，而不是丢失。 */
var appliedStrict = Review.applyToCandidates(store, byName.strict.intervals);
var stillThere = appliedStrict.merged.some(function (c) {
  return c.reviewStatus === "confirmed";
}) || appliedStrict.orphans.some(function (a) {
  return a.decision === "confirmed";
});
assert(stillThere, "严格阈值漏检时，人工确认以孤儿标注保留且不被覆盖");

/* 10. 排除标注同样受保护。 */
var stillTarget = byName.standard.intervals.find(function (c) { return c.t0 < 0.5; });
if (stillTarget) {
  Review.upsertFromCandidate(store, stillTarget, "excluded", "正常静物镜头");
  var again = Review.applyToCandidates(store, byName.loose.intervals);
  var excluded = again.merged.find(function (c) {
    return c.reviewStatus === "excluded";
  }) || again.orphans.some(function (a) {
    return a.decision === "excluded";
  });
  assert(!!excluded, "排除标注在阈值重算后保留");
}

/* 11. 修订记录导入导出往返。 */
var exported = Review.toAnnotationJSON(store);
var store2 = Review.createStore();
Review.loadAnnotationJSON(store2, JSON.parse(exported));
assert(store2.annotations.length === store.annotations.length,
  "修订记录 JSON 往返后条数一致");
assert(store2.annotations.every(function (a) {
  return a.decision === "confirmed" || a.decision === "excluded";
}), "导入标注的决定字段完整");

/* 12. CSV 转义。 */
var csv = Review.toCSV(appliedLoose.merged);
assert(csv.split("\n")[0].indexOf("start_s") > 0, "CSV 含表头");
assert(csv.split("\n").length === appliedLoose.merged.length + 1,
  "CSV 行数与候选数一致");

console.log("\n结果：" + passed + " 通过, " + failed + " 失败");
process.exit(failed ? 1 : 0);
