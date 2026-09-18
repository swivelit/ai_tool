#!/bin/bash
set -euo pipefail
# No host changes, global aliases, Homebrew bootstrap or sudo pip.
video_python=""
video_check=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) video_check=true; shift ;;
    --python)
      if [[ $# -lt 2 || "$2" != /* || -n "$video_python" ]]; then
        echo 'Use --python /absolute/native/python3.12 once; see docs/VIDEO_MAC_SETUP.md for MacPorts prerequisites.' >&2
        exit 2
      fi
      video_python="$2"; shift 2 ;;
    --help|-h)
      echo 'Usage: bash swico_video_node/scripts/setup_macos.sh [--check] [--python /absolute/native/python3.12]'
      echo '--check is read-only: no Python worker import, venv, download, sudo, credentials or API request.'
      exit 0 ;;
    *) echo 'Unknown argument; run setup_macos.sh --help' >&2; exit 2 ;;
  esac
done
video_script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$video_script_dir/../.." && pwd)"
cd "$repo_root"
source "$video_script_dir/prerequisites_macos.sh"
video_prerequisites "$video_python"
if [[ "$video_check" == true ]]; then exit 0; fi
exec "$video_python" -m swico_video_node.bootstrap
