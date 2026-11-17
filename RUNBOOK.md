# HLS 清单校验器与原生播放验证

## 文件

- `hls_validate.py` — 清单校验器（仅依赖 Python 标准库）
- `playback_test.js` — 浏览器原生 `<video>` 播放 + 时长对比（Playwright）
- `run_playback.sh` — 一键：校验 → 生成 JSON → 原生播放对比
- `demo/` — ffmpeg 生成的演示内容（2 个变体 × 6 个 fMP4 分片，含 EXT-X-MAP）
- `fault_sim/` — 故障模拟时生成的注入副本（可安全删除）

## 校验项（全部带文件:行号）

- 主清单：`EXTM3U` 头、`EXT-X-STREAM-INF` 的 BANDWIDTH 声明（存在且为正整数）、变体 URI 存在
- 媒体清单：`TARGETDURATION`（每个 EXTINF 不得超过）、`MEDIA-SEQUENCE`、
  分片 URI 文件存在且非空、`EXT-X-MAP` 初始化段存在、VOD 必须有 `EXT-X-ENDLIST`
- 连续性：媒体序列号连续 + 分片齐全
- 码率：实测最高分片码率不应超过声明 BANDWIDTH 的 110%（警告）
- 时长：提供 `--ffprobe` 时，逐个分片对比 EXTINF 声明时长与实测时长
  （fMP4 自动拼接 EXT-X-MAP 初始化段后探测）

## 用法

```bash
# 正常校验（输出每个变体的总时长、首尾分片、连续性）
python3 hls_validate.py demo/master.m3u8 --ffprobe ~/tools/ffmpeg/ffprobe

# 模拟一个分片缺失 / 一个时长不一致（在 fault_sim/ 副本上注入后校验）
python3 hls_validate.py demo/master.m3u8 --ffprobe ~/tools/ffmpeg/ffprobe --simulate missing-segment
python3 hls_validate.py demo/master.m3u8 --ffprobe ~/tools/ffmpeg/ffprobe --simulate duration-mismatch

# 浏览器原生 video 播放 + 时长对比
./run_playback.sh
```

退出码：0 = 通过；1 = 校验/播放失败；2 = 注入故障但未检出。

## 环境说明

- 浏览器用 Playwright WebKit（Safari 内核，支持原生 HLS）；Chromium 桌面版
  不支持原生 HLS 播放。
- WebKit 需环境变量：`WEBKIT_GST_ENABLE_HLS_SUPPORT=1`（启用 HLS）、
  `WEBKIT_GST_USE_PLAYBIN2=1`（GStreamer 1.28 下 playbin3 要求 streams-aware
  解复用器，而 WebKit 沙箱只加载 legacy hlsdemux，需回退 playbin2）。
- WebKit 系统依赖通过 `apt-get download` + `dpkg -x` 解包到
  `~/.cache/ms-playwright/webkit-2388/minibrowser-wpe/sys/lib/`（无需 root）。
