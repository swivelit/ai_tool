import * as FileSystem from "expo-file-system/legacy";

import {
  selectModelTier,
} from "./modelDownloadManager";
import type {
  DeviceCapabilitySnapshot,
  ModelDownloadConfigRoot,
  ModelTierName,
} from "./modelDownloadManager";
import {
  getNativeOnDeviceModelBridge,
} from "./nativeOnDeviceModelBridge";
import type {
  NativeDeviceCapabilitySnapshot,
  NativeOnDeviceModelBridge,
} from "./nativeOnDeviceModelBridge";

type CapabilityFileSystem = {
  getFreeDiskStorageAsync?: () => Promise<number>;
};

type GetDeviceCapabilityOptions = {
  config?: ModelDownloadConfigRoot;
  bridge?: NativeOnDeviceModelBridge | null;
  fileSystem?: CapabilityFileSystem;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  proOptIn?: boolean;
};

const DEFAULT_CACHE_TTL_MS = 30_000;

let cachedSnapshot:
  | { value: DeviceCapabilitySnapshot; createdAtMs: number }
  | null = null;

function finitePositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function normalizeBatteryLevel(value: unknown) {
  const parsed = finitePositiveNumber(value);
  if (parsed == null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function normalizeThermalState(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function normalizeSupportedAbis(value: unknown) {
  if (!Array.isArray(value)) return null;
  const abis = value.map((item) => String(item || "").trim()).filter(Boolean);
  return abis.length ? abis : null;
}

function normalizeNativeSnapshot(
  raw: NativeDeviceCapabilitySnapshot | null | undefined,
): DeviceCapabilitySnapshot {
  const source = raw || {};
  return {
    totalMemoryBytes: finitePositiveNumber(source.totalMemoryBytes),
    availableMemoryBytes: finitePositiveNumber(source.availableMemoryBytes),
    freeStorageBytes: finitePositiveNumber(source.freeStorageBytes),
    lowMemory: normalizeBoolean(source.lowMemory),
    lowRamDevice: normalizeBoolean(source.lowRamDevice),
    lowPowerMode: normalizeBoolean(source.lowPowerMode),
    batteryLevel: normalizeBatteryLevel(source.batteryLevel),
    thermalState: normalizeThermalState(source.thermalState),
    cpuCoreCount: finitePositiveNumber(source.cpuCoreCount),
    supportedAbis: normalizeSupportedAbis(source.supportedAbis),
  };
}

async function getNativeCapabilities(
  bridge: NativeOnDeviceModelBridge | null,
) {
  if (typeof bridge?.getDeviceCapabilities !== "function") {
    return {};
  }
  try {
    return normalizeNativeSnapshot(await bridge.getDeviceCapabilities());
  } catch {
    return {};
  }
}

async function getFreeStorageBytes(fs: CapabilityFileSystem) {
  if (typeof fs.getFreeDiskStorageAsync !== "function") {
    return null;
  }
  try {
    return finitePositiveNumber(await fs.getFreeDiskStorageAsync());
  } catch {
    return null;
  }
}

export function inferPreferredModelTier(
  config?: ModelDownloadConfigRoot,
  deviceInfo: DeviceCapabilitySnapshot = {},
  explicitTier?: ModelTierName,
) {
  return selectModelTier(config, deviceInfo, explicitTier);
}

export function clearDeviceCapabilitiesCache() {
  cachedSnapshot = null;
}

export async function getCachedDeviceCapabilities(
  options: GetDeviceCapabilityOptions = {},
): Promise<DeviceCapabilitySnapshot> {
  const now = Date.now();
  const ttlMs = Math.max(0, Number(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
  if (
    !options.forceRefresh &&
    cachedSnapshot &&
    now - cachedSnapshot.createdAtMs < ttlMs
  ) {
    return cachedSnapshot.value;
  }

  const bridge =
    options.bridge === undefined
      ? getNativeOnDeviceModelBridge()
      : options.bridge;
  const fs = options.fileSystem || FileSystem;
  const nativeSnapshot = await getNativeCapabilities(bridge);
  const freeStorageBytes =
    nativeSnapshot.freeStorageBytes ?? (await getFreeStorageBytes(fs));
  const snapshot: DeviceCapabilitySnapshot = {
    ...nativeSnapshot,
    ...(freeStorageBytes ? { freeStorageBytes } : {}),
    ...(options.proOptIn != null ? { proOptIn: options.proOptIn } : {}),
  };

  const preferredTier = inferPreferredModelTier(options.config, snapshot);
  const value = {
    ...snapshot,
    preferredTier,
  };

  cachedSnapshot = {
    value,
    createdAtMs: now,
  };
  return value;
}
