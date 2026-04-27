#!/usr/bin/env bash

JAI_ANDROID_16KB_MIN_LOAD_ALIGNMENT_DEC=16384
JAI_ANDROID_16KB_MIN_LOAD_ALIGNMENT_HEX="0x4000"

jai_android_16kb_normalize() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

jai_android_16kb_is_truthy() {
  case "$(jai_android_16kb_normalize "${1:-}")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

jai_android_16kb_build_type_is_debug() {
  [[ "$(jai_android_16kb_normalize "${1:-}")" == "debug" ]]
}

jai_android_can_skip_16kb_validation() {
  local build_type="$1"

  if ! jai_android_16kb_is_truthy "${JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG:-}"; then
    return 1
  fi

  if jai_android_16kb_build_type_is_debug "$build_type"; then
    return 0
  fi

  printf "JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1 is debug-only; release/production builds cannot skip 16 KB native library validation.\n" >&2
  return 1
}

jai_android_print_16kb_skip_warning() {
  local build_type="$1"

  printf "\nWARNING: Skipping Android 16 KB native library validation for a %s build because JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1.\n" "$build_type" >&2
  printf "This is only for quick local debug installs. Do not ship or release this APK until every lib/<abi>/*.so passes zipalign and ELF LOAD alignment validation.\n" >&2
}

jai_android_find_zipalign() {
  local android_sdk="${1:-}"
  local candidate best=""

  if [[ -n "${JAI_ANDROID_ZIPALIGN:-}" ]]; then
    if [[ -x "$JAI_ANDROID_ZIPALIGN" ]]; then
      printf "%s\n" "$JAI_ANDROID_ZIPALIGN"
      return 0
    fi
    printf "Configured JAI_ANDROID_ZIPALIGN is not executable: %s\n" "$JAI_ANDROID_ZIPALIGN" >&2
    return 1
  fi

  if command -v zipalign >/dev/null 2>&1; then
    command -v zipalign
    return 0
  fi

  if [[ -n "$android_sdk" && -d "$android_sdk/build-tools" ]]; then
    for candidate in "$android_sdk"/build-tools/*/zipalign; do
      [[ -x "$candidate" ]] && best="$candidate"
    done
  fi

  if [[ -n "$best" ]]; then
    printf "%s\n" "$best"
    return 0
  fi

  printf "Missing zipalign. Install Android SDK Build-Tools and ensure zipalign exists at: %s/build-tools/<version>/zipalign\n" "${android_sdk:-\$ANDROID_SDK_ROOT}" >&2
  return 1
}

jai_android_find_readelf() {
  local android_sdk="${1:-}"
  local candidate best=""

  if [[ -n "${JAI_ANDROID_READELF:-}" ]]; then
    if [[ -x "$JAI_ANDROID_READELF" ]]; then
      printf "%s\n" "$JAI_ANDROID_READELF"
      return 0
    fi
    printf "Configured JAI_ANDROID_READELF is not executable: %s\n" "$JAI_ANDROID_READELF" >&2
    return 1
  fi

  if [[ -n "$android_sdk" && -d "$android_sdk/ndk" ]]; then
    for candidate in "$android_sdk"/ndk/*/toolchains/llvm/prebuilt/*/bin/llvm-readelf; do
      [[ -x "$candidate" ]] && best="$candidate"
    done
  fi

  if [[ -n "$best" ]]; then
    printf "%s\n" "$best"
    return 0
  fi

  if command -v llvm-readelf >/dev/null 2>&1; then
    command -v llvm-readelf
    return 0
  fi

  if command -v readelf >/dev/null 2>&1; then
    command -v readelf
    return 0
  fi

  printf "Missing llvm-readelf/readelf. Install Android NDK and ensure llvm-readelf exists at: %s/ndk/<version>/toolchains/llvm/prebuilt/<host>/bin/llvm-readelf, or put llvm-readelf/readelf on PATH.\n" "${android_sdk:-\$ANDROID_SDK_ROOT}" >&2
  return 1
}

jai_android_alignment_to_decimal() {
  local raw="$1"
  local hex

  case "$raw" in
    0x*|0X*)
      hex="${raw#0x}"
      hex="${hex#0X}"
      [[ "$hex" =~ ^[0-9a-fA-F]+$ ]] || return 1
      printf "%d\n" "$((16#$hex))"
      ;;
    *[!0-9]*|"")
      return 1
      ;;
    *)
      printf "%d\n" "$raw"
      ;;
  esac
}

jai_android_abi_from_lib_path() {
  local lib_path="$1"
  local trimmed="${lib_path#lib/}"

  if [[ "$trimmed" != "$lib_path" ]]; then
    printf "%s\n" "${trimmed%%/*}"
    return 0
  fi

  printf "unknown\n"
}

jai_android_validate_elf_load_alignment() {
  local readelf_path="$1"
  local so_path="$2"
  local display_path="$3"
  local abi
  local found_load=0
  local failed=0
  local line align align_dec
  local -a fields

  abi="$(jai_android_abi_from_lib_path "$display_path")"

  if [[ ! -f "$so_path" ]]; then
    printf "ELF LOAD alignment failed: %s (ABI %s) is missing from the extracted APK.\n" "$display_path" "$abi" >&2
    return 1
  fi

  while IFS= read -r line; do
    # shellcheck disable=SC2206
    fields=($line)
    [[ "${fields[0]:-}" == "LOAD" ]] || continue
    found_load=1
    align="${fields[$((${#fields[@]} - 1))]}"

    if ! align_dec="$(jai_android_alignment_to_decimal "$align")"; then
      printf "ELF LOAD alignment failed: %s (ABI %s) has unreadable LOAD segment alignment '%s'.\n" "$display_path" "$abi" "$align" >&2
      failed=1
      continue
    fi

    if [[ "$align_dec" -lt "$JAI_ANDROID_16KB_MIN_LOAD_ALIGNMENT_DEC" ]]; then
      printf "ELF LOAD alignment failed: %s (ABI %s) has LOAD segment alignment %s (%s bytes), expected at least %s / %s bytes.\n" \
        "$display_path" "$abi" "$align" "$align_dec" "$JAI_ANDROID_16KB_MIN_LOAD_ALIGNMENT_HEX" "$JAI_ANDROID_16KB_MIN_LOAD_ALIGNMENT_DEC" >&2
      failed=1
    fi
  done < <("$readelf_path" -l -W "$so_path")

  if [[ "$found_load" == "0" ]]; then
    printf "ELF LOAD alignment failed: %s (ABI %s) has no LOAD segments or could not be inspected with %s.\n" "$display_path" "$abi" "$readelf_path" >&2
    return 1
  fi

  [[ "$failed" == "0" ]]
}

jai_android_validate_apk_16kb_page_size() {
  local apk_path="$1"
  local android_sdk="${2:-}"
  local zipalign_path readelf_path tmp_dir zipalign_log rel_path
  local failed=0
  local so_count=0

  [[ -f "$apk_path" ]] || {
    printf "APK not found for 16 KB validation: %s\n" "$apk_path" >&2
    return 1
  }

  command -v unzip >/dev/null 2>&1 || {
    printf "Missing unzip. Install unzip and ensure it is available on PATH so APK native libraries can be inspected.\n" >&2
    return 1
  }

  zipalign_path="$(jai_android_find_zipalign "$android_sdk")" || return 1
  readelf_path="$(jai_android_find_readelf "$android_sdk")" || return 1

  zipalign_log="$(mktemp)"
  if ! "$zipalign_path" -c -P 16 -v 4 "$apk_path" > "$zipalign_log" 2>&1; then
    cat "$zipalign_log" >&2
    rm -f "$zipalign_log"
    printf "APK zip alignment failed: %s did not pass '%s -c -P 16 -v 4 %s'.\n" "$apk_path" "$zipalign_path" "$apk_path" >&2
    return 1
  fi
  rm -f "$zipalign_log"

  tmp_dir="$(mktemp -d)"
  if ! unzip -q "$apk_path" 'lib/*/*.so' -d "$tmp_dir" >/dev/null 2>&1; then
    rm -rf "$tmp_dir"
    printf "APK native library extraction failed: could not extract lib/*/*.so from %s.\n" "$apk_path" >&2
    return 1
  fi

  while IFS= read -r so_path; do
    so_count=$((so_count + 1))
    rel_path="${so_path#"$tmp_dir"/}"
    if ! jai_android_validate_elf_load_alignment "$readelf_path" "$so_path" "$rel_path"; then
      failed=1
    fi
  done < <(find "$tmp_dir/lib" -type f -name '*.so' | sort)

  rm -rf "$tmp_dir"

  if [[ "$so_count" -eq 0 ]]; then
    printf "APK native library validation failed: no lib/<abi>/*.so files found in %s.\n" "$apk_path" >&2
    return 1
  fi

  if [[ "$failed" != "0" ]]; then
    printf "APK 16 KB native library validation failed for %s.\n" "$apk_path" >&2
    return 1
  fi

  printf "APK 16 KB native library validation passed: %s (%s native libraries checked with %s).\n" "$apk_path" "$so_count" "$readelf_path"
}

jai_android_validate_apk_16kb_or_allow_debug_skip() {
  local apk_path="$1"
  local build_type="$2"
  local android_sdk="${3:-}"

  if jai_android_validate_apk_16kb_page_size "$apk_path" "$android_sdk"; then
    return 0
  fi

  if jai_android_can_skip_16kb_validation "$build_type"; then
    jai_android_print_16kb_skip_warning "$build_type"
    return 0
  fi

  return 1
}
