# SourceBuffer 缓冲驱逐策略设计

## 1. 设计目标

面向长时间播放（本模拟取 600 秒）的 MSE（Media Source Extensions）播放器，需要同时满足：

1. 播放头前方始终保留固定安全区，保证正常播放不卡顿。
2. 播放头后方按内存上限回收，驻留字节数受控。
3. 用户拖到已被驱逐的区间时，重新发起请求而不是读出残留的旧画面。
4. 视频、音频、字幕三条轨道在任何时刻渲染到同一时间刻度。

## 2. 模块划分

| 模块 | 职责 | 对应浏览器概念 |
| --- | --- | --- |
| `src/config.js` | 时长、分片、安全区、内存上限等参数 | 播放器配置 |
| `src/clock.js` | 确定性虚拟时钟，驱动请求与播放 | 事件循环 / 网络定时器 |
| `src/track-buffer.js` | 分片驻留集合、`remove`、buffered 区间合并 | `SourceBuffer` + `TimeRanges` |
| `src/fetcher.js` | 异步分片请求、generation 竞态控制 | `fetch` + `SourceBuffer.abort()` |
| `src/eviction.js` | 三阶段驱逐策略 | `sourceBuffer.remove(start, end)` |
| `src/player.js` | 播放推进、seek、三轨同步渲染 | `HTMLMediaElement` 调度循环 |
| `src/stats.js` | 驱逐时长、重新请求次数、事件日志 | 播放器遥测 |

## 3. 驱逐策略（三阶段）

每次调度 tick（0.5 虚拟秒）执行一次：

1. **后方窗口回收**：早于 `currentTime - KEEP_BEHIND_SECONDS`（默认 10s）的分片无条件驱逐。
2. **内存压力回收**：若三轨合计驻留仍超过 `MEMORY_LIMIT_BYTES`（12MB），从最旧分片继续 FIFO 回收，直到回落到上限以下；触达当前播放分片即停止，宁可短暂超限也不挖空播放位置。
3. **远端安全区修剪**：seek 之后，远离新播放头、超出 `currentTime + SAFE_AHEAD_SECONDS`（默认 30s）的旧安全区分片一律修剪，防止跳转后驻留内存翻倍。

受保护窗口：`[currentTime - 10s, currentTime + 30s]` 与当前播放分片永不驱逐。

三条轨道使用相同的 2 秒对齐分片与相同的 index 集合，驱逐时按 index 成组回收，因此三轨的 buffered 区间始终对齐。

## 4. 与真实 MSE API 的映射

| 模拟调用 | 真实 API |
| --- | --- |
| `TrackBuffer.append(segment)` | `sourceBuffer.appendBuffer(chunk)`（需等 `updateend`） |
| `TrackBuffer.remove(start, end)` | `sourceBuffer.remove(start, end)` |
| `TrackBuffer.getBufferedRanges()` | `sourceBuffer.buffered`（`TimeRanges` 合并相邻区间） |
| `TrackBuffer.containsTime(t)` | `buffered.start(i) <= t < buffered.end(i)` |
| `Fetcher.cancelInFlight()` | `AbortController.abort()` + `sourceBuffer.abort()` |
| generation 校验后丢弃过期响应 | 响应回来后比对请求序号，过期则不调用 `appendBuffer` |
| `player.seek(t)` | 设置 `video.currentTime = t`，监听 `waiting` 事件补拉 |

## 5. Seek 与“不读出错误画面”的保证

`seek(target)` 的固定顺序：

1. 记录目标分片 index，播放头跳到目标时间，进入 waiting。
2. `cancelInFlight()`：abort 全部在途请求并推进 generation。
3. 若目标分片已被驱逐，计入 `refetchGroupRequests` 并按三轨一组重新请求。
4. 请求往返（1 虚拟秒）完成前，渲染层不切换画面——`_render` 只在视频/音频/字幕同 index 全部驻留时执行，因此不会把上一位置的帧当成目标位置显示。
5. 迟到的旧 generation 响应在 append 前被拒绝（`staleDropped`），杜绝快速拖动时的竞态污染。

## 6. 三轨同步渲染

分片按 2 秒边界对齐，渲染条件为三轨同一 index 同时驻留：

```
ready = video.has(i) && audio.has(i) && text.has(i)
rendered = { videoTime: i*2, audioTime: i*2, textTime: i*2 }
```

任一轨道缺失即保持 waiting 与上一帧，恢复后三轨时间戳必然相同。场景断言直接比较三个时间戳与目标分片起点。

## 7. 指标定义

- **累计驱逐时长**：按时间线分片 index 去重（`evictedIndexes`），避免三轨各算一次导致三倍计数；同时保留按轨道分别统计的 `evictedDurationByTrack`。
- **重新请求次数**：seek 命中已驱逐区间的分片组请求数 `refetchGroupRequests`，另记去重分片数与命中次数。
- **请求侧**：`totalRequests / completedRequests / cancelledRequests / staleDropped`。

## 8. 模拟场景

1. **长距离回跳**：播放到 480s 后跳回 60s。60s 处分片早已驱逐，断言触发重新请求、完成前不上屏、完成后三轨同为 60.0s，且远端旧安全区修剪后驻留内存不超过 12MB。
2. **快速连续拖动**：在一个请求往返内连续 seek 到 200/40/350/120/260s，断言每次 abort、generation 推进、无中间位置闪帧，最终三轨对齐 260s。

复现：

```bash
node test/unit-tests.js      # 单元测试（含过期响应竞态）
node test/run-scenarios.js    # 两个规定场景与同步断言
node test/ui-smoke.js         # 界面渲染冒烟（DOM 桩）
```
