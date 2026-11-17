/* 样例验证：B 帧序列 + 人为打乱时间戳序列 */
"use strict";
const TsAnalyzer = require("./analyzer.js");
const TsSamples = require("./samples.js");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    (ok ? "PASS" : "FAIL") +
    "  " + name +
    "  期望=" + JSON.stringify(expected) +
    "  实际=" + JSON.stringify(actual)
  );
}

// ---------- 样例 1：IBBPBBP B 帧序列 ----------
const bframes = TsSamples.makeBFrameSample(3); // 10 个包
const r1 = TsAnalyzer.analyze(bframes);
console.log("== 样例1: B 帧序列 (I B B P 结构, " + bframes.length + " 包) ==");
check("重排窗口长度", r1.reorderWindow, 2);
check("首个非法时间戳包索引", r1.firstInvalidIndex, -1);
check("解码顺序合法", r1.decodeOrderOk, true);
check("展示顺序合法", r1.presentationOrderOk, true);
check("B 帧依赖后续参考帧(参考已就绪)", r1.summary.futureRefCount, 6);
check("无负时间", r1.summary.negativeCount, 0);
check("无重复时间戳", r1.summary.duplicateCount, 0);
check("无过大间隔", r1.summary.largeGapCount, 0);
check("P 帧非重排帧", r1.frames[1].reordered, false);
check("B 帧是重排帧", r1.frames[2].reordered, true);
check("B 帧前向参考为已解码的 P 帧", r1.frames[2].forwardRefIndex, 1);
check("B 帧参考帧未晚到", r1.frames[2].forwardRefLate, false);

// ---------- 样例 2：人为打乱时间戳 ----------
const shuffled = TsSamples.makeShuffledSample();
const r2 = TsAnalyzer.analyze(shuffled);
console.log("\n== 样例2: 人为打乱时间戳 (" + shuffled.length + " 包) ==");
check("首个非法时间戳包索引", r2.firstInvalidIndex, 4);
check("负时间帧数", r2.summary.negativeCount, 1);
check("负时间帧包索引", r2.frames[4].issues.includes("negative-time"), true);
check("重复 PTS 命中(包5)", r2.frames[5].issues.includes("duplicate-pts"), true);
check("重复 PTS 命中(包6)", r2.frames[6].issues.includes("duplicate-pts"), true);
check("DTS 回退命中(包8)", r2.frames[8].issues.includes("dts-non-monotonic"), true);
check("DTS 过大间隔命中(包10)", r2.frames[10].issues.includes("large-dts-gap"), true);
check("PTS 过大间隔存在", r2.summary.largeGapCount > 0, true);
check("解码顺序不合法", r2.decodeOrderOk, false);

// ---------- 样例 3：乱序 B 帧流的前向参考判定 ----------
// 解码顺序 I0 P4 B1 B2 P3：B1/B2 为重排帧，前向参考 P4 已提前解码
const T = TsSamples.TICK;
const lateRef = [
  { dts: 0, pts: 0 },         // I0
  { dts: 1 * T, pts: 4 * T }, // P4
  { dts: 2 * T, pts: 1 * T }, // B1
  { dts: 3 * T, pts: 2 * T }, // B2
  { dts: 4 * T, pts: 3 * T }  // P3
];
const r3 = TsAnalyzer.analyze(lateRef);
console.log("\n== 样例3: 乱序 B 帧流的前向参考判定 ==");
check("B1 依赖后续参考帧", r3.frames[2].dependsOnFuture, true);
check("B2 依赖后续参考帧", r3.frames[3].dependsOnFuture, true);
check("B1 前向参考为已解码的 P4", r3.frames[2].forwardRefIndex, 1);
check("B1 参考帧未晚到", r3.frames[2].forwardRefLate, false);
check("I/P 帧不标记为重排帧", r3.frames[1].reordered, false);

console.log("\n重排窗口长度(样例1): " + r1.reorderWindow);
console.log("首个非法时间戳包索引(样例2): " + r2.firstInvalidIndex);
console.log(failures ? "\n共 " + failures + " 项失败" : "\n全部通过");
process.exit(failures ? 1 : 0);
