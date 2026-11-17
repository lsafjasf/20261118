/*
 * 验证脚本: 用两组网络轨迹运行 ABR 仿真,
 * 输出切换次数、起播时间、卡顿时长, 并做基本断言。
 * 运行: node validate.js
 */
'use strict';
var ABR = require('./abr.js');
var TRACES = require('./traces.js');

function fmt(v, unit) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(2) + unit : 'N/A';
}

function run(name, trace) {
  var r = ABR.simulate(trace, { numSegments: 60 });
  console.log('=== ' + name + ' ===');
  console.log('  切换次数:   ' + r.switches + ' (升 ' + r.ups + ' / 降 ' + r.downs + ')');
  console.log('  起播时间:   ' + fmt(r.startupDelay, ' s'));
  console.log('  卡顿时长:   ' + fmt(r.stallDuration, ' s') + ' (' + r.stallEvents + ' 次)');
  console.log('  完成片段:   ' + r.segments + '/60, 最终档位: ' +
    ABR.BITRATES[r.finalLevel] + ' kbps');
  console.log('  决策序列:   ' + r.decisions.filter(function (d) {
    return d.action !== 'hold';
  }).map(function (d) {
    return (d.action === 'up' ? '↑' : '↓') + ABR.BITRATES[d.level] + '@' + d.now.toFixed(0) + 's';
  }).join(' '));
  console.log('');
  return r;
}

var a = run('轨迹 A: 宽带突降 (6Mbps -> 0.7Mbps -> 恢复)', TRACES.TRACE_A);
var b = run('轨迹 B: 移动网络波动 (多次起伏)', TRACES.TRACE_B);

// 基本合理性断言
var failures = [];
if (a.startupDelay > 10) failures.push('A 起播时间过长');
if (b.startupDelay > 10) failures.push('B 起播时间过长');
if (a.switches > 20) failures.push('A 切换过于频繁(抖动): ' + a.switches);
if (b.switches > 20) failures.push('B 切换过于频繁(抖动): ' + b.switches);
if (a.stallDuration > 30) failures.push('A 卡顿时长过长');
if (b.stallDuration > 30) failures.push('B 卡顿时长过长');

// 恢复后不应在两档之间快速来回: 检查轨迹 A 恢复(112s)后 30s 内的切换次数
var afterRecovery = a.decisions.filter(function (d) {
  return d.now > 112 && d.now < 142 && d.action !== 'hold';
}).length;
console.log('轨迹 A 恢复后 30s 内切换次数: ' + afterRecovery);
if (afterRecovery > 4) failures.push('恢复后存在来回抖动: ' + afterRecovery + ' 次');

if (failures.length) {
  console.error('\n验证失败:');
  failures.forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('\n全部验证通过 ✓');
