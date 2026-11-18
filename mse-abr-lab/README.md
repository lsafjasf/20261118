# MSE 本地多码率播放实验

基于 MediaSource Extensions 的本地 ABR（自适应码率）播放实验。三档码率由同一段 60 秒
合成画面编码，切成 2 秒 fMP4 分片，播放器依据缓冲余量与最近下载吞吐量选择码率，
且所有码率切换只发生在分片边界。

## 目录结构

- `scripts/generate-media.js` — 用 ffmpeg 合成母版并编码 300k / 800k / 1500k 三档，切 2 秒 fMP4 分片
- `public/abr.js` — 纯逻辑 ABR 决策器（EWMA 吞吐 + 缓冲水位，可在 Node 下单测）
- `public/network.js` — 网络模拟器（慢速网络 / 瞬时抖动 / 突发降带宽，确定性 RNG）
- `public/player.js` — MSE 播放器（单 SourceBuffer、分片边界切换、卡顿统计）
- `public/app.js`、`public/index.html` — 界面与交互
- `tests/abr.test.js` — ABR 决策单元测试
- `tests/e2e.test.js` — 无头 Chromium 端到端验证
- `server.js` — 零依赖静态服务器

## 码率与分片

| 档位 | 视频码率 | 分辨率 / 帧率 | 音频 | 分片 |
| --- | --- | --- | --- | --- |
| r0 | 300 kbps | 640x360 / 30fps | AAC 48kHz 64k | 2 秒 fMP4 |
| r1 | 800 kbps | 640x360 / 30fps | AAC 48kHz 64k | 2 秒 fMP4 |
| r2 | 1500 kbps | 640x360 / 30fps | AAC 48kHz 64k | 2 秒 fMP4 |

三档共享相同分辨率、帧率、GOP 结构与编码参数（仅码率不同），init segment 二进制一致，
因此切换码率不需要改变 MIME 类型或重建 SourceBuffer，时间轴保持连续。

## ABR 决策规则

每个分片下载前决策一次，决策输入为当前缓冲时长（秒）与 EWMA 吞吐量（bps）：

- `buffer-emergency`：缓冲 < 4 秒时无条件降到最低档
- `throughput-downshift`：缓冲 < 14 秒且 EWMA 吞吐低于当前档码率 × 1.05，降到可承受的最高档（绕过冷却）
- `throughput-upshift`：缓冲 ≥ 6 秒、距上次切换满 3 个分片、且吞吐 ≥ 目标档码率 × 1.35
- `manual-lock` / `hold-manual-lock`：用户锁档后自动策略暂停，仅在分片边界切换到锁定档
- 其余为明确的 hold 原因（`hold-cooldown`、`hold-buffer-building`、`hold-top-tier` 等）

界面显示的是具体原因字符串，不使用“网络良好”这类模糊状态。

## 运行

```bash
npm install
npm run generate   # 生成 public/media 下的三档分片与 manifest.json
npm run serve      # http://127.0.0.1:8088
```

浏览器打开后可用按钮切换网络条件、注入突发降带宽、手动锁定/解锁码率。
也可用 URL 参数预设画像：`/?profile=slow` 或 `/?profile=jitter`。

## 验证

```bash
npm test            # 单元测试 + 端到端测试
npm run test:unit   # 仅 ABR 决策单测
npm run test:e2e    # 仅无头浏览器场景
```

端到端覆盖四组场景，关键断言：

1. **慢速网络**（2.2Mbps 周期跌至 0.5Mbps）：出现 r0→r1→r2 升档与多次降档/恢复，
   每个分片的 `segmentIndex` 连续，切换全部落在分片边界。
2. **瞬时抖动**（4Mbps 基线 + 两次 8 秒 150kbps 突发）：突发期间触发 `buffer-emergency`，
   恢复后重新升档。
3. **手动锁档**：锁定后决策原因仅为 `manual-lock` / `hold-manual-lock`，
   `video.currentTime` 持续前进、分片持续追加，播放不中断；解锁后自动策略恢复。
4. **音频连续性**：9 次码率切换期间 `webkitAudioDecodedByteCount` 单调增长、零卡顿停滞，
   `currentTime` 最大采样间隔 < 0.5 秒，证明音频解码没有重新开始。
