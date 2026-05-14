#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:-all}"

if [[ "$TARGET" == "all" || "$TARGET" == "mobile" ]]; then
  (
    cd "$repo_root/mobile"
    npm run eval:golden
  )
fi

if [[ "$TARGET" == "all" || "$TARGET" == "backend" ]]; then
  (
    cd "$repo_root/backend"
    if [ -x ".venv/bin/python" ]; then
      .venv/bin/python -m pytest tests/test_golden_eval.py -s
    else
      python -m pytest tests/test_golden_eval.py -s
    fi
  )
fi
