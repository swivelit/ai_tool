#!/bin/bash
set -euo pipefail
# No host changes, global aliases, Homebrew bootstrap or sudo pip.
video_python=""
if [[ $# == 2 && "$1" == --python ]]; then video_python="$2"
elif [[ $# != 0 ]]; then
  echo 'Usage: bash swico_video_node/scripts/setup_macos.sh [--python /absolute/native/python3.12]' >&2
  exit 2
fi
if [[ -z "$video_python" ]]; then
  if [[ -x /opt/local/bin/python3.12 ]]; then video_python=/opt/local/bin/python3.12
  else video_python="$(command -v python3.12 || true)"; fi
fi
[[ "$video_python" == /* && -x "$video_python" ]] || {
  echo 'Missing native Python 3.12. Install official MacPorts Tahoe v26, then: sudo /opt/local/bin/port install python312 py312-pip ffmpeg' >&2
  exit 1
}
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
exec "$video_python" -m swico_video_node.bootstrap
