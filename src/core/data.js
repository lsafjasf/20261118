/**
 * 样例素材数据（干净基线，不含任何错误）。
 * 错误通过 src/core/faults.js 的故障注入函数动态产生，
 * 这样同一份数据可以反复演示“正确 / 错误”两种状态。
 *
 * 字段约定：
 * - sourceStartFrame: 卷轴上记录的起始帧号（胶片/EDL 计数）
 * - totalFrames:      总帧数
 * - audioOffsetMs:    音频相对画面的偏移，正数=音频滞后，负数=音频提前
 * - markers:          { name, frame } 标记点所在的源帧号
 */

export const REELS = [
  { reelName: 'R01_SC01', fps: 24 },
  { reelName: 'R02_SC02', fps: 24 },
  { reelName: 'R03_SC03', fps: 25 },
];

export const ORIGINALS = [
  { id: 'S001', reelName: 'R01_SC01', clipName: 'A001_C001', fps: 24, sourceStartFrame: 86400, totalFrames: 2400, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 86480 }, { name: 'ACTION', frame: 86720 },
  ] },
  { id: 'S002', reelName: 'R01_SC01', clipName: 'A001_C002', fps: 24, sourceStartFrame: 88800, totalFrames: 1800, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 88860 }, { name: 'ACTION', frame: 89100 },
  ] },
  { id: 'S003', reelName: 'R01_SC01', clipName: 'A001_C003', fps: 24, sourceStartFrame: 90600, totalFrames: 3000, audioOffsetMs: 40, markers: [
    { name: 'SLATE', frame: 90700 }, { name: 'ACTION', frame: 91200 },
  ] },
  { id: 'S004', reelName: 'R01_SC01', clipName: 'A002_C004', fps: 24, sourceStartFrame: 93600, totalFrames: 1200, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 93650 },
  ] },
  { id: 'S005', reelName: 'R01_SC01', clipName: 'A002_C005', fps: 24, sourceStartFrame: 94800, totalFrames: 2640, audioOffsetMs: -20, markers: [
    { name: 'SLATE', frame: 94900 }, { name: 'ACTION', frame: 95400 },
  ] },
  { id: 'S006', reelName: 'R02_SC02', clipName: 'A003_C006', fps: 24, sourceStartFrame: 100000, totalFrames: 2000, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 100100 }, { name: 'ACTION', frame: 100600 },
  ] },
  { id: 'S007', reelName: 'R02_SC02', clipName: 'A003_C007', fps: 24, sourceStartFrame: 102000, totalFrames: 2200, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 102080 }, { name: 'ACTION', frame: 102600 },
  ] },
  { id: 'S008', reelName: 'R02_SC02', clipName: 'A003_C008', fps: 24, sourceStartFrame: 104200, totalFrames: 1600, audioOffsetMs: 60, markers: [
    { name: 'SLATE', frame: 104300 },
  ] },
  { id: 'S009', reelName: 'R02_SC02', clipName: 'A004_C009', fps: 24, sourceStartFrame: 105800, totalFrames: 2880, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 105900 }, { name: 'ACTION', frame: 106500 },
  ] },
  { id: 'S010', reelName: 'R02_SC02', clipName: 'A004_C010', fps: 24, sourceStartFrame: 108680, totalFrames: 1440, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 108760 },
  ] },
  { id: 'S011', reelName: 'R03_SC03', clipName: 'A005_C011', fps: 25, sourceStartFrame: 120000, totalFrames: 2500, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 120100 }, { name: 'ACTION', frame: 120800 },
  ] },
  { id: 'S012', reelName: 'R03_SC03', clipName: 'A005_C012', fps: 25, sourceStartFrame: 122500, totalFrames: 2000, audioOffsetMs: -40, markers: [
    { name: 'SLATE', frame: 122600 },
  ] },
  { id: 'S013', reelName: 'R03_SC03', clipName: 'A005_C013', fps: 25, sourceStartFrame: 124500, totalFrames: 3000, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 124600 }, { name: 'ACTION', frame: 125400 },
  ] },
  { id: 'S014', reelName: 'R03_SC03', clipName: 'A006_C014', fps: 25, sourceStartFrame: 127500, totalFrames: 1750, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 127580 },
  ] },
  { id: 'S015', reelName: 'R03_SC03', clipName: 'A006_C015', fps: 25, sourceStartFrame: 129250, totalFrames: 2250, audioOffsetMs: 80, markers: [
    { name: 'SLATE', frame: 129350 }, { name: 'ACTION', frame: 130000 },
  ] },
  { id: 'S016', reelName: 'R03_SC03', clipName: 'A006_C016', fps: 25, sourceStartFrame: 131500, totalFrames: 1500, audioOffsetMs: 0, markers: [
    { name: 'SLATE', frame: 131580 },
  ] },
];

/**
 * 基于原片生成一一对应的干净代理（基线）。
 * 代理文件名遵循 <原片名>_P01 约定，元数据与原片完全一致。
 */
export function buildBaselineProxies() {
  return ORIGINALS.map((src) => ({
    id: `P${src.id.slice(1)}`,
    sourceId: src.id,
    reelName: src.reelName,
    clipName: `${src.clipName}_P01`,
    fps: src.fps,
    sourceStartFrame: src.sourceStartFrame,
    totalFrames: src.totalFrames,
    audioOffsetMs: src.audioOffsetMs,
    markers: src.markers.map((m) => ({ ...m })),
    path: `/Proxies/${src.reelName}/${src.clipName}_P01.mov`,
  }));
}

/**
 * 剪辑时间线（EDL）：每条事件引用一个代理片段，
 * sourceInFrame / sourceOutFrame 使用原片源帧号。
 */
export const TIMELINE_EVENTS = [
  { id: 'E01', proxyId: 'P001', track: 'V1', sourceInFrame: 86500, sourceOutFrame: 87600 },
  { id: 'E02', proxyId: 'P003', track: 'V1', sourceInFrame: 90800, sourceOutFrame: 92600 },
  { id: 'E03', proxyId: 'P006', track: 'V1', sourceInFrame: 100200, sourceOutFrame: 101400 },
  { id: 'E04', proxyId: 'P007', track: 'V1', sourceInFrame: 102200, sourceOutFrame: 103800 },
  { id: 'E05', proxyId: 'P009', track: 'V1', sourceInFrame: 106000, sourceOutFrame: 108200 },
  { id: 'E06', proxyId: 'P011', track: 'V1', sourceInFrame: 120200, sourceOutFrame: 122000 },
  { id: 'E07', proxyId: 'P013', track: 'V1', sourceInFrame: 124800, sourceOutFrame: 127000 },
  { id: 'E08', proxyId: 'P015', track: 'V1', sourceInFrame: 129500, sourceOutFrame: 131200 },
  { id: 'E09', proxyId: 'P002', track: 'V2', sourceInFrame: 88900, sourceOutFrame: 90200 },
  { id: 'E10', proxyId: 'P012', track: 'V2', sourceInFrame: 122700, sourceOutFrame: 124200 },
];
