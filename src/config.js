// 全局模拟配置：时长、分片、安全区、内存上限均在此集中调参。

export const CONFIG = Object.freeze({
  // 模拟的媒体总时长（秒）。600s = 10 分钟，足以观察多次驱逐。
  DURATION: 600,
  // 每个分片时长（秒）。视频 / 音频 / 字幕共用 2s 对齐分片，
  // 保证三条轨道的 buffered 区间天然落在相同时间刻度上。
  SEGMENT_DURATION: 2,

  TRACKS: Object.freeze({
    video: { bitrate: 2_500_000 }, // 2.5 Mbps
    audio: { bitrate: 128_000 },   // 128 kbps
    text:  { bitrate: 8_000 },     // 字幕近似 8 kbps
  }),

  // 播放头前方固定安全区（秒）：安全区内的分片永不驱逐，
  // 对应真实播放器里保证连续播放的 forward buffer。
  SAFE_AHEAD_SECONDS: 30,
  // 播放头后方保留区（秒）：仅在未超内存上限时保留，
  // 超限时从最旧分片开始优先回收这部分。
  KEEP_BEHIND_SECONDS: 10,

  // 三轨道合计的驻留内存上限（字节）。
  // 2.5Mbps*30s + 128k*30s + 8k*30s ≈ 9.9MB，安全区本身接近上限，
  // 因此后方分片很快就会触发回收，便于演示驱逐。
  MEMORY_LIMIT_BYTES: 12_000_000,

  // 单个分片的“网络”往返延迟（虚拟秒）。请求是异步的，
  // 拖动产生的新请求会让未完成的旧请求失效（generation 校验）。
  FETCH_LATENCY_SECONDS: 1.0,
});

export function segmentIndexAt(timeSeconds) {
  return Math.floor(timeSeconds / CONFIG.SEGMENT_DURATION);
}

export function segmentStart(index) {
  return index * CONFIG.SEGMENT_DURATION;
}

export function totalSegments() {
  return Math.ceil(CONFIG.DURATION / CONFIG.SEGMENT_DURATION);
}
