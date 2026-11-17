/**
 * 故障注入：在干净基线上模拟真实转码/导入环节常见的元数据错误。
 * 所有注入都基于深拷贝，不污染基线数据，可反复开关。
 */

import { buildBaselineProxies } from './data.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * 预置故障清单。
 * category 与检查器输出的 issue type 对应：
 * fps / audio / early / late / duration / marker / unlinked
 */
export const FAULT_LIBRARY = [
  {
    id: 'F_FPS_WRONG',
    title: '帧率写错（P003 被标成 25fps，实际原片 24fps）',
    category: 'fps',
    targetProxyId: 'P003',
    required: true,
    apply: (proxy) => { proxy.fps = 25; },
  },
  {
    id: 'F_AUDIO_OFFSET',
    title: '音频偏移错误（P009 偏移由 0ms 错写为 +120ms）',
    category: 'audio',
    targetProxyId: 'P009',
    required: true,
    apply: (proxy) => { proxy.audioOffsetMs = 120; },
  },
  {
    id: 'F_EARLY_START',
    title: '起始帧提前（P005 起始帧少 6 帧，代理整体提前）',
    category: 'early',
    targetProxyId: 'P005',
    required: false,
    apply: (proxy) => { proxy.sourceStartFrame -= 6; },
  },
  {
    id: 'F_LATE_START',
    title: '起始帧延后（P008 起始帧多 8 帧，代理整体延后）',
    category: 'late',
    targetProxyId: 'P008',
    required: false,
    apply: (proxy) => { proxy.sourceStartFrame += 8; },
  },
  {
    id: 'F_DURATION_MISMATCH',
    title: '总帧数不符（P011 转码截断，少 120 帧）',
    category: 'duration',
    targetProxyId: 'P011',
    required: false,
    apply: (proxy) => { proxy.totalFrames -= 120; },
  },
  {
    id: 'F_MARKER_DRIFT',
    title: '标记点漂移（P006 的 ACTION 标记偏移 12 帧）',
    category: 'marker',
    targetProxyId: 'P006',
    required: false,
    apply: (proxy) => {
      const marker = proxy.markers.find((m) => m.name === 'ACTION');
      if (marker) marker.frame += 12;
    },
  },
  {
    id: 'F_UNLINKED',
    title: '代理无法映射回原片（P014 的 sourceId 与命名约定同时损坏）',
    category: 'unlinked',
    targetProxyId: 'P014',
    required: false,
    apply: (proxy) => {
      delete proxy.sourceId;
      proxy.clipName = `UNKNOWN_${proxy.id}_recovered`;
    },
  },
];

/**
 * 按启用的故障 ID 列表生成受损代理集。
 * @param {string[]} enabledFaultIds
 */
export function buildFaultyProxies(enabledFaultIds) {
  const proxies = buildBaselineProxies().map(clone);
  const enabled = new Set(enabledFaultIds);
  const applied = [];

  for (const fault of FAULT_LIBRARY) {
    if (!enabled.has(fault.id)) continue;
    const proxy = proxies.find((p) => p.id === fault.targetProxyId);
    if (!proxy) continue;
    fault.apply(proxy);
    applied.push(fault.id);
  }
  return { proxies, appliedFaultIds: applied };
}

export function defaultEnabledFaultIds() {
  return FAULT_LIBRARY.filter((f) => f.required).map((f) => f.id);
}
