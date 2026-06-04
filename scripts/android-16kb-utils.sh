#!/usr/bin/env bash

jai_android_16kb_is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

jai_android_can_skip_16kb_validation() {
  local build_type
  build_type="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

  if [[ "$build_type" == "release" || "$build_type" == "production" ]]; then
    printf "Android 16 KB validation is mandatory; release/production builds cannot skip it.\n" >&2
    return 1
  fi

  if jai_android_16kb_is_truthy "${JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG:-}"; then
    return 0
  fi

  printf "Set JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1 to bypass 16 KB validation for a temporary debug-only local install.\n" >&2
  return 1
}

jai_android_find_zipalign() {
  local android_sdk="${1:-}"
  local candidate
  local help_output

  for candidate in "$android_sdk"/build-tools/*/zipalign "$(command -v zipalign 2>/dev/null || true)"; do
    [[ -n "$candidate" ]] || continue
    if [[ -x "$candidate" ]]; then
      help_output="$("$candidate" -h 2>&1 || true)"
      if grep -Eq -- '-P[[:space:]]+<pagesize_kb>' <<< "$help_output"; then
        printf "%s\n" "$candidate"
        return 0
      fi
    fi
  done

  printf "Missing zipalign. Install Android SDK Build-Tools with page-align support and ensure build-tools/<version>/zipalign exists under ANDROID_SDK_ROOT.\n" >&2
  return 1
}

jai_android_find_readelf() {
  local android_sdk="${1:-}"
  local candidate

  if command -v llvm-readelf >/dev/null 2>&1; then
    command -v llvm-readelf
    return 0
  fi

  if command -v readelf >/dev/null 2>&1; then
    command -v readelf
    return 0
  fi

  if command -v llvm-readobj >/dev/null 2>&1; then
    command -v llvm-readobj
    return 0
  fi

  for candidate in \
    "$android_sdk"/ndk/*/toolchains/llvm/prebuilt/*/bin/llvm-readelf \
    "$android_sdk"/ndk-bundle/toolchains/llvm/prebuilt/*/bin/llvm-readelf \
    "$android_sdk"/ndk/*/toolchains/llvm/prebuilt/*/bin/llvm-readobj \
    "$android_sdk"/ndk-bundle/toolchains/llvm/prebuilt/*/bin/llvm-readobj
  do
    if [[ -x "$candidate" ]]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  printf "Missing llvm-readelf/readelf. Install Android NDK and ensure ndk/<version>/toolchains/llvm/prebuilt/<host>/bin/llvm-readelf or llvm-readobj exists under ANDROID_SDK_ROOT.\n" >&2
  return 1
}

jai_android_alignment_to_decimal() {
  local raw="${1:-}"
  local clean

  if [[ "$raw" == 0x* || "$raw" == 0X* ]]; then
    clean="${raw#0x}"
    clean="${clean#0X}"
    printf "%d\n" "$((16#$clean))"
  else
    printf "%d\n" "$raw"
  fi
}

jai_android_validate_elf_load_alignment() {
  local readelf_bin="$1"
  local so_path="$2"
  local display_path="${3:-$2}"
  local tool_name
  local output
  local line
  local align
  local align_decimal
  local abi="unknown"
  local failed=0
  local in_load=0

  if [[ "$display_path" =~ (^|/)lib/([^/]+)/ ]]; then
    abi="${BASH_REMATCH[2]}"
  fi

  tool_name="$(basename "$readelf_bin")"
  if [[ "$tool_name" == "llvm-readobj" ]]; then
    output="$("$readelf_bin" --program-headers "$so_path" 2>&1)" || {
      printf "Could not read ELF program headers for %s with %s:\n%s\n" \
        "$display_path" "$readelf_bin" "$output" >&2
      return 1
    }
  elif ! output="$("$readelf_bin" -l -W "$so_path" 2>&1)"; then
    printf "Could not read ELF program headers for %s with %s:\n%s\n" \
      "$display_path" "$readelf_bin" "$output" >&2
    return 1
  fi

  if [[ "$tool_name" == "llvm-readobj" ]]; then
    while IFS= read -r line; do
      if [[ "$line" =~ Type:[[:space:]]+PT_LOAD ]]; then
        in_load=1
        continue
      fi
      if [[ "$in_load" == "1" && "$line" =~ Alignment:[[:space:]]+([^[:space:]]+) ]]; then
        align="${BASH_REMATCH[1]}"
        align_decimal="$(jai_android_alignment_to_decimal "$align")"

        if (( align_decimal < 16384 )); then
          printf "ELF LOAD alignment too small for %s (ABI %s): found %s, required at least 0x4000 for Android 16 KB pages.\n" \
            "$display_path" "$abi" "$align" >&2
          failed=1
        fi
        in_load=0
      fi
    done <<< "$output"
  else
    while IFS= read -r line; do
      [[ "$line" =~ LOAD ]] || continue
      align="$(awk '{ print $NF }' <<< "$line")"
      [[ -n "$align" ]] || continue
      align_decimal="$(jai_android_alignment_to_decimal "$align")"

      if (( align_decimal < 16384 )); then
        printf "ELF LOAD alignment too small for %s (ABI %s): found %s, required at least 0x4000 for Android 16 KB pages.\n" \
          "$display_path" "$abi" "$align" >&2
        failed=1
      fi
    done <<< "$output"
  fi

  [[ "$failed" == "0" ]]
}

jai_android_validate_apk_16kb() {
  local apk_path="$1"
  local android_sdk="${2:-}"
  local zipalign_bin
  local readelf_bin
  local tmp_dir
  local so_file
  local rel_path
  local failed=0

  [[ -s "$apk_path" ]] || {
    printf "APK was not found or is empty: %s\n" "$apk_path" >&2
    return 1
  }

  command -v unzip >/dev/null 2>&1 || {
    printf "unzip is required to inspect APK native libraries.\n" >&2
    return 1
  }

  zipalign_bin="$(jai_android_find_zipalign "$android_sdk")" || return 1
  readelf_bin="$(jai_android_find_readelf "$android_sdk")" || return 1

  if ! "$zipalign_bin" -c -P 16 -v 4 "$apk_path"; then
    printf "APK zip alignment is not compatible with Android 16 KB pages: %s\n" "$apk_path" >&2
    return 1
  fi

  tmp_dir="$(mktemp -d)"
  if ! unzip -q "$apk_path" "lib/*/*.so" -d "$tmp_dir"; then
    rm -rf "$tmp_dir"
    printf "Could not extract APK native libraries for 16 KB validation: %s\n" "$apk_path" >&2
    return 1
  fi

  while IFS= read -r so_file; do
    rel_path="${so_file#"$tmp_dir"/}"
    if ! jai_android_validate_elf_load_alignment "$readelf_bin" "$so_file" "$rel_path"; then
      failed=1
    fi
  done < <(find "$tmp_dir/lib" -type f -name "*.so" 2>/dev/null)

  rm -rf "$tmp_dir"
  [[ "$failed" == "0" ]]
}

jai_android_validate_apk_16kb_or_allow_debug_skip() {
  local apk_path="$1"
  local build_type="${2:-debug}"
  local android_sdk="${3:-}"

  if jai_android_validate_apk_16kb "$apk_path" "$android_sdk"; then
    return 0
  fi

  if jai_android_can_skip_16kb_validation "$build_type"; then
    printf "WARNING: Android 16 KB APK validation failed, but JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1 allows this debug-only local build to continue.\n" >&2
    return 0
  fi

  return 1
}
