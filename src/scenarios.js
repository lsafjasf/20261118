import { SimulatedPlayer } from './player.js';
import { CONFIG, segmentIndexAt } from './config.js';

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败: ${message}`);
}

function fmtTime(value) {
  return `${value.toFixed(1)}s`;
}

// 公共校验：画面 / 音频 / 字幕必须落在同一目标分片时间。
function assertAvsync(player, targetTime, label) {
  const state = player.getState();
  const targetIndex = segmentIndexAt(targetTime);
  const rendered = state.lastRendered;
  assert(rendered !== null, `${label}: 尚未产生任何渲染帧`);
  assert(rendered.index === targetIndex,
    `${label}: 渲染分片 #${rendered.index} 与目标 #${targetIndex} 不一致`);
  assert(rendered.videoTime === rendered.audioTime && rendered.audioTime === rendered.textTime,
    `${label}: 视频(${fmtTime(rendered.videoTime)})/音频(${fmtTime(rendered.audioTime)})/字幕(${fmtTime(rendered.textTime)}) 时间未对齐`);
  assert(player.buffers.video.has(targetIndex)
    && player.buffers.audio.has(targetIndex)
    && player.buffers.text.has(targetIndex),
    `${label}: 目标分片三轨未全部驻留`);
  return rendered;
}

// 场景一：长距离回跳。
// 播放到 480s 后一次跳回 60s——该区间早已被内存上限驱逐，
// 必须触发重新请求，且恢复后三轨对齐到同一目标时间。
export function runLongBackwardSeek() {
  const player = new SimulatedPlayer();
  const log = [];

  // 阶段 A：持续播放到 480s，让后方分片被充分驱逐。
  player.clock.advance(480);
  const beforeSeek = player.getState();
  assert(beforeSeek.stats.evictedDurationSeconds > 0, '长播后应已发生驱逐');
  const targetIndex = segmentIndexAt(60);
  assert(!player.buffers.video.has(targetIndex), '60s 处分片应已被驱逐');
  log.push(`播放到 ${fmtTime(beforeSeek.currentTime)}，累计驱逐 ${beforeSeek.stats.evictedDurationSeconds}s`);

  // 阶段 B：长距离回跳到已驱逐区间。
  player.seek(60);
  const justAfterSeek = player.getState();
  assert(justAfterSeek.stats.seeksIntoEvicted === 1, '回跳应命中已驱逐区间');
  assert(justAfterSeek.stats.refetchGroupRequests === 1, '应发起 1 次重新请求');
  assert(justAfterSeek.lastRendered === null
    || justAfterSeek.lastRendered.index !== targetIndex,
    '请求未完成前不得渲染目标位置（防止读出旧画面）');

  // 阶段 C：等待请求往返完成（含一个 tick 周期）。
  player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.6);
  const rendered = assertAvsync(player, 60, '长距离回跳');

  // 阶段 D：恢复播放 4s，确认时间继续沿目标位置推进且持续对齐。
  player.clock.advance(4);
  assertAvsync(player, player.currentTime, '回跳后继续播放');
  assert(player.currentTime > 60, '回跳恢复后播放头应继续前进');

  const finalState = player.getState();
  assert(finalState.residentBytes <= CONFIG.MEMORY_LIMIT_BYTES,
    `回跳修剪后驻留内存 ${finalState.residentBytes} 不得超过上限 ${CONFIG.MEMORY_LIMIT_BYTES}`);
  log.push(`回跳 60s 命中已驱逐区间，重新请求 #${targetIndex}（三轨一组）`);
  log.push(`恢复后渲染对齐于 ${fmtTime(rendered.videoTime)}，当前播放头 ${fmtTime(finalState.currentTime)}`);

  return {
    name: '长距离回跳 (480s -> 60s)',
    player,
    log,
    finalState,
    assertions: [
      '回跳命中已驱逐区间并触发重新请求',
      '请求完成前不上屏，杜绝旧画面',
      '视频 / 音频 / 字幕渲染时间完全相同',
      '恢复播放后三轨继续同步推进',
      '远端旧安全区被修剪，驻留内存不超过上限',
    ],
  };
}

// 场景二：快速连续拖动。
// 在 1 个请求往返周期内连续 seek 到 5 个位置，验证在途请求被 abort、
// 过期响应被丢弃，最终只在最后一个目标位置对齐渲染。
export function runRapidSeeking() {
  const player = new SimulatedPlayer();
  const log = [];

  player.clock.advance(300);
  const targets = [200, 40, 350, 120, 260]; // 最后一个 260s 是最终落点
  for (const target of targets) {
    player.seek(target);
    player.clock.advance(0.2); // 拖动间隔小于 FETCH_LATENCY，请求都未完成
  }

  const beforeSettle = player.getState();
  assert(beforeSettle.stats.seekCount === targets.length, '5 次拖动都应被记录');
  assert(beforeSettle.stats.cancelledRequests > 0, '连续拖动应 abort 在途请求');
  assert(beforeSettle.generation === targets.length, '每次拖动都应推进 generation 作废旧响应');
  assert(beforeSettle.lastRendered === null
    || beforeSettle.lastRendered.index !== segmentIndexAt(260),
    '抖动过程中不得提前渲染最终目标');

  // 等待最后一次请求完成。
  player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.6);
  const rendered = assertAvsync(player, 260, '快速连续拖动');

  // 再让时钟跑一会儿，过期响应即使迟到也必须被 generation 拦截。
  player.clock.advance(3);
  const after = player.getState();
  // 恢复播放后渲染位置只能沿最终目标 260s 单调前进，
  // 且任何时刻三轨时间戳保持一致（过期响应没有 append 通道可污染画面）。
  assert(after.lastRendered.index >= segmentIndexAt(260),
    '迟到的过期响应不得把画面拉回中间拖动位置');
  assert(after.lastRendered.videoTime === after.lastRendered.audioTime
    && after.lastRendered.audioTime === after.lastRendered.textTime,
    '继续播放后三轨时间戳仍须一致');
  assert(after.lastRendered.videoTime >= rendered.videoTime,
    '渲染位置不得回跳到被丢弃的旧分片');

  log.push(`连续拖动 ${targets.join('s -> ')}s，间隔 0.2s（小于请求往返 1s）`);
  log.push(`abort 在途请求 ${after.stats.cancelledRequests} 次，generation 推进至 ${after.generation}`);
  log.push(`最终三轨对齐于 ${fmtTime(after.lastRendered.videoTime)}，播放头 ${fmtTime(after.currentTime)}`);

  return {
    name: '快速连续拖动 (200/40/350/120/260s)',
    player,
    log,
    finalState: after,
    assertions: [
      '每次拖动 abort 上一代在途请求',
      'generation 随拖动推进，迟到响应在 append 前被拒绝（竞态单测覆盖）',
      '仅最终目标 260s 被渲染，无中间位置闪帧',
      '视频 / 音频 / 字幕最终落在同一时间',
    ],
  };
}

export function runAllScenarios() {
  return [runLongBackwardSeek(), runRapidSeeking()];
}
