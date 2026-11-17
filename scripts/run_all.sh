#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== [1/6] 生成带源时间码的测试视频"
python3 scripts/make_source_media.py

echo "== [2/6] 基于剪辑点逐帧映射章节"
python3 scripts/run_mapping.py

echo "== [3/6] 帧精确渲染成片并封装章节"
python3 scripts/render_edit.py

echo "== [4/6] 播放器章节跳转验证"
python3 scripts/verify_player_jumps.py

echo "== [5/6] 全片逐帧映射 SSIM 验证"
python3 scripts/verify_full_mapping.py

echo "== [6/7] 百分比缩放防护测试"
python3 scripts/verify_no_percentage_scaling.py

echo "== [7/7] 章节文件重导入闭环 + 生成播放器页面"
python3 scripts/verify_reimport.py
python3 scripts/make_player_page.py

echo "全部流水线步骤完成。"
