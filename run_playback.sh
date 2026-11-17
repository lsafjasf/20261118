#!/usr/bin/env bash
# 用浏览器原生 <video> 播放主清单并与解析结果对比。
# 依赖: ~/tools/pw 下的 playwright、Playwright WebKit、本地解包的 GStreamer 插件。
set -euo pipefail
cd "$(dirname "$0")"

FFPROBE=${FFPROBE:-$HOME/tools/ffmpeg/ffprobe}
PW_CACHE="$HOME/.cache/ms-playwright/webkit-2388"

# 1) 先跑校验器，生成解析结果 JSON
python3 hls_validate.py demo/master.m3u8 --ffprobe "$FFPROBE" --json /tmp/hls_ok.json

# 2) 再做浏览器原生播放对比（WebKit 需显式开启 HLS 并回退 playbin2）
export NODE_PATH="$HOME/tools/pw/node_modules"
export BROWSER=webkit
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export GST_PLUGIN_PATH="$PW_CACHE/minibrowser-wpe/sys/lib/gstreamer-1.0"
export WEBKIT_GST_ENABLE_HLS_SUPPORT=1
export WEBKIT_GST_USE_PLAYBIN2=1
node playback_test.js /tmp/hls_ok.json
