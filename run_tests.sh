#!/usr/bin/env bash
# Regenerate every fixture and run the full orientation test suite.
set -euo pipefail

cd "$(dirname "$0")"
python3 tests/run_tests.py "$@"
