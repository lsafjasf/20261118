#!/usr/bin/env bash
# Full pipeline: synthesize -> analyze -> evaluate -> report.
set -euo pipefail
cd "$(dirname "$0")"

python3 scripts/synth.py
python3 scripts/analyze.py audio/constant.wav audio/accelerando.wav audio/free.wav
python3 scripts/evaluate.py
python3 scripts/report.py

echo
echo "报告已生成: data/report.md"
echo "编辑器: python3 scripts/serve.py 然后打开提示的 URL"
