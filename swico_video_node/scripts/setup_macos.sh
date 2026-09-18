#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == x86_64 ]] || { echo 'Requires a native Intel Mac, not ARM/Rosetta/Linux'; exit 1; }
xcode-select -p >/dev/null || { echo 'Install Command Line Tools: xcode-select --install'; exit 1; }
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo 'Install reviewed FFmpeg/ffprobe before setup (brew install ffmpeg).'; exit 1; }
python3.12 -c 'import platform,sys; assert platform.machine()=="x86_64" and sys.version_info[:2]==(3,12)'
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
python3.12 -m venv .venv-video
.venv-video/bin/python -m pip install --only-binary=:all: -r swico_video_node/requirements-intel.lock
video_data="${SWICO_VIDEO_DATA_DIR:-$HOME/Library/Application Support/SwicoVideo}"
umask 077
mkdir -p "$video_data/engine"
if [[ ! -d "$video_data/engine/facefusion/.git" ]]; then
  git init "$video_data/engine/facefusion"
  git -C "$video_data/engine/facefusion" fetch --depth 1 https://github.com/facefusion/facefusion.git 03d49d0c7de095a41628a74d94a146214f82837a
  git -C "$video_data/engine/facefusion" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$video_data/engine/facefusion" rev-parse HEAD)" == 03d49d0c7de095a41628a74d94a146214f82837a ]]
.venv-video/bin/python -c 'import onnxruntime as o,platform; assert platform.machine()=="x86_64"; assert "CPUExecutionProvider" in o.get_available_providers(); print("CPU runtime imports OK; native model inference NOT yet verified")'
echo 'No model weights downloaded. Run init, complete genuine rights manifests, then models audit/install.'
