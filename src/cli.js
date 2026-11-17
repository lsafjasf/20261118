/**
 * 命令行入口：运行一致性检查并把“代理替换前映射表”写入 reports/。
 * 用法：
 *   node src/cli.js                # 默认启用必选故障（帧率/音频）
 *   node src/cli.js --all          # 启用全部预置故障
 *   node src/cli.js --clean        # 干净基线，不注入任何故障
 *   node src/cli.js F_FPS_WRONG F_AUDIO_OFFSET
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORIGINALS, TIMELINE_EVENTS } from './core/data.js';
import { buildFaultyProxies, FAULT_LIBRARY, defaultEnabledFaultIds } from './core/faults.js';
import { runConsistencyCheck } from './core/checker.js';
import { buildMappingRows, toCSV, toJSON } from './core/mapping.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

let enabledIds;
if (args.includes('--clean')) {
  enabledIds = [];
} else if (args.includes('--all')) {
  enabledIds = FAULT_LIBRARY.map((f) => f.id);
} else {
  const explicit = args.filter((a) => !a.startsWith('--'));
  enabledIds = explicit.length ? explicit : defaultEnabledFaultIds();
}

const { proxies, appliedFaultIds } = buildFaultyProxies(enabledIds);
const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
const rows = buildMappingRows(report);
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

const reportDir = join(root, 'reports');
await mkdir(reportDir, { recursive: true });
const csvPath = join(reportDir, `proxy-mapping-pre-conform-${stamp}.csv`);
const jsonPath = join(reportDir, `proxy-mapping-pre-conform-${stamp}.json`);
await writeFile(csvPath, toCSV(rows), 'utf8');
await writeFile(jsonPath, toJSON(report, rows), 'utf8');

console.log('=== 代理媒体一致性检查 ===');
console.log(`注入故障: ${appliedFaultIds.length ? appliedFaultIds.join(', ') : '（无，干净基线）'}`);
console.log(`原片 ${report.summary.totalOriginal} / 代理 ${report.summary.totalProxy} / 配对 ${report.summary.paired}`);
console.log(`问题总数 ${report.summary.issueCount}（严重 ${report.summary.criticalCount}）`);
for (const item of report.issues) {
  console.log(`  [${item.severity}] ${item.proxyId ?? '-'} ${item.type}: ${item.message}`);
}
console.log(`\n映射表已导出（代理替换前）:\n  ${csvPath}\n  ${jsonPath}`);

process.exitCode = report.summary.criticalCount > 0 ? 1 : 0;
