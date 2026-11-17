/* tools/validate.js — 用正常 / 倒序 / 截断 / 重复四组样本验证诊断与修复逻辑
 * 用法: node tools/validate.js
 * 输出: 控制台表格 + artifacts/validation-report.json；断言失败时退出码非 0。 */
'use strict';

const fs = require('fs');
const path = require('path');
const EBML = require('../webm-ebml.js');
const Repair = require('../webm-repair.js');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const ARTIFACTS = path.join(ROOT, 'artifacts');

function loadSet(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.webm'))
    .sort()
    .map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
}

const failures = [];

function check(condition, label) {
  if (!condition) failures.push(label);
  return condition;
}

function hasIssue(analysis, code) {
  return analysis.issues.some((i) => i.code === code);
}

function validateSet(setName, chunks) {
  const analysis = EBML.analyzeChunks(chunks);
  const { bytes, report } = Repair.repairChunks(chunks);
  const errors = analysis.issues.filter((i) => i.level === 'error');

  // 修复结果必须能被同一解析器重新解析，且 Cluster 时间码严格递增
  let reparsed = null;
  if (bytes) {
    reparsed = EBML.analyzeChunks([{ name: 'repaired.webm', bytes }]);
    const tcs = reparsed.clusters.map((c) => c.timecode);
    check(
      tcs.every((t, i) => i === 0 || t > tcs[i - 1]),
      `${setName}: 修复后 Cluster 时间码未严格递增: [${tcs}]`
    );
    check(
      reparsed.chunks[0].hasEbml,
      `${setName}: 修复后输出缺少 EBML 头`
    );
    check(
      !hasIssue(reparsed, 'truncated-element') && !hasIssue(reparsed, 'trailing-garbage'),
      `${setName}: 修复后仍存在截断/垃圾字节`
    );
  }

  return { setName, analysis, report, repairedBytes: bytes ? bytes.length : 0, errors };
}

/* ---------- 各样本集预期 ---------- */

function expectNormal(r) {
  check(r.errors.length === 0, `normal: 不应有 error 级问题, 实际: ${JSON.stringify(r.errors.map(e=>e.code))}`);
  check(r.report.timecodes.join(',') === '0,120,240,360,480',
    `normal: 时间码序列异常: [${r.report.timecodes}]`);
  check(r.report.outputBytes === r.report.inputBytes,
    `normal: 无需修复, 修复前后字节数应相等 (${r.report.inputBytes} != ${r.report.outputBytes})`);
}

function expectReversed(r) {
  check(hasIssue(r.analysis, 'missing-ebml-header'), 'reversed: 应报告 missing-ebml-header');
  check(hasIssue(r.analysis, 'cluster-out-of-order'), 'reversed: 应报告 cluster-out-of-order');
  const ooo = r.analysis.issues.find((i) => i.code === 'cluster-out-of-order');
  check(typeof ooo.offset === 'number' && ooo.offset >= 0, 'reversed: 乱序问题应带全局偏移');
  check(r.report.timecodes.join(',') === '0,120,240,360,480',
    `reversed: 修复后时间码应为升序, 实际 [${r.report.timecodes}]`);
  check(r.report.headerSourceChunk === 4,
    `reversed: EBML 头应来自第 5 个分片, 实际 #${r.report.headerSourceChunk}`);
  check(r.report.outputBytes === r.report.inputBytes,
    `reversed: 纯乱序修复不应改变总字节数 (${r.report.inputBytes} != ${r.report.outputBytes})`);
}

function expectTruncated(r) {
  const trunc = r.analysis.issues.find((i) => i.code === 'truncated-element');
  check(!!trunc, 'truncated: 应报告 truncated-element');
  if (trunc) {
    check(typeof trunc.offset === 'number' && trunc.offset > 0,
      'truncated: 截断问题应带全局偏移');
    check(trunc.declaredSize > trunc.available,
      'truncated: 声明尺寸应大于可用字节');
  }
  check(r.report.timecodes.join(',') === '0,120,240,360',
    `truncated: 修复后应丢弃末尾截断 Cluster, 实际 [${r.report.timecodes}]`);
  check(r.report.outputBytes < r.report.inputBytes,
    'truncated: 修复后字节数应小于修复前');
  check(r.report.clusters.some((c) => c.action === 'drop-truncated'),
    'truncated: 报告中应有 drop-truncated 动作');
}

function expectDuplicated(r) {
  const dup = r.analysis.issues.find((i) => i.code === 'duplicate-cluster');
  check(!!dup, 'duplicated: 应报告 duplicate-cluster');
  if (dup) {
    check(dup.timecode === 240, `duplicated: 重复时间码应为 240, 实际 ${dup.timecode}`);
    check(typeof dup.otherOffset === 'number', 'duplicated: 应给出另一处重复的全局偏移');
  }
  check(r.report.timecodes.join(',') === '0,120,240,360,480',
    `duplicated: 修复后应去重, 实际 [${r.report.timecodes}]`);
  check(r.report.clusters.filter((c) => c.action === 'drop-duplicate').length === 1,
    'duplicated: 报告中应有且仅有一个 drop-duplicate 动作');
}

/* ---------- 主流程 ---------- */

function main() {
  const sets = [
    ['normal', expectNormal],
    ['reversed', expectReversed],
    ['truncated', expectTruncated],
    ['duplicated', expectDuplicated],
  ];
  const results = [];

  for (const [setName, expectFn] of sets) {
    const chunks = loadSet(path.join(SAMPLES, setName));
    const r = validateSet(setName, chunks);
    expectFn(r);
    results.push(r);

    console.log(`\n### ${setName}`);
    console.log(`  修复前: ${r.report.inputBytes} 字节 -> 修复后: ${r.report.outputBytes} 字节`);
    console.log(`  Cluster 时间码(修复后): [${r.report.timecodes.join(', ')}]`);
    for (const issue of r.analysis.issues) {
      console.log(`  [${issue.level}] ${issue.code} @ ${EBML.hex(issue.offset)}`);
    }
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const reportJson = {
    generatedAt: new Date().toISOString(),
    sets: results.map((r) => ({
      name: r.setName,
      inputBytes: r.report.inputBytes,
      outputBytes: r.report.outputBytes,
      headerBytes: r.report.headerBytes,
      timecodes: r.report.timecodes,
      issues: r.analysis.issues,
      clusters: r.report.clusters,
      notes: r.report.notes,
    })),
    failures,
  };
  fs.writeFileSync(
    path.join(ARTIFACTS, 'validation-report.json'),
    JSON.stringify(reportJson, null, 2)
  );

  console.log('\n' + '='.repeat(48));
  if (failures.length) {
    console.error(`验证失败 ${failures.length} 项:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('全部断言通过，报告已写入 artifacts/validation-report.json');
}

main();
