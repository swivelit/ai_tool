#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
  cd "$repo_root/mobile"
  npm run eval:golden
)

(
  cd "$repo_root/backend"
  if [ -x ".venv/bin/python" ]; then
    .venv/bin/python -m pytest tests/test_golden_eval.py -s
  else
    python -m pytest tests/test_golden_eval.py -s
  fi
)
