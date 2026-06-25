import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

import bundledModelConfig from "@/data/config/models.json";
import {
  getNativeOnDeviceModelBridge,
  NativeOnDeviceModelAsset,
} from "./nativeOnDeviceModelBridge";

export type ModelDeliveryMode =
  | "download_on_first_launch"
  | "bundled_assets"
  | "local_adapter_dev";

export type ModelDownloadConfigEntry = {
  id: string;
  fileName: string;
  downloadUrl: string;
  downloadUrlEnv?: string | null;
  downloadPath?: string | null;
  expectedBytes?: number | null;
  expectedBytesEnv?: string | null;
  sha256?: string | null;
  sha256Env?: string | null;
  localPath?: string;
  required?: boolean;
  requiredForTiers?: ModelTierName[];
  tier?: ModelTierName;
  devOnly?: boolean;
  allowMissingIntegrity?: boolean;
};

export type ModelTierName = "lite" | "standard" | "pro" | (string & {});

export type DeviceCapabilitySnapshot = {
  totalMemoryBytes?: number | null;
  availableMemoryBytes?: number | null;
  freeStorageBytes?: number | null;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | string | null;
  lowMemory?: boolean | null;
  lowRamDevice?: boolean | null;
  lowPowerMode?: boolean | null;
  batteryLevel?: number | null;
  cpuCoreCount?: number | null;
  supportedAbis?: string[] | null;
  gpuSupported?: boolean | null;
  preferredTier?: ModelTierName | null;
  proOptIn?: boolean | null;
};

export type ModelTierConfig = {
  id?: ModelTierName;
  label?: string;
  description?: string;
  requiredModelIds: string[];
  optionalModelIds?: string[];
  minRamBytes?: number;
  minFreeStorageBytes?: number;
  requiresOptIn?: boolean;
};

export type ModelDeliveryConfig = {
  mode?: ModelDeliveryMode | string;
  storageRoot?: string;
  wifiRecommended?: boolean;
  maxRetries?: number;
  cdnBaseUrl?: string;
  cdnBaseUrlEnv?: string | null;
  requireIntegrityMetadataInProduction?: boolean;
  minFreeBytesBuffer?: number;
  defaultTier?: ModelTierName;
  modelTiers?: Record<string, ModelTierConfig>;
  models?: ModelDownloadConfigEntry[] | Record<string, ModelDownloadConfigEntry>;
};

export type ModelDownloadConfigRoot = {
  modelDelivery?: ModelDeliveryConfig;
  native?: {
    models?: Record<string, NativeOnDeviceModelAsset>;
  };
};

export type ModelInstallRecord = ModelDownloadConfigEntry & {
  fileUri: string;
  exists: boolean;
  valid: boolean;
  bytesOnDisk: number;
  reason?: string;
};

export type ModelInstallStatus = {
  mode: ModelDeliveryMode;
  selectedTier: ModelTierName;
  ready: boolean;
  requiredReady: boolean;
  storageRoot: string;
  wifiRecommended: boolean;
  totalRequiredBytes: number | null;
  installedRequiredBytes: number;
  required: ModelInstallRecord[];
  optional: ModelInstallRecord[];
  missing: ModelInstallRecord[];
  invalid: ModelInstallRecord[];
};

export type ModelDownloadProgress = {
  phase:
    | "checking"
    | "skipped"
    | "downloading"
    | "paused"
    | "reconnecting"
    | "verifying"
    | "installed"
    | "failed";
  modelId?: string;
  fileName?: string;
  modelIndex?: number;
  totalModels?: number;
  bytesWritten?: number;
  downloadedBytes?: number;
  totalBytes?: number | null;
  modelProgress?: number;
  totalProgress?: number;
  speedBytesPerSecond?: number | null;
  etaSeconds?: number | null;
  message: string;
};

export type ModelDownloadResumeState = {
  modelId: string;
  fileName: string;
  targetUri: string;
  tempUri: string;
  downloadUrl: string;
  expectedBytes: number | null;
  resumeData?: string | null;
  savable?: Record<string, unknown> | null;
  selectedTier?: ModelTierName;
  updatedAt: number;
};

export type ModelDownloadHandle = {
  downloadAsync?: () => Promise<{ uri?: string | null; status?: number } | null>;
  pauseAsync?: () => Promise<unknown>;
  resumeAsync?: () => Promise<unknown>;
  savable?: () => Record<string, unknown> | null | undefined;
};

export type ModelDownloadResumableStore = {
  load?: (expected: ModelDownloadResumeState) => Promise<ModelDownloadResumeState | null>;
  save?: (state: ModelDownloadResumeState) => Promise<void>;
  remove?: (state: ModelDownloadResumeState) => Promise<void>;
};

export type EnsureModelsOptions = {
  config?: ModelDownloadConfigRoot;
  onProgress?: (progress: ModelDownloadProgress) => void;
  retries?: number;
  fileSystem?: ModelFileSystem;
  hashFileAsync?: (fileUri: string) => Promise<string>;
  skipHashVerification?: boolean;
  modelTier?: ModelTierName;
  deviceInfo?: DeviceCapabilitySnapshot;
  proOptIn?: boolean;
  resumableStore?: ModelDownloadResumableStore;
  onDownloadCreated?: (download: ModelDownloadHandle, state: ModelDownloadResumeState) => void;
  onDownloadSettled?: (download: ModelDownloadHandle, state: ModelDownloadResumeState) => void;
  isPauseRequested?: () => boolean;
};

type ModelFileSystem = Pick<
  typeof FileSystem,
  | "documentDirectory"
  | "getInfoAsync"
  | "makeDirectoryAsync"
  | "deleteAsync"
  | "moveAsync"
> & {
  createDownloadResumable?: typeof FileSystem.createDownloadResumable;
  readAsStringAsync?: typeof FileSystem.readAsStringAsync;
  getFreeDiskStorageAsync?: () => Promise<number>;
};

const DEFAULT_STORAGE_FOLDER = "models";
const LITE_REQUIRED_MODEL_IDS = [
  "google/gemma-3-4b-it",
  "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF",
];
const ALL_KNOWN_MODEL_IDS = [
  "google/gemma-3-4b-it",
  "Qwen/Qwen3-8B",
  "Qwen/Qwen3-14B",
  "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF",
];
const DEFAULT_MODEL_TIERS: Record<string, ModelTierConfig> = {
  lite: {
    id: "lite",
    requiredModelIds: LITE_REQUIRED_MODEL_IDS,
    optionalModelIds: ["Qwen/Qwen3-8B"],
    description: "Phone-safe starter pack for basic local chat and memory.",
  },
  standard: {
    id: "standard",
    requiredModelIds: ["Qwen/Qwen3-8B", "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF"],
    optionalModelIds: ["google/gemma-3-4b-it"],
    minRamBytes: 8 * 1024 * 1024 * 1024,
    minFreeStorageBytes: 8 * 1024 * 1024 * 1024,
    description: "7B/8B class reasoning pack for capable devices.",
  },
  pro: {
    id: "pro",
    requiredModelIds: ["Qwen/Qwen3-14B", "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF"],
    optionalModelIds: ["Qwen/Qwen3-8B", "google/gemma-3-4b-it"],
    minRamBytes: 16 * 1024 * 1024 * 1024,
    minFreeStorageBytes: 16 * 1024 * 1024 * 1024,
    description: "14B model pack for high-RAM devices or explicit user opt-in.",
  },
};
const PLACEHOLDER_URL_PATTERN = /^https:\/\/YOUR_MODEL_CDN\//i;
const CDN_URL_PATTERN = /^cdn:\/\//i;
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(?:MODEL_CDN_BASE_URL|LOCAL_MODEL_CDN_BASE_URL)\s*\}\}/i;
const TEMPLATE_TOKEN_REPLACE_PATTERN = /\{\{\s*(?:MODEL_CDN_BASE_URL|LOCAL_MODEL_CDN_BASE_URL)\s*\}\}/gi;
const DEFAULT_FREE_SPACE_BUFFER_BYTES = 512 * 1024 * 1024;
const MAX_JS_SHA256_FALLBACK_BYTES = 10 * 1024 * 1024;

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export class ModelInstallError extends Error {
  readonly code = "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE";
  readonly setupCode = "LOCAL_MODEL_SETUP_ERROR";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ModelInstallError";
  }
}

export class ModelDownloadInterruptedError extends Error {
  readonly setupCode = "LOCAL_MODEL_SETUP_ERROR";
  readonly transient = true;

  constructor(
    message: string,
    readonly resumeState?: ModelDownloadResumeState | null,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelDownloadInterruptedError";
  }
}

export function isModelInstallError(error: unknown) {
  return (
    error instanceof ModelInstallError ||
    error instanceof ModelDownloadInterruptedError ||
    (error as any)?.setupCode === "LOCAL_MODEL_SETUP_ERROR"
  );
}

const TRANSIENT_DOWNLOAD_ERROR_PATTERNS = [
  /unable to resolve host/i,
  /network request failed/i,
  /HTTP (?:408|429|5\d\d)\b/i,
  /status (?:408|429|5\d\d)\b/i,
  /\btimeout\b/i,
  /timed out/i,
  /ECONNRESET/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
  /connection lost/i,
  /connection (?:was )?interrupted/i,
  /network connection/i,
  /app\/background pause/i,
  /background/i,
  /pause/i,
];

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

export function isTransientModelDownloadError(error: unknown) {
  if (error instanceof ModelDownloadInterruptedError) return true;
  const message = errorMessage(error);
  return TRANSIENT_DOWNLOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isIntegrityFailureMessage(message: string) {
  return (
    /failed verification/i.test(message) ||
    /failed final verification/i.test(message) ||
    /size_mismatch/i.test(message) ||
    /sha256_mismatch/i.test(message) ||
    /empty_file/i.test(message)
  );
}

function isInvalidModelMetadataMessage(message: string) {
  return (
    /missing a resolved public\/signed CDN URL/i.test(message) ||
    /unresolved download metadata/i.test(message) ||
    /missing expectedBytes/i.test(message) ||
    /missing sha256/i.test(message) ||
    /unsupported URL scheme/i.test(message) ||
    /placeholder YOUR_MODEL_CDN/i.test(message) ||
    /HTTP (?:401|403|404)\b/i.test(message) ||
    /signed URL.*expired|forbidden CDN|missing CDN file/i.test(message)
  );
}

function isNonRetryableDownloadStatusMessage(message: string) {
  return (
    /HTTP (?:401|403|404)\b/i.test(message) ||
    /signed URL.*expired|forbidden CDN|missing CDN file/i.test(message)
  );
}

function normalizedHttpStatus(value: unknown) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function isSuccessfulHttpStatus(status: number) {
  return status >= 200 && status < 300;
}

function isTransientHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function downloadHttpStatusErrorMessage(
  entry: Pick<ModelDownloadConfigEntry, "id" | "fileName">,
  status: number,
) {
  if (status === 401) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP 401 Unauthorized. The signed URL may be expired or missing CDN authorization.`;
  }
  if (status === 403) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP 403 Forbidden. The signed URL may be expired or the CDN denied access.`;
  }
  if (status === 404) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP 404 Not Found. The configured CDN path is missing this GGUF file.`;
  }
  if (status === 408) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP 408 Request Timeout.`;
  }
  if (status === 429) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP 429 Too Many Requests.`;
  }
  if (status >= 500) {
    return `Download for model ${entry.id} (${entry.fileName}) returned HTTP ${status}. The CDN or origin server is temporarily unavailable.`;
  }
  return `Download for model ${entry.id} (${entry.fileName}) returned unexpected HTTP ${status}.`;
}

function configuredRoot(config?: ModelDownloadConfigRoot) {
  return (config || bundledModelConfig) as ModelDownloadConfigRoot;
}

function runtimeEnvCandidates(name?: string | null) {
  const key = String(name || "").trim();
  if (!key) return [];
  const withoutPublicPrefix = key.replace(/^EXPO_PUBLIC_/, "");
  const withPublicPrefix = key.startsWith("EXPO_PUBLIC_") ? key : `EXPO_PUBLIC_${key}`;
  return [key, withPublicPrefix, withoutPublicPrefix].filter(
    (candidate, index, items) => candidate && items.indexOf(candidate) === index,
  );
}

function publicEnvName(name?: string | null) {
  const key = String(name || "").trim();
  if (!key) return "EXPO_PUBLIC_LOCAL_MODEL_*";
  return key.startsWith("EXPO_PUBLIC_") ? key : `EXPO_PUBLIC_${key}`;
}

function readRuntimeValue(name?: string | null) {
  for (const candidate of runtimeEnvCandidates(name)) {
    const extraValue = extra[candidate];
    if (extraValue !== undefined && extraValue !== null && String(extraValue).trim()) {
      return String(extraValue).trim();
    }
    const envValue = (globalThis as any)?.process?.env?.[candidate];
    if (envValue !== undefined && envValue !== null && String(envValue).trim()) {
      return String(envValue).trim();
    }
  }
  return "";
}

function parseRuntimeNumber(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/_/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseRuntimeBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function configuredCdnBaseUrl(config?: ModelDownloadConfigRoot) {
  const root = configuredRoot(config);
  const envName = root.modelDelivery?.cdnBaseUrlEnv || "EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL";
  const configured =
    readRuntimeValue(envName) ||
    readRuntimeValue("EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL") ||
    readRuntimeValue("LOCAL_MODEL_CDN_BASE_URL") ||
    readRuntimeValue("MODEL_CDN_BASE_URL") ||
    String(root.modelDelivery?.cdnBaseUrl || "").trim();
  return configured.replace(/\/+$/, "");
}

function resolveDownloadUrl(entry: ModelDownloadConfigEntry, config?: ModelDownloadConfigRoot) {
  const explicitUrl = readRuntimeValue(entry.downloadUrlEnv);
  const rawUrl = String(
    explicitUrl || entry.downloadUrl || (entry.downloadPath ? `cdn://${entry.downloadPath}` : ""),
  ).trim();

  if (!rawUrl) return "";

  const baseUrl = configuredCdnBaseUrl(config);
  if (CDN_URL_PATTERN.test(rawUrl)) {
    if (!baseUrl) return rawUrl;
    const suffix = rawUrl.replace(CDN_URL_PATTERN, "").replace(/^\/+/, "");
    return `${baseUrl}/${suffix}`;
  }

  if (TEMPLATE_TOKEN_PATTERN.test(rawUrl)) {
    if (!baseUrl) return rawUrl;
    return rawUrl.replace(TEMPLATE_TOKEN_REPLACE_PATTERN, baseUrl);
  }

  return rawUrl;
}

function applyRuntimeEntryOverrides(
  entry: ModelDownloadConfigEntry,
  config?: ModelDownloadConfigRoot,
): ModelDownloadConfigEntry {
  const expectedBytesFromEnv = parseRuntimeNumber(readRuntimeValue(entry.expectedBytesEnv));
  const shaFromEnv = readRuntimeValue(entry.sha256Env);
  return {
    ...entry,
    downloadUrl: resolveDownloadUrl(entry, config),
    expectedBytes: expectedBytesFromEnv ?? entry.expectedBytes ?? null,
    sha256: shaFromEnv || entry.sha256 || null,
  };
}

function requiresProductionIntegrityMetadata(config?: ModelDownloadConfigRoot) {
  const root = configuredRoot(config);
  return parseRuntimeBoolean(
    readRuntimeValue("LOCAL_MODEL_REQUIRE_SHA256") ||
      readRuntimeValue("LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA") ||
      root.modelDelivery?.requireIntegrityMetadataInProduction,
    false,
  );
}

function unresolvedDownloadUrlReason(entry: ModelDownloadConfigEntry) {
  const url = String(entry.downloadUrl || "").trim();
  if (!url) return "empty downloadUrl";
  if (PLACEHOLDER_URL_PATTERN.test(url)) return "placeholder YOUR_MODEL_CDN URL";
  if (CDN_URL_PATTERN.test(url)) return "cdn:// URL without a configured EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL";
  if (TEMPLATE_TOKEN_PATTERN.test(url)) {
    return "downloadUrl template without a configured EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL";
  }
  if (!/^https?:\/\//i.test(url)) return `unsupported URL scheme in ${url}`;
  return "";
}

function assertDownloadMetadata(entry: ModelDownloadConfigEntry, config?: ModelDownloadConfigRoot) {
  const reason = unresolvedDownloadUrlReason(entry);
  if (reason) {
    throw new ModelInstallError(
      `Model ${entry.id} is missing a resolved public/signed CDN URL (${reason}). Set ${publicEnvName(entry.downloadUrlEnv)} or EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL in app config before shipping. Do not hardcode secrets into the mobile app.`,
    );
  }

  if (
    requiresProductionIntegrityMetadata(config) &&
    entry.devOnly !== true &&
    entry.allowMissingIntegrity !== true
  ) {
    const expectedBytes = Number(entry.expectedBytes || 0);
    if (expectedBytes <= 0) {
      throw new ModelInstallError(
        `Model ${entry.id} is missing expectedBytes. Production native_on_device downloads must provide exact byte size metadata in ${publicEnvName(entry.expectedBytesEnv)} before downloading ${entry.fileName}.`,
      );
    }
    if (!normalizeSha(entry.sha256)) {
      throw new ModelInstallError(
        `Model ${entry.id} is missing sha256. Production native_on_device downloads must provide SHA-256 metadata in ${publicEnvName(entry.sha256Env)} before downloading ${entry.fileName}.`,
      );
    }
  }
}

export function validateModelDeliveryConfig(
  config?: ModelDownloadConfigRoot,
  options: { production?: boolean; modelTier?: ModelTierName; deviceInfo?: DeviceCapabilitySnapshot } = {},
) {
  const root = configuredRoot(config);
  const selectedTier = selectModelTier(root, options.deviceInfo, options.modelTier);
  const requiredIds = getRequiredModelIdsForTier(root, selectedTier);

  if (selectedTier === configuredDefaultTier(root) && requiredIds.includes("Qwen/Qwen3-14B")) {
    throw new ModelInstallError(
      "Default model tier must not require Qwen/Qwen3-14B. Pro/14B downloads require high device capability or explicit opt-in.",
    );
  }

  const deliveryModels = root.modelDelivery?.models;
  const entries = Array.isArray(deliveryModels)
    ? deliveryModels
    : deliveryModels && typeof deliveryModels === "object"
      ? Object.values(deliveryModels)
      : [];

  if (options.production) {
    for (const rawEntry of entries) {
      const entry = applyRuntimeEntryOverrides(
        {
          ...rawEntry,
          id: String(rawEntry?.id || "").trim(),
          fileName: String(rawEntry?.fileName || "").trim(),
          downloadUrl: String(rawEntry?.downloadUrl || "").trim(),
          downloadUrlEnv: rawEntry?.downloadUrlEnv || null,
          downloadPath: String(rawEntry?.downloadPath || rawEntry?.localPath || rawEntry?.fileName || "").trim(),
          expectedBytesEnv: rawEntry?.expectedBytesEnv || null,
          sha256Env: rawEntry?.sha256Env || null,
          localPath: String(rawEntry?.localPath || rawEntry?.fileName || "").trim(),
          devOnly: rawEntry?.devOnly === true,
          allowMissingIntegrity: rawEntry?.allowMissingIntegrity === true,
        },
        root,
      );
      if (entry.devOnly || entry.allowMissingIntegrity) continue;
      if (!entry.id || !entry.fileName) {
        throw new ModelInstallError("Production model delivery entry is missing id or fileName.");
      }
      const reason = unresolvedDownloadUrlReason(entry);
      if (reason) {
        throw new ModelInstallError(
          `Production model ${entry.id} has unresolved download metadata: ${reason}.`,
        );
      }
      if (Number(entry.expectedBytes || 0) <= 0) {
        throw new ModelInstallError(
          `Production model ${entry.id} is missing expectedBytes integrity metadata.`,
        );
      }
      if (!normalizeSha(entry.sha256)) {
        throw new ModelInstallError(
          `Production model ${entry.id} is missing sha256 integrity metadata.`,
        );
      }
    }
  }

  return {
    selectedTier,
    requiredModelIds: requiredIds,
  };
}

function freeSpaceBufferBytes(config?: ModelDownloadConfigRoot) {
  const configured = Number(configuredRoot(config).modelDelivery?.minFreeBytesBuffer || 0);
  return configured > 0 ? configured : DEFAULT_FREE_SPACE_BUFFER_BYTES;
}

async function assertEnoughFreeStorage(
  entries: ModelDownloadConfigEntry[],
  options: EnsureModelsOptions,
) {
  const fs = options.fileSystem || FileSystem;
  const getFreeDiskStorageAsync = fs.getFreeDiskStorageAsync || (FileSystem as any).getFreeDiskStorageAsync;
  if (typeof getFreeDiskStorageAsync !== "function") return;

  const requiredBytes = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.expectedBytes || 0)), 0);
  if (requiredBytes <= 0) return;

  const freeBytes = Number(await getFreeDiskStorageAsync());
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return;

  const requiredWithBuffer = requiredBytes + freeSpaceBufferBytes(options.config);
  if (freeBytes < requiredWithBuffer) {
    throw new ModelInstallError(
      `Not enough device storage for required GGUF downloads. Need ${requiredWithBuffer} bytes including safety buffer, but only ${freeBytes} bytes are reported free. Free space and retry; the app will not fall back to backend/OpenAI because models are missing.`,
    );
  }
}

function normalizeMode(value: unknown): ModelDeliveryMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "bundled_assets" || normalized === "local_adapter_dev") {
    return normalized;
  }
  return "download_on_first_launch";
}

export function getModelDeliveryMode(config?: ModelDownloadConfigRoot) {
  const root = configuredRoot(config);
  return normalizeMode(
    readRuntimeValue("LOCAL_MODEL_DELIVERY_MODE") ||
      root.modelDelivery?.mode ||
      "download_on_first_launch",
  );
}

function getStorageRoot(
  config?: ModelDownloadConfigRoot,
  fs: ModelFileSystem = FileSystem,
) {
  const configured = String(configuredRoot(config).modelDelivery?.storageRoot || "").trim();
  if (configured && configured !== "document://models") {
    if (configured.startsWith("file://")) return configured.replace(/\/?$/, "/");
    if (configured.startsWith("document://")) {
      const suffix = configured.replace("document://", "").replace(/^\/+|\/+$/g, "");
      return `${fs.documentDirectory || ""}${suffix}/`;
    }
  }
  return `${fs.documentDirectory || ""}${DEFAULT_STORAGE_FOLDER}/`;
}

function normalizeTierName(value: unknown, fallback: ModelTierName = "lite"): ModelTierName {
  const normalized = String(value || "").trim().toLowerCase();
  return (normalized || fallback) as ModelTierName;
}

function configuredTiers(config?: ModelDownloadConfigRoot): Record<string, ModelTierConfig> {
  const root = configuredRoot(config);
  return {
    ...DEFAULT_MODEL_TIERS,
    ...(root.modelDelivery?.modelTiers || {}),
  };
}

function configuredDefaultTier(config?: ModelDownloadConfigRoot): ModelTierName {
  return normalizeTierName(configuredRoot(config).modelDelivery?.defaultTier, "lite");
}

function finitePositiveBytes(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function meetsTierFloor(tier: ModelTierConfig, deviceInfo: DeviceCapabilitySnapshot = {}) {
  const minRam = finitePositiveBytes(tier.minRamBytes);
  if (minRam) {
    const memory = finitePositiveBytes(deviceInfo.totalMemoryBytes);
    if (!memory || memory < minRam) return false;
  }

  const minStorage = finitePositiveBytes(tier.minFreeStorageBytes);
  if (minStorage) {
    const freeStorage = finitePositiveBytes(deviceInfo.freeStorageBytes);
    if (!freeStorage || freeStorage < minStorage) return false;
  }

  return true;
}

function normalizedBatteryLevel(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function deviceIsConstrained(deviceInfo: DeviceCapabilitySnapshot = {}) {
  const thermal = String(deviceInfo.thermalState || "").trim().toLowerCase();
  const batteryLevel = normalizedBatteryLevel(deviceInfo.batteryLevel);
  const availableMemory = finitePositiveBytes(deviceInfo.availableMemoryBytes);
  return (
    thermal === "serious" ||
    thermal === "critical" ||
    deviceInfo.lowMemory === true ||
    deviceInfo.lowRamDevice === true ||
    deviceInfo.lowPowerMode === true ||
    (batteryLevel != null && batteryLevel < 0.15) ||
    (availableMemory != null && availableMemory < 1024 * 1024 * 1024)
  );
}

function inferredTierForDevice(
  config?: ModelDownloadConfigRoot,
  deviceInfo: DeviceCapabilitySnapshot = {},
): ModelTierName {
  const tiers = configuredTiers(config);
  const fallbackTier = tiers.lite ? "lite" : configuredDefaultTier(config);
  const totalMemory = finitePositiveBytes(deviceInfo.totalMemoryBytes);
  if (!totalMemory || deviceIsConstrained(deviceInfo)) {
    return fallbackTier;
  }

  if (tiers.pro && meetsTierFloor(tiers.pro, deviceInfo)) {
    return "pro";
  }
  if (tiers.standard && meetsTierFloor(tiers.standard, deviceInfo)) {
    return "standard";
  }
  return fallbackTier;
}

export function selectModelTier(
  config?: ModelDownloadConfigRoot,
  deviceInfo: DeviceCapabilitySnapshot = {},
  explicitTier?: ModelTierName,
): ModelTierName {
  const tiers = configuredTiers(config);
  const defaultTier = configuredDefaultTier(config);
  const fallbackTier = tiers.lite ? "lite" : tiers[defaultTier] ? defaultTier : "lite";
  const requested = normalizeTierName(
    explicitTier || deviceInfo.preferredTier || inferredTierForDevice(config, deviceInfo),
    fallbackTier,
  );

  if (deviceIsConstrained(deviceInfo)) {
    return fallbackTier;
  }

  if (!tiers[requested]) {
    return fallbackTier;
  }

  if (requested === "lite") {
    return requested;
  }

  const tier = tiers[requested];
  if (requested === "pro") {
    return meetsTierFloor(tier, deviceInfo)
      ? requested
      : tiers.standard && meetsTierFloor(tiers.standard, deviceInfo)
        ? "standard"
        : fallbackTier;
  }

  return meetsTierFloor(tier, deviceInfo) ? requested : fallbackTier;
}

export function getRequiredModelIdsForTier(
  config?: ModelDownloadConfigRoot,
  tier?: ModelTierName,
) {
  const tiers = configuredTiers(config);
  const selectedTier = normalizeTierName(tier || configuredDefaultTier(config), "lite");
  const tierConfig = tiers[selectedTier] || tiers[configuredDefaultTier(config)] || tiers.lite;
  return (tierConfig?.requiredModelIds || LITE_REQUIRED_MODEL_IDS).filter(Boolean);
}

function normalizeTierList(value: unknown): ModelTierName[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeTierName(item)).filter(Boolean);
}

function normalizedSelectedTier(
  config?: ModelDownloadConfigRoot,
  options: Pick<EnsureModelsOptions, "modelTier" | "deviceInfo" | "proOptIn"> = {},
) {
  return selectModelTier(
    config,
    {
      ...(options.deviceInfo || {}),
      proOptIn: options.proOptIn ?? options.deviceInfo?.proOptIn ?? false,
    },
    options.modelTier,
  );
}

function normalizeEntries(
  config?: ModelDownloadConfigRoot,
  options: Pick<EnsureModelsOptions, "modelTier" | "deviceInfo" | "proOptIn"> = {},
): ModelDownloadConfigEntry[] {
  const root = configuredRoot(config);
  const selectedTier = normalizedSelectedTier(root, options);
  const tierRequiredIds = new Set(getRequiredModelIdsForTier(root, selectedTier));
  const hasTierRules = Boolean(root.modelDelivery?.modelTiers);
  const deliveryModels = root.modelDelivery?.models;
  const entries = Array.isArray(deliveryModels)
    ? deliveryModels
    : deliveryModels && typeof deliveryModels === "object"
      ? Object.values(deliveryModels)
      : [];

  const fromDelivery = entries
    .map((entry) =>
      applyRuntimeEntryOverrides(
        {
          ...entry,
          id: String(entry?.id || "").trim(),
          fileName: String(entry?.fileName || "").trim(),
          downloadUrl: String(entry?.downloadUrl || "").trim(),
          downloadUrlEnv: entry?.downloadUrlEnv || null,
          downloadPath: String(entry?.downloadPath || entry?.localPath || entry?.fileName || "").trim(),
          expectedBytesEnv: entry?.expectedBytesEnv || null,
          sha256Env: entry?.sha256Env || null,
          localPath: String(entry?.localPath || entry?.fileName || "").trim(),
          required: hasTierRules
            ? tierRequiredIds.has(String(entry?.id || "").trim()) ||
              normalizeTierList(entry?.requiredForTiers).includes(selectedTier)
            : entry?.required !== false,
          requiredForTiers: normalizeTierList(entry?.requiredForTiers),
          tier: entry?.tier,
          devOnly: entry?.devOnly === true,
          allowMissingIntegrity: entry?.allowMissingIntegrity === true,
        },
        root,
      ),
    )
    .filter((entry) => entry.id && entry.fileName);

  if (fromDelivery.length) return fromDelivery;

  const nativeModels = root.native?.models || {};
  const ids = Object.keys(nativeModels).length ? Object.keys(nativeModels) : ALL_KNOWN_MODEL_IDS;
  return ids.map((id) => {
    const asset = nativeModels[id] || ({} as NativeOnDeviceModelAsset);
    const fileName = String(asset.fileName || asset.modelPath || "").split("/").pop() || `${id}.gguf`;
    return applyRuntimeEntryOverrides(
      {
        id,
        fileName,
        downloadUrl: `cdn://models/${fileName}`,
        downloadPath: `models/${fileName}`,
        localPath: `models/${fileName}`,
        expectedBytes: null,
        sha256: null,
        required: tierRequiredIds.has(id),
      },
      root,
    );
  });
}

function modelFileUri(
  entry: ModelDownloadConfigEntry,
  config?: ModelDownloadConfigRoot,
  fs: ModelFileSystem = FileSystem,
) {
  const storageRoot = getStorageRoot(config, fs);
  const leaf = String(entry.localPath || entry.fileName)
    .replace(/^file:\/\//, "")
    .replace(/^models\//, "")
    .replace(/^\/+/, "");
  return `${storageRoot}${leaf}`;
}

function normalizeSha(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

async function ensureDirectory(uri: string, fs: ModelFileSystem) {
  await fs.makeDirectoryAsync(uri, { intermediates: true }).catch(() => undefined);
}

async function getBytesOnDisk(fileUri: string, fs: ModelFileSystem) {
  const info = await fs.getInfoAsync(fileUri, { size: true } as any);
  return {
    exists: Boolean(info.exists),
    size: Number((info as any).size || 0),
  };
}

async function validateInstalledFile(
  entry: ModelDownloadConfigEntry,
  fileUri: string,
  options: EnsureModelsOptions,
): Promise<ModelInstallRecord> {
  const fs = options.fileSystem || FileSystem;
  const info = await getBytesOnDisk(fileUri, fs);
  const recordBase = {
    ...entry,
    fileUri,
    exists: info.exists,
    bytesOnDisk: info.size,
  };

  if (!info.exists) {
    return { ...recordBase, valid: false, reason: "missing" };
  }
  if (info.size <= 0) {
    return { ...recordBase, valid: false, reason: "empty_file" };
  }
  const expectedBytes = Number(entry.expectedBytes || 0);
  if (expectedBytes > 0 && info.size !== expectedBytes) {
    return {
      ...recordBase,
      valid: false,
      reason: `size_mismatch expected=${expectedBytes} actual=${info.size}`,
    };
  }

  const expectedSha = normalizeSha(entry.sha256);
  if (expectedSha && options.skipHashVerification !== true) {
    const hashFileAsync = options.hashFileAsync || defaultHashFileSha256Async;
    const actualSha = normalizeSha(await hashFileAsync(fileUri));
    if (actualSha !== expectedSha) {
      return {
        ...recordBase,
        valid: false,
        reason: `sha256_mismatch expected=${expectedSha} actual=${actualSha}`,
      };
    }
  }

  return { ...recordBase, valid: true };
}

function installRecordDiagnostic(entry: Pick<ModelInstallRecord, "id" | "fileName" | "fileUri" | "exists" | "reason">) {
  if (!entry.exists) {
    return `${entry.id} missing model file ${entry.fileName} at ${entry.fileUri}`;
  }
  return `${entry.id} invalid model file ${entry.fileName}: ${entry.reason || "verification failed"}`;
}

function createResumeState(
  entry: ModelDownloadConfigEntry,
  targetUri: string,
  tempUri: string,
  selectedTier?: ModelTierName,
): ModelDownloadResumeState {
  return {
    modelId: entry.id,
    fileName: entry.fileName,
    targetUri,
    tempUri,
    downloadUrl: entry.downloadUrl,
    expectedBytes: Number(entry.expectedBytes || 0) || null,
    selectedTier,
    updatedAt: Date.now(),
  };
}

function resumeStateMatches(
  stored: ModelDownloadResumeState | null | undefined,
  expected: ModelDownloadResumeState,
) {
  return Boolean(
    stored &&
      stored.modelId === expected.modelId &&
      stored.fileName === expected.fileName &&
      stored.targetUri === expected.targetUri &&
      stored.tempUri === expected.tempUri &&
      stored.downloadUrl === expected.downloadUrl &&
      (!stored.selectedTier || !expected.selectedTier || stored.selectedTier === expected.selectedTier),
  );
}

function safeDownloadSavable(download: ModelDownloadHandle | null | undefined) {
  if (typeof download?.savable !== "function") return null;
  try {
    const savable = download.savable();
    return savable && typeof savable === "object" ? savable : null;
  } catch {
    return null;
  }
}

function resumeDataFromSavable(savable: Record<string, unknown> | null | undefined) {
  const resumeData = savable?.resumeData;
  return typeof resumeData === "string" && resumeData.length > 0 ? resumeData : null;
}

function mergeResumeState(
  base: ModelDownloadResumeState,
  download?: ModelDownloadHandle | null,
  patch: Partial<ModelDownloadResumeState> = {},
): ModelDownloadResumeState {
  const savable = safeDownloadSavable(download);
  return {
    ...base,
    ...patch,
    resumeData:
      patch.resumeData ??
      resumeDataFromSavable(savable) ??
      resumeDataFromSavable(patch.savable) ??
      base.resumeData ??
      null,
    savable: (savable || patch.savable || base.savable || null) as Record<string, unknown> | null,
    updatedAt: Date.now(),
  };
}

async function persistResumeState(
  options: EnsureModelsOptions,
  state: ModelDownloadResumeState,
) {
  await options.resumableStore?.save?.(state).catch(() => undefined);
}

async function removeResumeState(
  options: EnsureModelsOptions,
  state: ModelDownloadResumeState,
) {
  await options.resumableStore?.remove?.(state).catch(() => undefined);
}

function totalKnownBytes(entries: ModelDownloadConfigEntry[]) {
  let total = 0;
  for (const entry of entries) {
    const bytes = Number(entry.expectedBytes || 0);
    if (bytes <= 0) return null;
    total += bytes;
  }
  return total;
}

type DownloadProgressTotals = {
  expectedBytesByIndex: Array<number | null>;
  writtenBytesByIndex: number[];
  startedAtMs: number;
  samples: Array<{ timestampMs: number; downloadedBytes: number }>;
};

const SPEED_SAMPLE_WINDOW_MS = 20_000;
const MIN_ETA_ELAPSED_MS = 10_000;
const MIN_ETA_DOWNLOADED_BYTES = 16 * 1024 * 1024;
const MIN_MEANINGFUL_SPEED_SAMPLES = 3;
const MIN_RELIABLE_SPEED_BYTES_PER_SECOND = 16 * 1024;
const MAX_RELIABLE_ETA_SECONDS = 12 * 60 * 60;

function createDownloadProgressTotals(entries: ModelDownloadConfigEntry[]): DownloadProgressTotals {
  return {
    expectedBytesByIndex: entries.map((entry) => Number(entry.expectedBytes || 0) || null),
    writtenBytesByIndex: entries.map(() => 0),
    startedAtMs: Date.now(),
    samples: [],
  };
}

function appendDownloadProgressSample(
  totals: DownloadProgressTotals,
  timestampMs: number,
  downloadedBytes: number,
) {
  const previous = totals.samples[totals.samples.length - 1];
  if (
    previous &&
    previous.timestampMs === timestampMs &&
    previous.downloadedBytes === downloadedBytes
  ) {
    return;
  }
  totals.samples.push({ timestampMs, downloadedBytes });
  const firstAllowedMs = timestampMs - SPEED_SAMPLE_WINDOW_MS;
  while (
    totals.samples.length > 2 &&
    totals.samples[1].timestampMs < firstAllowedMs
  ) {
    totals.samples.shift();
  }
}

function meaningfulProgressSampleCount(samples: DownloadProgressTotals["samples"]) {
  let count = 0;
  let lastBytes = -1;
  for (const sample of samples) {
    if (sample.downloadedBytes > lastBytes) {
      count += 1;
      lastBytes = sample.downloadedBytes;
    }
  }
  return count;
}

function recentSpeedBytesPerSecond(
  samples: DownloadProgressTotals["samples"],
  nowMs: number,
) {
  const windowStartMs = nowMs - SPEED_SAMPLE_WINDOW_MS;
  const inWindow = samples.filter((sample) => sample.timestampMs >= windowStartMs);
  const first = inWindow[0] || samples[0];
  const last = inWindow[inWindow.length - 1] || samples[samples.length - 1];
  if (!first || !last || last.downloadedBytes <= first.downloadedBytes) return null;
  const elapsedSeconds = (last.timestampMs - first.timestampMs) / 1000;
  if (elapsedSeconds < 0.5) return null;
  const speed = (last.downloadedBytes - first.downloadedBytes) / elapsedSeconds;
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

function reliableEtaSeconds(
  totals: DownloadProgressTotals,
  totalBytes: number | null,
  downloadedBytes: number,
  speedBytesPerSecond: number | null,
  nowMs: number,
) {
  if (!totalBytes || totalBytes <= downloadedBytes) return null;
  if (!speedBytesPerSecond || speedBytesPerSecond < MIN_RELIABLE_SPEED_BYTES_PER_SECOND) {
    return null;
  }
  const elapsedMs = nowMs - totals.startedAtMs;
  const hasEnoughHistory =
    elapsedMs >= MIN_ETA_ELAPSED_MS || downloadedBytes >= MIN_ETA_DOWNLOADED_BYTES;
  if (!hasEnoughHistory) return null;
  if (meaningfulProgressSampleCount(totals.samples) < MIN_MEANINGFUL_SPEED_SAMPLES) {
    return null;
  }
  const etaSeconds = Math.max(0, (totalBytes - downloadedBytes) / speedBytesPerSecond);
  if (!Number.isFinite(etaSeconds) || etaSeconds > MAX_RELIABLE_ETA_SECONDS) {
    return null;
  }
  return etaSeconds;
}

function aggregateDownloadProgress(
  totals: DownloadProgressTotals,
  targetIndex: number,
  writtenBytes: number,
  totalBytesForTarget: number | null,
  fallbackTotalProgress: number,
) {
  const nowMs = Date.now();
  const index = Math.max(0, targetIndex - 1);
  if (totalBytesForTarget && totalBytesForTarget > 0) {
    totals.expectedBytesByIndex[index] = totalBytesForTarget;
  }
  totals.writtenBytesByIndex[index] = Math.max(0, writtenBytes);

  const allBytesKnown = totals.expectedBytesByIndex.every(
    (value) => Number(value || 0) > 0,
  );
  const totalBytes = allBytesKnown
    ? totals.expectedBytesByIndex.reduce<number>(
        (sum, value) => sum + Number(value || 0),
        0,
      )
    : null;
  const downloadedBytes = totals.writtenBytesByIndex.reduce((sum, value) => sum + value, 0);
  appendDownloadProgressSample(totals, nowMs, downloadedBytes);
  const speedBytesPerSecond = recentSpeedBytesPerSecond(totals.samples, nowMs);
  const etaSeconds = reliableEtaSeconds(
    totals,
    totalBytes,
    downloadedBytes,
    speedBytesPerSecond,
    nowMs,
  );

  return {
    bytesWritten: downloadedBytes,
    downloadedBytes,
    totalBytes,
    speedBytesPerSecond,
    etaSeconds,
    totalProgress: totalBytes
      ? Math.max(0, Math.min(1, downloadedBytes / totalBytes))
      : Math.max(0, Math.min(1, fallbackTotalProgress)),
  };
}

export async function getModelInstallStatus(
  options: EnsureModelsOptions = {},
): Promise<ModelInstallStatus> {
  const fs = options.fileSystem || FileSystem;
  const config = options.config;
  const mode = getModelDeliveryMode(config);
  const selectedTier = normalizedSelectedTier(config, options);
  const storageRoot = getStorageRoot(config, fs);
  const entries = normalizeEntries(config, options);
  const requiredEntries = entries.filter((entry) => entry.required !== false);
  const optionalEntries = entries.filter((entry) => entry.required === false);

  options.onProgress?.({
    phase: "checking",
    totalModels: requiredEntries.length,
    totalBytes: totalKnownBytes(requiredEntries),
    message: "Checking local GGUF model files…",
  });

  if (mode !== "download_on_first_launch") {
    const records = entries.map((entry) => ({
      ...entry,
      fileUri: modelFileUri(entry, config, fs),
      exists: mode === "local_adapter_dev" ? true : false,
      valid: mode === "local_adapter_dev" ? true : false,
      bytesOnDisk: 0,
      reason: mode === "bundled_assets" ? "bundled_asset_verified_by_native_runtime" : undefined,
    }));
    const required = records.filter((entry) => entry.required !== false);
    const optional = records.filter((entry) => entry.required === false);
    return {
      mode,
      selectedTier,
      ready: true,
      requiredReady: true,
      storageRoot,
      wifiRecommended: Boolean(configuredRoot(config).modelDelivery?.wifiRecommended),
      totalRequiredBytes: totalKnownBytes(requiredEntries),
      installedRequiredBytes: 0,
      required,
      optional,
      missing: [],
      invalid: [],
    };
  }

  await ensureDirectory(storageRoot, fs);

  const required = await Promise.all(
    requiredEntries.map((entry) => validateInstalledFile(entry, modelFileUri(entry, config, fs), options)),
  );
  const optional = await Promise.all(
    optionalEntries.map((entry) => validateInstalledFile(entry, modelFileUri(entry, config, fs), options)),
  );
  const missing = required.filter((entry) => !entry.exists);
  const invalid = required.filter((entry) => entry.exists && !entry.valid);
  const requiredReady = required.every((entry) => entry.valid);

  return {
    mode,
    selectedTier,
    ready: requiredReady,
    requiredReady,
    storageRoot,
    wifiRecommended: Boolean(configuredRoot(config).modelDelivery?.wifiRecommended),
    totalRequiredBytes: totalKnownBytes(requiredEntries),
    installedRequiredBytes: required
      .filter((entry) => entry.valid)
      .reduce((sum, entry) => sum + entry.bytesOnDisk, 0),
    required,
    optional,
    missing,
    invalid,
  };
}

async function downloadOneModel(
  entry: ModelDownloadConfigEntry,
  index: number,
  total: number,
  options: EnsureModelsOptions,
  progressTotals: DownloadProgressTotals,
  selectedTier?: ModelTierName,
) {
  const fs = options.fileSystem || FileSystem;
  const config = options.config;
  const targetUri = modelFileUri(entry, config, fs);
  const tempUri = `${targetUri}.download`;
  const expectedBytes = Number(entry.expectedBytes || 0) || null;
  const baseResumeState = createResumeState(entry, targetUri, tempUri, selectedTier);

  assertDownloadMetadata(entry, config);
  await assertEnoughFreeStorage([entry], options);

  if (options.isPauseRequested?.()) {
    await persistResumeState(options, baseResumeState);
    const pausedTotals = aggregateDownloadProgress(
      progressTotals,
      index,
      0,
      expectedBytes,
      (index - 1) / total,
    );
    options.onProgress?.({
      phase: "paused",
      modelId: entry.id,
      fileName: entry.fileName,
      modelIndex: index,
      totalModels: total,
      ...pausedTotals,
      modelProgress: 0,
      message: "Connection interrupted. Local setup can resume.",
    });
    throw new ModelDownloadInterruptedError("app/background pause", baseResumeState);
  }

  const storedResumeState = await options.resumableStore?.load?.(baseResumeState).catch(() => null);
  const matchingResumeState = resumeStateMatches(storedResumeState, baseResumeState)
    ? storedResumeState
    : null;
  const resumeData = matchingResumeState?.resumeData || resumeDataFromSavable(matchingResumeState?.savable);
  const tempInfo = resumeData
    ? await getBytesOnDisk(tempUri, fs).catch(() => ({ exists: false, size: 0 }))
    : { exists: false, size: 0 };
  const resumeBaseBytes = resumeData && tempInfo.exists ? Math.max(0, tempInfo.size) : 0;

  const initialTotals = aggregateDownloadProgress(
    progressTotals,
    index,
    resumeBaseBytes,
    expectedBytes,
    (index - 1) / total,
  );
  options.onProgress?.({
    phase: "downloading",
    modelId: entry.id,
    fileName: entry.fileName,
    modelIndex: index,
    totalModels: total,
    ...initialTotals,
    modelProgress: expectedBytes ? Math.min(1, resumeBaseBytes / expectedBytes) : 0,
    message: "Downloading local AI files...",
  });

  if (typeof fs.createDownloadResumable !== "function") {
    throw new ModelInstallError(
      "expo-file-system createDownloadResumable() is unavailable; cannot download GGUF models safely on this build.",
    );
  }

  const download = (fs.createDownloadResumable as any)(
    entry.downloadUrl,
    tempUri,
    {},
    (progress: { totalBytesWritten?: number; totalBytesExpectedToWrite?: number }) => {
      const rawWritten = Number(progress.totalBytesWritten || 0);
      const totalBytes = Number(progress.totalBytesExpectedToWrite || expectedBytes || 0) || null;
      const resumedWritten =
        resumeBaseBytes > 0 && rawWritten > 0 && rawWritten < resumeBaseBytes
          ? resumeBaseBytes + rawWritten
          : rawWritten;
      const written = Math.max(resumeBaseBytes, resumedWritten);
      const modelProgress = totalBytes ? Math.min(1, written / totalBytes) : 0;
      const aggregate = aggregateDownloadProgress(
        progressTotals,
        index,
        written,
        totalBytes,
        (index - 1 + modelProgress) / total,
      );
      options.onProgress?.({
        phase: "downloading",
        modelId: entry.id,
        fileName: entry.fileName,
        modelIndex: index,
        totalModels: total,
        ...aggregate,
        modelProgress,
        message: "Downloading local AI files...",
      });
    },
    resumeData || undefined,
  );

  const initialResumeState = mergeResumeState(baseResumeState, download as ModelDownloadHandle, {
    resumeData: resumeData || null,
    savable: matchingResumeState?.savable || null,
  });
  await persistResumeState(options, initialResumeState);
  options.onDownloadCreated?.(download as ModelDownloadHandle, initialResumeState);

  let result: { uri?: string | null; status?: number } | null | undefined;
  try {
    result = await (download as ModelDownloadHandle).downloadAsync?.();
  } catch (error) {
    const transient = options.isPauseRequested?.() || isTransientModelDownloadError(error);
    if (transient) {
      const interruptedState = mergeResumeState(initialResumeState, download as ModelDownloadHandle);
      await persistResumeState(options, interruptedState);
      const aggregate = aggregateDownloadProgress(
        progressTotals,
        index,
        Math.max(
          resumeBaseBytes,
          progressTotals.writtenBytesByIndex[index - 1] || 0,
        ),
        expectedBytes,
        (index - 1) / total,
      );
      options.onProgress?.({
        phase: options.isPauseRequested?.() ? "paused" : "reconnecting",
        modelId: entry.id,
        fileName: entry.fileName,
        modelIndex: index,
        totalModels: total,
        ...aggregate,
        modelProgress: expectedBytes
          ? Math.min(1, (progressTotals.writtenBytesByIndex[index - 1] || 0) / expectedBytes)
          : undefined,
        message: "Connection interrupted. Local setup can resume.",
      });
      throw new ModelDownloadInterruptedError(
        errorMessage(error) || "Model download interrupted.",
        interruptedState,
        error,
      );
    }
    throw error;
  } finally {
    options.onDownloadSettled?.(download as ModelDownloadHandle, initialResumeState);
  }

  const httpStatus = normalizedHttpStatus(result?.status);
  if (httpStatus != null && !isSuccessfulHttpStatus(httpStatus)) {
    const statusMessage = downloadHttpStatusErrorMessage(entry, httpStatus);
    if (isTransientHttpStatus(httpStatus) || options.isPauseRequested?.()) {
      const interruptedState = mergeResumeState(initialResumeState, download as ModelDownloadHandle);
      await persistResumeState(options, interruptedState);
      const aggregate = aggregateDownloadProgress(
        progressTotals,
        index,
        Math.max(
          resumeBaseBytes,
          progressTotals.writtenBytesByIndex[index - 1] || 0,
        ),
        expectedBytes,
        (index - 1) / total,
      );
      options.onProgress?.({
        phase: options.isPauseRequested?.() ? "paused" : "reconnecting",
        modelId: entry.id,
        fileName: entry.fileName,
        modelIndex: index,
        totalModels: total,
        ...aggregate,
        modelProgress: expectedBytes
          ? Math.min(1, (progressTotals.writtenBytesByIndex[index - 1] || 0) / expectedBytes)
          : undefined,
        message: "Connection interrupted. Local setup can resume.",
      });
      throw new ModelDownloadInterruptedError(statusMessage, interruptedState);
    }
    throw new ModelInstallError(statusMessage);
  }

  if (!result?.uri) {
    throw new ModelInstallError(`Download did not produce a file for ${entry.id}.`);
  }

  const verifyingTotals = aggregateDownloadProgress(
    progressTotals,
    index,
    expectedBytes || progressTotals.writtenBytesByIndex[index - 1] || 0,
    expectedBytes,
    index / total,
  );
  options.onProgress?.({
    phase: "verifying",
    modelId: entry.id,
    fileName: entry.fileName,
    modelIndex: index,
    totalModels: total,
    ...verifyingTotals,
    modelProgress: 1,
    message: "Finalizing setup...",
  });

  const tempRecord = await validateInstalledFile(entry, tempUri, options);
  if (!tempRecord.valid) {
    await fs.deleteAsync(tempUri, { idempotent: true }).catch(() => undefined);
    await removeResumeState(options, baseResumeState);
    throw new ModelInstallError(
      `Downloaded ${entry.fileName} failed verification: ${tempRecord.reason || "unknown verification error"}.`,
    );
  }

  await fs.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
  await fs.moveAsync({ from: tempUri, to: targetUri });

  const finalRecord = await validateInstalledFile(entry, targetUri, options);
  if (!finalRecord.valid) {
    await fs.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
    await removeResumeState(options, baseResumeState);
    throw new ModelInstallError(
      `Installed ${entry.fileName} failed final verification: ${finalRecord.reason || "unknown verification error"}.`,
    );
  }

  await removeResumeState(options, baseResumeState);

  const installedTotals = aggregateDownloadProgress(
    progressTotals,
    index,
    finalRecord.bytesOnDisk,
    expectedBytes || finalRecord.bytesOnDisk,
    index / total,
  );
  options.onProgress?.({
    phase: "installed",
    modelId: entry.id,
    fileName: entry.fileName,
    modelIndex: index,
    totalModels: total,
    ...installedTotals,
    modelProgress: 1,
    message: "Finalizing setup...",
  });
}

export async function downloadRequiredModels(
  options: EnsureModelsOptions = {},
): Promise<ModelInstallStatus> {
  const config = options.config;
  const mode = getModelDeliveryMode(config);
  if (mode !== "download_on_first_launch") {
    options.onProgress?.({
      phase: "skipped",
      message: `Model download skipped because modelDelivery.mode=${mode}.`,
    });
    return getModelInstallStatus(options);
  }

  const fs = options.fileSystem || FileSystem;
  const firstStatus = await getModelInstallStatus(options);
  const targets = [...firstStatus.invalid, ...firstStatus.missing];
  const retries = Math.max(
    0,
    Number(options.retries ?? configuredRoot(config).modelDelivery?.maxRetries ?? 2),
  );

  if (!targets.length) return firstStatus;

  targets.forEach((entry) => assertDownloadMetadata(entry, config));
  await assertEnoughFreeStorage(targets, options);

  for (const target of firstStatus.invalid) {
    await fs.deleteAsync(target.fileUri, { idempotent: true }).catch(() => undefined);
    await fs.deleteAsync(`${target.fileUri}.download`, { idempotent: true }).catch(() => undefined);
    await removeResumeState(
      options,
      createResumeState(
        target,
        target.fileUri,
        `${target.fileUri}.download`,
        firstStatus.selectedTier,
      ),
    );
  }

  const progressTotals = createDownloadProgressTotals(targets);
  for (let index = 0; index < targets.length; index += 1) {
    const entry = targets[index];
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await downloadOneModel(
          entry,
          index + 1,
          targets.length,
          options,
          progressTotals,
          firstStatus.selectedTier,
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        if (isTransientModelDownloadError(error) || options.isPauseRequested?.()) {
          break;
        }
        const nonRetryable = isNonRetryableDownloadStatusMessage(message);
        if (isIntegrityFailureMessage(message) || isInvalidModelMetadataMessage(message)) {
          await fs.deleteAsync(`${entry.fileUri}.download`, { idempotent: true }).catch(() => undefined);
          await removeResumeState(
            options,
            createResumeState(
              entry,
              entry.fileUri,
              `${entry.fileUri}.download`,
              firstStatus.selectedTier,
            ),
          );
        }
        await fs.deleteAsync(entry.fileUri, { idempotent: true }).catch(() => undefined);
        if (nonRetryable) {
          break;
        }
        if (attempt < retries) {
          const aggregate = aggregateDownloadProgress(
            progressTotals,
            index + 1,
            0,
            Number(entry.expectedBytes || 0) || null,
            index / targets.length,
          );
          options.onProgress?.({
            phase: "failed",
            modelId: entry.id,
            fileName: entry.fileName,
            modelIndex: index + 1,
            totalModels: targets.length,
            ...aggregate,
            message: "Retrying local AI file download...",
          });
        }
      }
    }

    if (lastError) {
      const message = errorMessage(lastError);
      const aggregate = aggregateDownloadProgress(
        progressTotals,
        index + 1,
        progressTotals.writtenBytesByIndex[index] || 0,
        Number(entry.expectedBytes || 0) || null,
        index / targets.length,
      );
      const interrupted =
        lastError instanceof ModelDownloadInterruptedError
          ? lastError
          : isTransientModelDownloadError(lastError) || options.isPauseRequested?.()
            ? new ModelDownloadInterruptedError(
                message || "Model download interrupted.",
                createResumeState(
                  entry,
                  entry.fileUri,
                  `${entry.fileUri}.download`,
                  firstStatus.selectedTier,
                ),
                lastError,
              )
            : null;
      options.onProgress?.({
        phase: interrupted
          ? options.isPauseRequested?.()
            ? "paused"
            : "reconnecting"
          : "failed",
        modelId: entry.id,
        fileName: entry.fileName,
        modelIndex: index + 1,
        totalModels: targets.length,
        ...aggregate,
        message: interrupted
          ? "Connection interrupted. Local setup can resume."
          : message,
      });
      if (interrupted) throw interrupted;
      throw lastError instanceof ModelInstallError
        ? lastError
        : new ModelInstallError(`Could not install ${entry.fileName}: ${message}`, lastError);
    }
  }

  const finalStatus = await getModelInstallStatus({
    ...options,
    onProgress: undefined,
  });
  if (!finalStatus.ready) {
    throw new ModelInstallError(
      `Required local GGUF models are still not ready: ${finalStatus.missing
        .concat(finalStatus.invalid)
        .map(installRecordDiagnostic)
        .join(", ")}`,
    );
  }
  return finalStatus;
}

export async function ensureRequiredModelsInstalled(
  options: EnsureModelsOptions = {},
): Promise<ModelInstallStatus> {
  const status = await getModelInstallStatus(options);
  if (status.ready) return status;
  return downloadRequiredModels(options);
}

export async function resolveInstalledNativeModelAssets(
  modelAssets: Record<string, NativeOnDeviceModelAsset> | undefined,
  options: EnsureModelsOptions = {},
): Promise<Record<string, NativeOnDeviceModelAsset>> {
  const mode = getModelDeliveryMode(options.config);
  const assets = { ...(modelAssets || {}) };
  if (mode !== "download_on_first_launch") {
    const selectedTier = normalizedSelectedTier(options.config, options);
    const selectedIds = new Set(getRequiredModelIdsForTier(options.config, selectedTier));
    const tierAssets = Object.fromEntries(
      Object.entries(assets).filter(([modelId]) => selectedIds.has(modelId)),
    ) as Record<string, NativeOnDeviceModelAsset>;
    return Object.keys(tierAssets).length ? tierAssets : assets;
  }

  const status = await getModelInstallStatus(options);
  if (!status.ready) {
    throw new ModelInstallError(
      `Required local GGUF models are not ready: ${status.missing
        .concat(status.invalid)
        .map(installRecordDiagnostic)
        .join(", ")}`,
    );
  }
  const installed = new Map(status.required.concat(status.optional).map((entry) => [entry.id, entry]));
  const resolvedAssets: Record<string, NativeOnDeviceModelAsset> = {};
  for (const [modelId, asset] of Object.entries(assets)) {
    const record = installed.get(modelId);
    if (record?.valid) {
      resolvedAssets[modelId] = {
        ...asset,
        fileName: asset.fileName || record.fileName,
        modelPath: record.fileUri,
      };
    }
  }
  return resolvedAssets;
}

function rotr(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Bytes(bytes: Uint8Array) {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Array<number>(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function base64ToBytes(base64: string) {
  const clean = base64.replace(/\s+/g, "");
  if (typeof atob === "function") {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  const bufferCtor = (globalThis as any).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(clean, "base64"));
  throw new ModelInstallError("No base64 decoder is available to verify model SHA-256.");
}

async function defaultHashFileSha256Async(fileUri: string) {
  const bridge = getNativeOnDeviceModelBridge();
  if (typeof bridge?.sha256File === "function") {
    const nativeResult = await bridge.sha256File({ fileUri });
    const nativeSha =
      typeof nativeResult === "string" ? nativeResult : nativeResult?.sha256;
    const normalizedNativeSha = normalizeSha(nativeSha);
    if (!normalizedNativeSha) {
      throw new ModelInstallError(
        "Native streaming SHA-256 returned no sha256 value for the downloaded GGUF file.",
      );
    }
    return normalizedNativeSha;
  }

  const info = await FileSystem.getInfoAsync(fileUri, { size: true } as any);
  const bytesOnDisk = Number((info as any)?.size || 0);
  if (!info.exists || bytesOnDisk <= 0) {
    throw new ModelInstallError(
      `Cannot verify SHA-256 because the local file is missing or empty: ${fileUri}`,
    );
  }

  if (bytesOnDisk > MAX_JS_SHA256_FALLBACK_BYTES) {
    throw new ModelInstallError(
      `Native streaming SHA-256 is required for production GGUF verification. The file at ${fileUri} is ${bytesOnDisk} bytes, which is too large for the JS/base64 fallback. Build the app with JaiOnDeviceModel.sha256File() available; the app will not skip checksum verification or fall back to backend/OpenAI because native hashing is missing.`,
    );
  }

  const cryptoApi = (globalThis as any).crypto;
  if (cryptoApi?.subtle && typeof fetch === "function") {
    try {
      const response = await fetch(fileUri);
      const buffer = await response.arrayBuffer();
      const digest = await cryptoApi.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // Fall back to expo-file-system base64 below.
    }
  }

  if (typeof FileSystem.readAsStringAsync !== "function") {
    throw new ModelInstallError("Cannot verify SHA-256 because file reads are unavailable.");
  }
  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  } as any);
  return sha256Bytes(base64ToBytes(base64));
}
