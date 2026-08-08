#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "FAIL powershell.exe_missing" >&2
  echo "Next: run this script from Git Bash on Windows PowerShell 5.1 or PowerShell 7." >&2
  exit 1
fi
if ! command -v cygpath >/dev/null 2>&1; then
  echo "FAIL cygpath_missing" >&2
  echo "Next: use Git Bash installed with Git for Windows." >&2
  exit 1
fi

PS_SCRIPT="$(cygpath -w "$SCRIPT_DIR/$1")"
shift
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS_SCRIPT" "$@"
