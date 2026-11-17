#!/usr/bin/env bash
# End-to-end demo: generate sources, diagnose, repair, verify.
set -euo pipefail
cd "$(dirname "$0")"

FFMPEG_BIN="${FFMPEG:-$(command -v ffmpeg || true)}"
FFPROBE_BIN="${FFPROBE:-$(command -v ffprobe || true)}"
if [ -z "$FFMPEG_BIN" ] && [ -d /tmp/ffstatic ]; then
  FFMPEG_BIN=$(echo /tmp/ffstatic/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg)
  FFPROBE_BIN=$(echo /tmp/ffstatic/ffmpeg-master-latest-linux64-gpl/bin/ffprobe)
fi
export FFMPEG="$FFMPEG_BIN" FFPROBE="$FFPROBE_BIN"

echo "== 1. generate demo sources (main: -2 segments, backup: -1 segment) =="
python3 make_demo.py

echo "== 2. diagnose main playlist =="
python3 playlist_tool.py diagnose demo/main/index.m3u8 || true

echo "== 3. repair from backup, rebuild playlist =="
python3 playlist_tool.py repair \
  --main demo/main/index.m3u8 \
  --backup demo/backup/index.m3u8 \
  --out demo/rebuilt

echo "== 4. verify rebuilt playlist decodes end to end =="
python3 playlist_tool.py verify demo/rebuilt/index.m3u8

echo "== 5. play rebuilt playlist in a real <video> element =="
if [ -d node_modules/playwright ]; then
  node browser_verify.mjs
else
  echo "skip: run 'npm i playwright' first (and set CHROME if needed)"
fi
