// 模拟 W3C MSE 的 SourceBuffer：
//   appendBuffer(segment) -> 分片进入驻留集合
//   remove(start, end)    -> 按时间范围驱逐（对应 sourceBuffer.remove）
//   buffered              -> 合并相邻分片得到 TimeRanges 语义
// 每个分片同时记录生命周期状态，供 UI 着色。

export class TrackBuffer {
  constructor(name) {
    this.name = name;
    // index -> segment，仅保存当前驻留的分片。
    this._segments = new Map();
  }

  // 等价于 SourceBuffer.appendBuffer（updating 排队在 fetcher 层串行化）。
  append(segment) {
    if (!segment || segment.track !== this.name) return;
    this._segments.set(segment.index, segment);
  }

  has(index) {
    return this._segments.has(index);
  }

  get(index) {
    return this._segments.get(index) || null;
  }

  get size() {
    return this._segments.size;
  }

  // 返回被删除的分片列表，调用方负责累计“驱逐时长”。
  remove(startSeconds, endSeconds) {
    const removed = [];
    for (const [index, segment] of this._segments) {
      if (segment.start >= startSeconds - 1e-9 && segment.start < endSeconds - 1e-9) {
        removed.push(segment);
        this._segments.delete(index);
      }
    }
    return removed;
  }

  residentIndexes() {
    return [...this._segments.keys()].sort((a, b) => a - b);
  }

  bufferedBytes() {
    let bytes = 0;
    for (const segment of this._segments.values()) bytes += segment.size;
    return bytes;
  }

  // TimeRanges 语义：把相邻分片合并成 [start, end] 区间数组。
  getBufferedRanges() {
    const indexes = this.residentIndexes();
    if (indexes.length === 0) return [];
    const ranges = [];
    let rangeStart = null;
    let prevEnd = null;
    let prevIndex = null;
    for (const index of indexes) {
      const segment = this._segments.get(index);
      if (rangeStart === null || index !== prevIndex + 1) {
        if (rangeStart !== null) ranges.push({ start: rangeStart, end: prevEnd });
        rangeStart = segment.start;
      }
      prevEnd = segment.end;
      prevIndex = index;
    }
    ranges.push({ start: rangeStart, end: prevEnd });
    return ranges;
  }

  // 判断某个播放时刻是否落在已驻留分片内（等价 buffered.contains(t)）。
  containsTime(timeSeconds) {
    return this.getBufferedRanges().some(
      (range) => timeSeconds >= range.start - 1e-9 && timeSeconds < range.end - 1e-9,
    );
  }

  oldestSegment() {
    const indexes = this.residentIndexes();
    return indexes.length ? this._segments.get(indexes[0]) : null;
  }

  clear() {
    this._segments.clear();
  }
}

// 三轨道合计驻留字节。
export function totalResidentBytes(buffers) {
  return Object.values(buffers).reduce((sum, buffer) => sum + buffer.bufferedBytes(), 0);
}
