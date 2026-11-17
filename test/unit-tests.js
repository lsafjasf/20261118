import assert from 'node:assert/strict';
import { SimulatedPlayer } from '../src/player.js';
import { CONFIG, segmentIndexAt } from '../src/config.js';
import { TrackBuffer } from '../src/track-buffer.js';
import { makeSegment, segmentSize } from '../src/segments.js';
import { PlaybackStats } from '../src/stats.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('TrackBuffer: append/remove/buffered 区间合并符合 TimeRanges 语义', () => {
  const buffer = new TrackBuffer('video');
  buffer.append(makeSegment('video', 0));
  buffer.append(makeSegment('video', 1));
  buffer.append(makeSegment('video', 3));
  assert.deepEqual(buffer.getBufferedRanges(), [
    { start: 0, end: CONFIG.SEGMENT_DURATION * 2 },
    { start: CONFIG.SEGMENT_DURATION * 3, end: CONFIG.SEGMENT_DURATION * 4 },
  ]);
  const removed = buffer.remove(0, CONFIG.SEGMENT_DURATION * 2);
  assert.equal(removed.length, 2);
  assert.equal(buffer.has(0), false);
  assert.equal(buffer.containsTime(7), true);
  assert.equal(buffer.bufferedBytes(), segmentSize('video'));
});

test('驱逐策略: 安全区受保护，后方按内存上限回收且三轨同步', () => {
  const player = new SimulatedPlayer();
  player.clock.advance(120);
  const state = player.getState();
  const current = state.currentTime;
  // 安全区 = 当前分片前方 30s，必须完整驻留。
  for (const track of ['video', 'audio', 'text']) {
    assert.equal(player.buffers[track].containsTime(current + 20), true,
      `${track} 安全区内分片不得被驱逐`);
  }
  // 60s 之前的旧内容应已回收。
  assert.equal(player.buffers.video.has(segmentIndexAt(20)), false);
  // 三轨驻留分片 index 集合完全一致（同步驱逐）。
  assert.deepEqual(state.resident.video, state.resident.audio);
  assert.deepEqual(state.resident.video, state.resident.text);
  // 驻留内存受上限约束（安全区自身导致的短暂超限除外，此处安全区 < 上限）。
  assert.ok(state.residentBytes <= state.memoryLimit * 1.1);
});

test('竞态: seek 后迟到的旧响应按 generation 丢弃，不进入 SourceBuffer', () => {
  const player = new SimulatedPlayer();
  // 直接制造一个在途请求（模拟分片刚发出、响应尚未返回）。
  player.fetcher.fetchGroup(10);
  assert.ok(player.fetcher.inFlightCount > 0);
  const oldGeneration = player.fetcher.generation;
  // 模拟 abort 已调用、但部分响应仍在网络上迟到的情况。
  player.fetcher.invalidateGeneration();
  assert.notEqual(player.fetcher.generation, oldGeneration);
  const residentBefore = player.buffers.video.size;
  player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.1);
  assert.ok(player.stats.staleDropped > 0, '迟到响应应计入 staleDropped');
  // 旧 generation 的分片没有被 append。
  assert.equal(player.buffers.video.size, residentBefore);
});

test('seek 到已驱逐区间: 重新请求完成前不上屏，完成后三轨同一时间', () => {
  const player = new SimulatedPlayer();
  player.clock.advance(400);
  const targetIndex = segmentIndexAt(80);
  assert.equal(player.buffers.video.has(targetIndex), false);
  player.seek(80);
  assert.equal(player.stats.seeksIntoEvicted, 1);
  assert.equal(player.stats.refetchGroupRequests, 1);
  assert.equal(player.buffers.video.has(targetIndex), false, '请求未完成不得驻留');
  player.clock.advance(CONFIG.FETCH_LATENCY_SECONDS + 0.6);
  const rendered = player.getState().lastRendered;
  assert.equal(rendered.index, targetIndex);
  assert.equal(rendered.videoTime, rendered.audioTime);
  assert.equal(rendered.audioTime, rendered.textTime);
});

test('统计: 累计驱逐时长按时间线去重，三轨驱逐时长分别累计', () => {
  const stats = new PlaybackStats();
  const player = new SimulatedPlayer();
  player.clock.advance(240);
  const s = player.getState().stats;
  assert.ok(s.evictedDurationSeconds > 0);
  assert.equal(s.evictedDurationSeconds, s.evictedIndexCount * CONFIG.SEGMENT_DURATION);
  assert.ok(s.evictedDurationByTrack.video > 0);
  assert.ok(s.evictedDurationByTrack.audio > 0);
  assert.ok(s.evictedDurationByTrack.text > 0);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`[FAIL] ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} 个单元测试通过`);
