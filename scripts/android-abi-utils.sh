#!/usr/bin/env bash

JAI_ANDROID_DEFAULT_ABIS_CSV="arm64-v8a"
JAI_ANDROID_SUPPORTED_ABIS_CSV="arm64-v8a,x86_64"

jai_android_supported_abi() {
  case "${1:-}" in
    arm64-v8a|x86_64) return 0 ;;
    *) return 1 ;;
  esac
}

jai_android_normalize_abi_list() {
  local raw="${1:-}"
  local normalized token abi existing joined
  local -a tokens=()
  local -a selected=()

  if [[ -z "${raw//[[:space:]]/}" ]]; then
    printf "%s\n" "$JAI_ANDROID_DEFAULT_ABIS_CSV"
    return 0
  fi

  normalized="$(printf "%s" "$raw" | tr -d "\r" | tr ";[:space:]" ",")"
  IFS="," read -ra tokens <<< "$normalized"

  for token in "${tokens[@]}"; do
    abi="$token"
    [[ -z "$abi" ]] && continue

    if ! jai_android_supported_abi "$abi"; then
      printf "Unsupported Android ABI '%s'. Supported ABIs: %s\n" "$abi" "$JAI_ANDROID_SUPPORTED_ABIS_CSV" >&2
      return 1
    fi

    if [[ "${#selected[@]}" -gt 0 ]]; then
      for existing in "${selected[@]}"; do
        [[ "$existing" == "$abi" ]] && continue 2
      done
    fi

    selected+=("$abi")
  done

  if [[ "${#selected[@]}" -eq 0 ]]; then
    printf "%s\n" "$JAI_ANDROID_DEFAULT_ABIS_CSV"
    return 0
  fi

  joined=""
  for abi in "${selected[@]}"; do
    [[ -n "$joined" ]] && joined+=","
    joined+="$abi"
  done

  printf "%s\n" "$joined"
}

jai_android_abi_list_contains() {
  local abi="$1"
  local raw="${2:-}"
  local normalized

  normalized="$(printf "%s" "$raw" | tr -d "\r" | tr ";[:space:]" ",")"
  case ",$normalized," in
    *",$abi,"*) return 0 ;;
    *) return 1 ;;
  esac
}

jai_android_choose_supported_device_abi() {
  local raw="${1:-}"
  local normalized token
  local -a tokens=()

  normalized="$(printf "%s" "$raw" | tr -d "\r" | tr ";[:space:]" ",")"
  IFS="," read -ra tokens <<< "$normalized"

  for token in "${tokens[@]}"; do
    [[ -z "$token" ]] && continue
    if jai_android_supported_abi "$token"; then
      printf "%s\n" "$token"
      return 0
    fi
  done

  printf "No supported Android ABI found in device ABI list '%s'. Supported ABIs: %s\n" "$raw" "$JAI_ANDROID_SUPPORTED_ABIS_CSV" >&2
  return 1
}

jai_android_abi_lists_intersect() {
  local selected_raw="$1"
  local device_raw="$2"
  local selected_csv abi
  local -a selected=()

  selected_csv="$(jai_android_normalize_abi_list "$selected_raw")" || return 1
  IFS="," read -ra selected <<< "$selected_csv"

  for abi in "${selected[@]}"; do
    if jai_android_abi_list_contains "$abi" "$device_raw"; then
      return 0
    fi
  done

  return 1
}

jai_android_read_device_abilist() {
  local abilist=""
  local fallback_abi=""

  abilist="$(adb shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d "\r")" || return 1

  if [[ -z "${abilist//[[:space:]]/}" ]]; then
    fallback_abi="$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d "\r")" || return 1
    abilist="$fallback_abi"
  fi

  printf "%s\n" "$abilist"
}
