// 集中维护界面需要展示的全部指标与事件日志。
export class PlaybackStats {
  constructor() {
    // 请求侧
    this.totalRequests = 0;       // 发出的分片请求总数（按分片计）
    this.completedRequests = 0;   // 成功 append 的响应
    this.cancelledRequests = 0;   // 被 abort 的在途请求
    this.staleDropped = 0;        // 到达时已过期、被丢弃的响应

    // 重新请求：seek 命中已驱逐区间而发起的分片组请求
    this.refetchGroupRequests = 0;
    this.refetchSegmentIndexes = new Set();

    // 驱逐侧
    this.evictedBytes = 0;
    this.evictedDurationSeconds = 0;        // 按时间线去重后的累计驱逐时长
    this.evictedDurationByTrack = { video: 0, audio: 0, text: 0 };
    this.evictedIndexes = new Set();

    // seek 行为
    this.seekCount = 0;
    this.seeksIntoEvicted = 0;

    // 最近一次驱逐计算出的受保护边界（UI 用）
    this.lastProtectedStart = 0;
    this.lastSafeAheadEnd = 0;

    this.events = [];
  }

  pushEvent(message) {
    this.events.push({ time: this._clockNow ? this._clockNow() : null, message });
    if (this.events.length > 500) this.events.shift();
  }

  bindClock(clock) {
    this._clockNow = () => clock.now();
  }

  snapshot() {
    return {
      totalRequests: this.totalRequests,
      completedRequests: this.completedRequests,
      cancelledRequests: this.cancelledRequests,
      staleDropped: this.staleDropped,
      refetchGroupRequests: this.refetchGroupRequests,
      distinctRefetchSegments: this.refetchSegmentIndexes.size,
      evictedBytes: this.evictedBytes,
      evictedDurationSeconds: this.evictedDurationSeconds,
      evictedDurationByTrack: { ...this.evictedDurationByTrack },
      evictedIndexCount: this.evictedIndexes.size,
      seekCount: this.seekCount,
      seeksIntoEvicted: this.seeksIntoEvicted,
      lastProtectedStart: this.lastProtectedStart,
      lastSafeAheadEnd: this.lastSafeAheadEnd,
    };
  }
}
