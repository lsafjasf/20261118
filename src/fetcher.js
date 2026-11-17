import { CONFIG } from './config.js';
import { makeSegment, TRACK_NAMES } from './segments.js';

// 分片获取器：模拟异步 appendBuffer 队列。
// 每次拖动都会让 generation +1，旧 generation 的响应即使到达也丢弃，
// 防止“后发先至 / 先发后至”把过期画面 append 进 SourceBuffer。
export class SegmentFetcher {
  constructor(clock, buffers, stats) {
    this._clock = clock;
    this._buffers = buffers;
    this._stats = stats;
    this._generation = 0;
    // key `${track}:${index}` -> { generation, timer }
    this._inFlight = new Map();
  }

  get generation() {
    return this._generation;
  }

  get inFlightCount() {
    return this._inFlight.size;
  }

  inFlightKeys() {
    return [...this._inFlight.keys()];
  }

  // 作废旧 generation：真实场景里 seek 后即便 abort 指令已发出，
  // 部分在途响应仍可能先一步到达，这类响应在 append 阶段必须被拒绝。
  invalidateGeneration() {
    this._generation += 1;
    // 解除在途登记但保留定时器，让响应自然“迟到”并走 staleDropped 路径。
    this._inFlight.clear();
  }

  // 取消全部在途请求并作废旧 generation。
  // 对应真实场景中 abort 旧 fetch + sourceBuffer.abort()。
  cancelInFlight(reason) {
    const pending = [...this._inFlight.values()];
    for (const item of pending) {
      this._clock.clearTimeout(item.timer);
      this._stats.cancelledRequests += 1;
    }
    this._inFlight.clear();
    this._generation += 1;
    this._stats.pushEvent?.(`cancel in-flight (${reason})`);
  }

  // 请求一个对齐分片组（视频/音频/字幕同一 index 必须一起补齐，
  // 这是三轨最终落在同一目标时间的前提）。
  fetchGroup(index, generation = this._generation) {
    for (const trackName of TRACK_NAMES) {
      this._fetchOne(trackName, index, generation);
    }
  }

  _fetchOne(trackName, index, generation) {
    const key = `${trackName}:${index}`;
    const existing = this._inFlight.get(key);
    if (existing && existing.generation === generation) return;
    if (existing) {
      this._clock.clearTimeout(existing.timer);
      this._stats.cancelledRequests += 1;
    }

    this._stats.totalRequests += 1;
    const timer = this._clock.setTimeout(() => {
      this._inFlight.delete(key);
      // 过期响应：拖动后该分片已不属于当前需要的位置，直接丢弃。
      if (generation !== this._generation) {
        this._stats.staleDropped += 1;
        this._stats.pushEvent?.(
          `drop stale ${trackName}#${index} gen=${generation} (now gen=${this._generation})`,
        );
        return;
      }
      const segment = makeSegment(trackName, index);
      if (segment) this._buffers[trackName].append(segment);
      this._stats.completedRequests += 1;
    }, CONFIG.FETCH_LATENCY_SECONDS);

    this._inFlight.set(key, { generation, timer });
  }
}
