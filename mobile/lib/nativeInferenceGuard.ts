import Constants from "expo-constants";

import {
  DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  getNativeOnDeviceModelBridge,
  hasUsableNativeOnDeviceModelBridge,
} from "./nativeOnDeviceModelBridge";

type NativeRuntimeMode = "native_on_device" | "local_adapter" | string;

export type NativeInferenceSafetyStatus = {
  bridgeAvailable: boolean;
  modelsReady: boolean;
  smokeVerified: boolean;
  unverifiedAllowed: boolean;
  mode: NativeRuntimeMode;
  moduleName: string;
  feature: "general_chat" | "embeddings";
  safe: boolean;
  reason: string;
};

type NativeInferenceSafetyInput = {
  mode?: NativeRuntimeMode | null;
  nativeModuleName?: string | null;
  modelsReady?: boolean | null;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

let nativeGeneralChatSmokeVerified = false;
let nativeEmbeddingsSmokeVerified = false;

function parseBooleanFlag(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function runtimeMode(value: unknown): NativeRuntimeMode {
  return String(value || "native_on_device").trim() || "native_on_device";
}

function unverifiedGeneralChatAllowed() {
  return parseBooleanFlag(
    extra.ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT ??
      process.env.EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT,
    false,
  );
}

function unverifiedEmbeddingsAllowed() {
  return parseBooleanFlag(
    extra.ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS ??
      process.env.EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS,
    false,
  );
}

function bridgeAvailable(moduleName: string) {
  return hasUsableNativeOnDeviceModelBridge(
    getNativeOnDeviceModelBridge(moduleName),
  );
}

function buildStatus(
  feature: NativeInferenceSafetyStatus["feature"],
  input: NativeInferenceSafetyInput = {},
): NativeInferenceSafetyStatus {
  const mode = runtimeMode(input.mode);
  const moduleName = String(
    input.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  );

  if (mode !== "native_on_device") {
    return {
      bridgeAvailable: false,
      modelsReady: input.modelsReady !== false,
      smokeVerified: true,
      unverifiedAllowed: false,
      mode,
      moduleName,
      feature,
      safe: true,
      reason: "non_native_runtime",
    };
  }

  const bridge = bridgeAvailable(moduleName);
  const modelsReady = input.modelsReady !== false;
  const smokeVerified =
    feature === "general_chat"
      ? nativeGeneralChatSmokeVerified
      : nativeEmbeddingsSmokeVerified;
  const unverifiedAllowed =
    feature === "general_chat"
      ? unverifiedGeneralChatAllowed()
      : unverifiedEmbeddingsAllowed();

  let reason = "native_smoke_test_not_verified";
  if (!bridge) {
    reason = "native_bridge_unavailable";
  } else if (!modelsReady) {
    reason = "native_models_not_ready";
  } else if (smokeVerified) {
    reason = "native_smoke_test_verified";
  } else if (unverifiedAllowed) {
    reason = "unverified_native_inference_flag_enabled";
  }

  return {
    bridgeAvailable: bridge,
    modelsReady,
    smokeVerified,
    unverifiedAllowed,
    mode,
    moduleName,
    feature,
    safe: bridge && modelsReady && (smokeVerified || unverifiedAllowed),
    reason,
  };
}

export function markNativeSmokeTestPassed(
  feature: "general_chat" | "embeddings" | "all" = "all",
) {
  if (feature === "general_chat" || feature === "all") {
    nativeGeneralChatSmokeVerified = true;
  }
  if (feature === "embeddings" || feature === "all") {
    nativeEmbeddingsSmokeVerified = true;
  }
}

export function resetNativeInferenceSafetyForTests() {
  nativeGeneralChatSmokeVerified = false;
  nativeEmbeddingsSmokeVerified = false;
}

export function getNativeInferenceSafetyStatus(
  input: NativeInferenceSafetyInput = {},
) {
  return {
    generalChat: buildStatus("general_chat", input),
    embeddings: buildStatus("embeddings", input),
  };
}

export function canUseNativeGeneralChatSafely(
  input: NativeInferenceSafetyInput = {},
) {
  return buildStatus("general_chat", input);
}

export function canUseNativeEmbeddingsSafely(
  input: NativeInferenceSafetyInput = {},
) {
  return buildStatus("embeddings", input);
}
