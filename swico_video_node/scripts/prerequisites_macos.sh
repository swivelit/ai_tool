#!/bin/bash
# Sourced by setup_macos.sh. Bash 3.2 + tools shipped with macOS only.
# No downloads, sudo, worker imports, state writes or credential access here.

video_system() { /usr/bin/uname -s; }
video_machine() { /usr/bin/uname -m; }
video_os_version() { /usr/bin/sw_vers -productVersion; }
video_translated() { /usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true; }
video_clt() { /usr/bin/xcode-select -p 2>/dev/null; }
video_port_path() { printf '%s\n' /opt/local/bin/port; }
video_default_python() {
  if [[ -x /opt/local/bin/python3.12 ]]; then printf '%s\n' /opt/local/bin/python3.12
  else command -v python3.12 || true; fi
}
video_default_tool() {
  local video_dir
  # Same supported default locations as runtime.SEARCH. Deliberately not cwd/PATH.
  for video_dir in /opt/local/bin /usr/local/bin /usr/bin /bin; do
    if [[ -f "$video_dir/$1" ]]; then printf '%s\n' "$video_dir/$1"; return; fi
  done
}
video_binary_arch() { /usr/bin/file -L -b "$1" 2>/dev/null; }

video_python_identity() {
  # No site packages, .pyc files or worker import, even with a configured data dir.
  "$1" -I -S -B -c 'import platform,sys; print("%d.%d|%s|%s" % (sys.version_info.major,sys.version_info.minor,platform.system(),platform.machine()))' 2>/dev/null
}

video_configured_tool() {
  # Only reached after native Python validation. Read *tool paths*, not tokens.
  # Preserve an explicitly reviewed alternative installation outside default dirs.
  "$video_python" -I -S -B -c '
import json,os,sys
try:
    record=json.load(open(sys.argv[1],encoding="utf-8"))
    value=record["tools"][sys.argv[2]]["path"]
    if record.get("schema")!=1 or not isinstance(value,str) or not os.path.isabs(value) or any(ord(c)<32 for c in value):
        raise ValueError()
    print(value)
except (OSError,ValueError,KeyError,TypeError):
    sys.exit(1)
' "$1" "$2" 2>/dev/null
}

video_prerequisites() {
  # video_python is the single selected interpreter consumed by the caller.
  video_python="${1:-}"
  local video_failures=0 video_native=false video_python_ok=false
  local video_os video_version video_arch video_port video_clt_dir video_identity
  local video_tool_name video_tool_path video_tool_arch video_config
  video_os="$(video_system)"
  video_arch="$(video_machine)"
  video_version="$(video_os_version 2>/dev/null || true)"
  printf 'system=%q architecture=%q macos_version=%q macos_major=%q\n' \
    "$video_os" "$video_arch" "$video_version" "${video_version%%.*}"
  if [[ "$video_os" != Darwin || "$video_arch" != x86_64 ]]; then
    printf '%s\n' 'platform=unsupported (requires native Intel macOS; no host changes performed)'
    video_failures=$((video_failures+1))
  elif [[ "$(video_translated)" == 1 ]]; then
    printf '%s\n' 'platform=translated_process (Rosetta is not the Intel worker)'
    video_failures=$((video_failures+1))
  else
    video_native=true
    printf '%s\n' 'platform=native_intel'
  fi

  video_clt_dir="$(video_clt || true)"
  if [[ -n "$video_clt_dir" && -d "$video_clt_dir" ]]; then
    printf 'command_line_tools=present path=%q\n' "$video_clt_dir"
  else
    printf '%s\n' 'command_line_tools=missing (on macOS explicitly run xcode-select --install, finish installation, then recheck)'
    video_failures=$((video_failures+1))
  fi
  video_port="$(video_port_path)"
  if [[ -f "$video_port" && -x "$video_port" ]]; then
    printf 'macports=present path=%q (operator checkpoint: /opt/local/bin/port version)\n' "$video_port"
  else
    printf '%s\n' 'macports=missing_or_incomplete (/opt/local/bin/port is absent or not executable)'
  fi

  if [[ -z "$video_python" ]]; then video_python="$(video_default_python)"; fi
  if [[ -z "$video_python" || ! -f "$video_python" || ! -x "$video_python" ]]; then
    printf '%s\n' 'python=missing_or_not_executable (requires native Python 3.12)'
    video_failures=$((video_failures+1))
  elif [[ "$video_python" != /* ]]; then
    printf '%s\n' 'python=absolute_path_required (use --python /absolute/path/to/python3.12)'
    video_failures=$((video_failures+1))
  elif [[ "$video_native" != true ]]; then
    printf '%s\n' 'python=not_run_on_unsupported_host'
  else
    printf 'python_path=%q\n' "$video_python"
    video_identity="$(video_python_identity "$video_python" || true)"
    case "$video_identity" in
      '3.12|Darwin|x86_64') video_python_ok=true; printf '%s\n' 'python=native_3.12' ;;
      '3.12|'*) printf '%s\n' 'python=wrong_architecture_or_platform'; video_failures=$((video_failures+1)) ;;
      *'|Darwin|x86_64') printf '%s\n' 'python=wrong_version (requires 3.12, not another minor)'; video_failures=$((video_failures+1)) ;;
      *) printf '%s\n' 'python=identity_check_failed (installation may be incomplete)'; video_failures=$((video_failures+1)) ;;
    esac
  fi

  video_config="${SWICO_VIDEO_DATA_DIR:-$HOME/Library/Application Support/SwicoVideo}/runtime-tools.json"
  # Match storage.root's supported leading-tilde expansion without shell eval.
  if [[ "$video_config" == '~/'* ]]; then video_config="$HOME/${video_config:2}"; fi
  for video_tool_name in ffmpeg ffprobe; do
    video_tool_path=""
    if [[ -e "$video_config" ]]; then
      if [[ "$video_python_ok" != true ]]; then
        printf '%s=configuration_requires_python (existing reviewed configuration preserved)\n' "$video_tool_name"
        video_failures=$((video_failures+1)); continue
      fi
      if ! video_tool_path="$(video_configured_tool "$video_config" "$video_tool_name")"; then
        printf '%s=invalid_tool_configuration (not overwritten; inspect runtime-tools.json locally)\n' "$video_tool_name"
        video_failures=$((video_failures+1)); continue
      fi
    else video_tool_path="$(video_default_tool "$video_tool_name")"; fi
    if [[ -z "$video_tool_path" || ! -f "$video_tool_path" ]]; then
      printf '%s=missing (the MacPorts ffmpeg port supplies BOTH binaries)\n' "$video_tool_name"
      video_failures=$((video_failures+1))
    elif [[ "$video_tool_path" != /* || ! -x "$video_tool_path" ]]; then
      printf '%s=not_absolute_or_not_executable\n' "$video_tool_name"
      video_failures=$((video_failures+1))
    else
      printf '%s_path=%q\n' "$video_tool_name" "$video_tool_path"
      video_tool_arch="$(video_binary_arch "$video_tool_path" || true)"
      if [[ "$video_tool_arch" != *Mach-O* || "$video_tool_arch" != *x86_64* ]]; then
        printf '%s=wrong_architecture (native Mach-O x86_64 slice required)\n' "$video_tool_name"
        video_failures=$((video_failures+1))
      else printf '%s=present_native_binary (hash/version/codec checked by ordinary setup)\n' "$video_tool_name"; fi
    fi
  done
  printf '%s\n' 'pip_and_venv=not_checked (ordinary bootstrap verifies these without overwriting foreign environments)' \
    'codec_smoke=not_run (ordinary setup runs synthetic libx264 encode/probe/decode; not face inference)' \
    'api_authentication=not_checked models_and_permissions=not_checked templates_and_calibration=not_checked'
  if [[ ! -f "$video_port" || ! -x "$video_port" ]]; then
    printf '%s\n' 'Opening the installation webpage only opens a browser; it does NOT download or install MacPorts.' \
      'Exporting PATH does NOT install a program. port selfupdate is NOT the first installation command.' \
      'MacPorts is not required when a supported alternative native Python/toolchain is already selected.'
    if [[ "$video_native" == true && "${video_version%%.*}" == 26 ]]; then
      printf '%s\n' 'If you need MacPorts: follow the guarded Tahoe v26 download + SHA-256 + installer block in docs/VIDEO_MAC_SETUP.md.' \
        'Official release: https://github.com/macports/macports-base/releases/tag/v2.12.6' \
        'Then require: /opt/local/bin/port version. Only AFTER this succeeds run selfupdate/install.'
    else
      printf '%s\n' 'The documented Tahoe installer is ONLY for macOS 26; do not install it on another OS.'
    fi
  fi
  if (( video_failures )); then
    printf 'prerequisites=blocked blockers=%s (nothing installed; correct the listed prerequisites and rerun --check)\n' "$video_failures"
    return 1
  fi
  printf '%s\n' 'prerequisites=present (NOT video readiness; proceed to ordinary setup, then doctor)'
}
