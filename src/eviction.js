import { CONFIG, segmentIndexAt } from './config.js';
import { TRACK_NAMES } from './segments.js';
import { totalResidentBytes } from './track-buffer.js';

// 缓冲驱逐策略：
// 1) 播放头前方固定安全区（SAFE_AHEAD_SECONDS）+ 当前播放分片 = 受保护区，
//    任何情况下不驱逐，保证连续播放不会被“挖空”。
// 2) 播放头后方超过 KEEP_BEHIND_SECONDS 的分片先无条件回收。
// 3) 回收后若驻留内存仍超过 MEMORY_LIMIT_BYTES，则从最旧分片开始
//    继续回收（仍不碰受保护区），直到回到上限以下。
// 4) 视频 / 音频 / 字幕按同一分片 index 一起驱逐，三轨 buffered 保持对齐。

export function runEviction(buffers, currentTime, stats) {
  const currentIndex = segmentIndexAt(currentTime);
  const protectedStart = Math.min(
    currentTime - CONFIG.KEEP_BEHIND_SECONDS,
    currentIndex * CONFIG.SEGMENT_DURATION,
  );
  const safeAheadEnd = currentTime + CONFIG.SAFE_AHEAD_SECONDS;
  const safeAheadIndex = segmentIndexAt(
    Math.min(safeAheadEnd, CONFIG.DURATION - 0.01),
  );

  const evictIndexGroup = (index) => {
    for (const trackName of TRACK_NAMES) {
      const removed = buffers[trackName].remove(
        index * CONFIG.SEGMENT_DURATION,
        (index + 1) * CONFIG.SEGMENT_DURATION,
      );
      for (const segment of removed) {
        stats.evictedBytes += segment.size;
        stats.evictedDurationByTrack[trackName] += segment.end - segment.start;
        if (!stats.evictedIndexes.has(index)) {
          stats.evictedIndexes.add(index);
          stats.evictedDurationSeconds += segment.end - segment.start;
        }
      }
    }
  };

  // 阶段一：后方保留窗口之外的分片，全部回收。
  const oldest = buffers.video.oldestSegment();
  if (oldest) {
    for (let index = oldest.index; index < currentIndex; index += 1) {
      const segment = buffers.video.get(index);
      if (segment && segment.start < protectedStart - 1e-9) {
        evictIndexGroup(index);
        stats.pushEvent?.(`evict #${index} (behind keep-window)`);
      }
    }
  }

  // 阶段二：内存仍超限，从最旧分片继续回收，受保护区止步。
  while (totalResidentBytes(buffers) > CONFIG.MEMORY_LIMIT_BYTES) {
    const candidate = buffers.video.oldestSegment();
    if (!candidate) break;
    const candidateEnd = candidate.start + CONFIG.SEGMENT_DURATION;
    // 触达安全区起点（或当前分片）即停止，宁可短暂超限也不挖空安全区。
    if (candidateEnd > protectedStart + 1e-9 || candidate.index >= currentIndex) break;
    evictIndexGroup(candidate.index);
    stats.pushEvent?.(`evict #${candidate.index} (memory pressure)`);
  }

  // 阶段三：回跳 / 跳转后，远端“旧安全区”不再服务当前播放位置，
  // 统一修剪到当前安全窗口上界，避免驻留内存随跳转无限累积。
  for (const trackName of TRACK_NAMES) {
    const indexes = buffers[trackName].residentIndexes();
    for (const index of indexes) {
      if (index > safeAheadIndex) {
        const removed = buffers[trackName].remove(
          index * CONFIG.SEGMENT_DURATION,
          (index + 1) * CONFIG.SEGMENT_DURATION,
        );
        for (const segment of removed) {
          stats.evictedBytes += segment.size;
          stats.evictedDurationByTrack[trackName] += segment.end - segment.start;
          if (!stats.evictedIndexes.has(index)) {
            stats.evictedIndexes.add(index);
            stats.evictedDurationSeconds += segment.end - segment.start;
          }
        }
        if (trackName === 'video') {
          stats.pushEvent?.(`evict #${index} (beyond safe window)`);
        }
      }
    }
  }

  // 记录安全区边界，供 UI 渲染。
  stats.lastProtectedStart = protectedStart;
  stats.lastSafeAheadEnd = safeAheadEnd;
}
