/*
 * 两组网络轨迹 + 合成轨迹生成器。
 * 轨迹格式: [[tSec, kbps], ...] 阶梯函数, 覆盖 0~240s。
 */
(function (global) {
  'use strict';

  // 轨迹 A「宽带突降」: 稳定 6Mbps, 中段一次深度突降到 0.7Mbps, 随后恢复。
  // 用于验证: 快速降级、恢复后不因冷却机制在两档间来回抖动。
  var TRACE_A = [
    [0, 6000], [20, 5800], [40, 6200], [60, 5900],
    [80, 700],           // 突降
    [84, 650], [88, 720], [92, 680], [96, 750],
    [100, 700], [104, 660], [108, 710],
    [112, 5800],         // 恢复
    [116, 6100], [120, 5900], [140, 6000], [160, 6200],
    [180, 5800], [200, 6000], [220, 6100], [240, 6000]
  ];

  // 轨迹 B「移动网络波动」: 多次起伏, 含短时尖峰与连续低谷。
  // 用于验证: 波动环境下切换次数受控、不频繁升降档。
  var TRACE_B = [
    [0, 4500], [12, 3200], [24, 4800], [36, 2200],
    [48, 900],           // 低谷 1
    [56, 1200], [64, 800], [72, 2600],
    [80, 5200], [88, 5400], // 短暂高峰
    [96, 1800], [104, 1100],
    [112, 700],          // 低谷 2
    [120, 950], [128, 1400], [136, 3400],
    [144, 4600], [156, 4200], [168, 2400],
    [180, 1300], [192, 3800], [204, 5000],
    [216, 4400], [228, 4700], [240, 4500]
  ];

  // 合成轨迹: 固定带宽
  function fixedTrace(kbps, duration) {
    return [[0, kbps], [duration || 240, kbps]];
  }

  // 合成轨迹: 带宽突降 (baseKbps -> dropKbps, 持续 dropDuration 后恢复)
  function dropTrace(baseKbps, dropKbps, dropStart, dropDuration, duration) {
    var end = duration || 240;
    return [
      [0, baseKbps],
      [dropStart, dropKbps],
      [dropStart + dropDuration, baseKbps],
      [end, baseKbps]
    ];
  }

  var api = { TRACE_A: TRACE_A, TRACE_B: TRACE_B, fixedTrace: fixedTrace, dropTrace: dropTrace };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TRACES = api;
})(typeof window !== 'undefined' ? window : globalThis);
