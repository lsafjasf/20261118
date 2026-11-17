import { CONFIG, segmentIndexAt, totalSegments } from './config.js';
import { VirtualClock } from './clock.js';
import { TrackBuffer, totalResidentBytes } from './track-buffer.js';
import { SegmentFetcher } from './fetcher.js';
import { runEviction } from './eviction.js';
import { PlaybackStats } from './stats.js';
import { TRACK_NAMES, makeSegment } from './segments.js';

const TICK_SECONDS = 0.5;

// 模拟一个带 MSE SourceBuffer 的播放器。
// 外部通过 seek() 模拟用户拖动，clock.advance() 推进虚拟时间，
// renderState 记录当前真正上屏 / 出声 / 出字幕的时间，用于断言。
export class SimulatedPlayer {
  constructor() {
    this.clock = new VirtualClock();
    this.stats = new PlaybackStats();
    this.stats.bindClock(this.clock);

    this.buffers = {
      video: new TrackBuffer('video'),
      audio: new TrackBuffer('audio'),
      text: new TrackBuffer('text'),
    };
    this.fetcher = new SegmentFetcher(this.clock, this.buffers, this.stats);

    this.currentTime = 0;
    this.playing = true;
    this.pendingTargetIndex = 0; // seek 后等待三轨补齐的目标分片
    this.lastRendered = null;   // { index, videoTime, audioTime, textTime }
    this._scheduleTick();
  }

  _scheduleTick() {
    this.clock.setTimeout(() => this._tick(), TICK_SECONDS);
  }

  // 一次 seek：真实浏览器里会 currentTime=t 并触发 waiting，
  // 在途请求全部 abort，已驱逐位置必须重新拉取，绝不能读出旧画面。
  seek(targetTime) {
    const target = Math.min(Math.max(0, targetTime), CONFIG.DURATION - 0.01);
    const index = segmentIndexAt(target);
    this.stats.seekCount += 1;
    this.currentTime = target;
    this.pendingTargetIndex = index;

    const wasEvicted = !this.buffers.video.has(index);
    this.fetcher.cancelInFlight(`seek to ${target.toFixed(1)}s`);

    if (wasEvicted) {
      this.stats.seeksIntoEvicted += 1;
      this.stats.refetchGroupRequests += 1;
      this.stats.refetchSegmentIndexes.add(index);
      this.stats.pushEvent?.(
        `seek -> ${target.toFixed(1)}s hits evicted #${index}, refetch`,
      );
    } else {
      this.stats.pushEvent?.(`seek -> ${target.toFixed(1)}s (resident #${index})`);
    }
    this.fetcher.fetchGroup(index);
  }

  pause() { this.playing = false; }
  play() { this.playing = true; }

  _tick() {
    // 1) 播放推进（仅当三轨已就绪，避免“卡在半帧”状态下继续走时间）。
    if (this.playing && this._allTracksReady(segmentIndexAt(this.currentTime))) {
      const currentIndex = segmentIndexAt(this.currentTime);
      if (currentIndex === this.pendingTargetIndex) {
        this.currentTime = Math.min(this.currentTime + TICK_SECONDS, CONFIG.DURATION);
      }
    }

    const currentIndex = segmentIndexAt(this.currentTime);

    // 2) 驱逐：安全区保护 + 内存上限回收。
    runEviction(this.buffers, this.currentTime, this.stats);

    // 3) 前向预取：补齐当前分片与安全区内缺口（按组请求三轨）。
    const safeAheadIndex = segmentIndexAt(
      Math.min(this.currentTime + CONFIG.SAFE_AHEAD_SECONDS, CONFIG.DURATION - 0.01),
    );
    for (let index = currentIndex; index <= safeAheadIndex; index += 1) {
      if (!this.buffers.video.has(index)) this.fetcher.fetchGroup(index);
    }

    // 4) 渲染：只有三轨同一 index 全部驻留才上屏，否则保持 waiting，
    //    保证画面、音频、字幕永远落在同一时间刻度。
    if (this._allTracksReady(this.pendingTargetIndex)) {
      this._render(this.pendingTargetIndex);
      this.pendingTargetIndex = currentIndex;
    }

    this._scheduleTick();
  }

  _allTracksReady(index) {
    return TRACK_NAMES.every((name) => this.buffers[name].has(index));
  }

  _render(index) {
    const segment = this.buffers.video.get(index) || makeSegment('video', index);
    const renderTime = segment ? segment.start : 0;
    this.lastRendered = {
      index,
      videoTime: renderTime,
      audioTime: renderTime,
      textTime: renderTime,
    };
  }

  // UI / 断言使用的只读快照。
  getState() {
    const index = segmentIndexAt(this.currentTime);
    return {
      clockTime: this.clock.now(),
      currentTime: this.currentTime,
      currentIndex: index,
      pendingTargetIndex: this.pendingTargetIndex,
      playing: this.playing,
      residentBytes: totalResidentBytes(this.buffers),
      memoryLimit: CONFIG.MEMORY_LIMIT_BYTES,
      buffered: Object.fromEntries(
        TRACK_NAMES.map((name) => [name, this.buffers[name].getBufferedRanges()]),
      ),
      resident: Object.fromEntries(
        TRACK_NAMES.map((name) => [name, this.buffers[name].residentIndexes()]),
      ),
      inFlight: this.fetcher.inFlightCount,
      inFlightKeys: [...this.fetcher.inFlightKeys()],
      generation: this.fetcher.generation,
      lastRendered: this.lastRendered,
      totalSegments: totalSegments(),
      segmentDuration: CONFIG.SEGMENT_DURATION,
      stats: this.stats.snapshot(),
      evictedIndexList: [...this.stats.evictedIndexes],
      recentEvents: this.stats.events.slice(-12),
    };
  }
}
