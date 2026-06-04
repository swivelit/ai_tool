#!/usr/bin/env bash

JAI_ANDROID_DEFAULT_ABIS_CSV="arm64-v8a"
JAI_ANDROID_SUPPORTED_ABIS_CSV="arm64-v8a,x86_64"

jai_android_split_abi_list() {
  local raw="${1:-}"
  raw="${raw//;/,}"
  raw="${raw//[[:space:]]/,}"

  local IFS=","
  local abi
  for abi in $raw; do
    [[ -n "$abi" ]] && printf "%s\n" "$abi"
  done
}

jai_android_supported_abi() {
  case "${1:-}" in
    arm64-v8a|x86_64) return 0 ;;
    *) return 1 ;;
  esac
}

jai_android_abi_list_contains() {
  local needle="$1"
  local csv="${2:-}"
  local abi

  while IFS= read -r abi; do
    [[ "$abi" == "$needle" ]] && return 0
  done < <(jai_android_split_abi_list "$csv")

  return 1
}

jai_android_normalize_abi_list() {
  local raw="${1:-}"
  local abi
  local normalized=""

  while IFS= read -r abi; do
    if ! jai_android_supported_abi "$abi"; then
      printf "Unsupported Android ABI '%s'. Supported ABIs: %s\n" \
        "$abi" "$JAI_ANDROID_SUPPORTED_ABIS_CSV" >&2
      return 1
    fi

    if [[ -n "$normalized" ]] && jai_android_abi_list_contains "$abi" "$normalized"; then
      continue
    fi

    if [[ -z "$normalized" ]]; then
      normalized="$abi"
    else
      normalized="${normalized},${abi}"
    fi
  done < <(jai_android_split_abi_list "$raw")

  if [[ -z "$normalized" ]]; then
    normalized="$JAI_ANDROID_DEFAULT_ABIS_CSV"
  fi

  printf "%s\n" "$normalized"
}

jai_android_abi_lists_intersect() {
  local left="${1:-}"
  local right="${2:-}"
  local abi

  while IFS= read -r abi; do
    [[ -z "$abi" ]] && continue
    if jai_android_abi_list_contains "$abi" "$right"; then
      return 0
    fi
  done < <(jai_android_split_abi_list "$left")

  return 1
}

jai_android_read_device_abilist() {
  command -v adb >/dev/null 2>&1 || {
    printf "adb was not found in PATH.\n" >&2
    return 1
  }

  local abilist
  abilist="$(adb shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"

  if [[ -z "$abilist" ]]; then
    abilist="$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"
  fi

  if [[ -z "$abilist" ]]; then
    printf "Could not read ro.product.cpu.abilist from the connected Android device.\n" >&2
    return 1
  fi

  printf "%s\n" "$abilist"
}

jai_android_choose_supported_device_abi() {
  local device_abilist="${1:-}"
  local abi

  while IFS= read -r abi; do
    [[ -z "$abi" ]] && continue
    if jai_android_supported_abi "$abi"; then
      printf "%s\n" "$abi"
      return 0
    fi
  done < <(jai_android_split_abi_list "$device_abilist")

  printf "No supported Android ABI found in device ABI list '%s'. Supported ABIs: %s\n" \
    "$device_abilist" "$JAI_ANDROID_SUPPORTED_ABIS_CSV" >&2
  return 1
}
