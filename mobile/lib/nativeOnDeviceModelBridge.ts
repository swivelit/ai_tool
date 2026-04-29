export type NativeOnDeviceChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type NativeOnDeviceModelRole =
  | "profiler"
  | "orchestrator_medium"
  | "orchestrator_large"
  | "alignment"
  | "memory_embedding"
  | "memory_summarizer"
  | string;

export type NativeOnDeviceModelAsset = {
  id: string;
  roles?: NativeOnDeviceModelRole[];
  backend?: "llama_cpp" | string;
  format?: "gguf" | string;
  quantization?: string;
  fileName?: string;
  modelPath: string;
  tokenizerPath?: string;
  configPath?: string;
  contextSize?: number;
  batchSize?: number;
  threads?: number;
  gpuLayers?: number;
  useMmap?: boolean;
  useMetal?: boolean;
  useGpu?: boolean;
  acceleration?: "cpu_only" | "gpu" | string;
  chatTemplate?: "qwen3" | "gemma3" | "generic" | string;
  promptFormat?: "qwen3" | "gemma3" | "generic" | string;
  embedding?: boolean;
  description?: string;
};

export type NativeOnDeviceBridgeInitConfig = {
  backend: "llama_cpp" | string;
  modelRoot?: string;
  models: Record<string, NativeOnDeviceModelAsset>;
};

export type NativeOnDeviceChatInput = {
  model: string;
  messages: NativeOnDeviceChatMessage[];
  prompt?: string;
  temperature?: number;
  asset: NativeOnDeviceModelAsset;
};

export type NativeOnDeviceEmbeddingInput = {
  model: string;
  texts: string[];
  asset: NativeOnDeviceModelAsset;
};

export type NativeOnDeviceTranscriptionInput = {
  fileUri: string;
  model?: string;
  language?: "en" | "ta" | string | null;
};

export type NativeOnDeviceSha256FileInput = {
  fileUri: string;
};

export type NativeOnDeviceModelBridge = {
  isAvailable?: () => boolean | Promise<boolean>;
  isSpeechToTextAvailable?: () => boolean | Promise<boolean>;
  initialize: (config: NativeOnDeviceBridgeInitConfig) => unknown | Promise<unknown>;
  completeChat: (input: NativeOnDeviceChatInput) => unknown | Promise<unknown>;
  embedTexts: (input: NativeOnDeviceEmbeddingInput) => unknown | Promise<unknown>;
  transcribeAudio?: (input: NativeOnDeviceTranscriptionInput) => unknown | Promise<unknown>;
  sha256File?: (
    input: NativeOnDeviceSha256FileInput,
  ) => Promise<{ sha256: string } | string> | { sha256: string } | string;
};

export type NativeOnDeviceSpeechToTextCapability = {
  available: boolean;
  bridgeAvailable: boolean;
  moduleName: string;
  endpoint?: string;
  reason?: string;
};

declare const require: unknown;

export const DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME = "JaiOnDeviceModel";

const KNOWN_NATIVE_MODULE_NAMES = [
  DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  "NativeOnDeviceModelRuntime",
  "OnDeviceModelRuntime",
  "LocalLlmRuntime",
] as const;

function isUnitTestEnvironment() {
  const env = (globalThis as any)?.process?.env || {};
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

function maybeRequireReactNative(): { NativeModules?: Record<string, unknown> } | null {
  try {
    if (isUnitTestEnvironment()) return null;
    if (typeof require !== "function") return null;
    const moduleName = "react" + "-native";
    return (require as (name: string) => unknown)(moduleName) as {
      NativeModules?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function maybeRequireExpoModulesCore(): {
  requireNativeModule?: (moduleName: string) => unknown;
} | null {
  try {
    if (isUnitTestEnvironment()) return null;
    if (typeof require !== "function") return null;
    const moduleName = "expo" + "-modules-core";
    return (require as (name: string) => unknown)(moduleName) as {
      requireNativeModule?: (moduleName: string) => unknown;
    };
  } catch {
    return null;
  }
}

function isBridge(value: unknown): value is NativeOnDeviceModelBridge {
  const candidate = value as Partial<NativeOnDeviceModelBridge> | null;
  return (
    Boolean(candidate) &&
    typeof candidate?.initialize === "function" &&
    typeof candidate?.completeChat === "function" &&
    typeof candidate?.embedTexts === "function"
  );
}

function getExpoNativeModule(moduleName: string) {
  try {
    const requireNativeModule = maybeRequireExpoModulesCore()?.requireNativeModule;
    if (typeof requireNativeModule !== "function") return null;
    return requireNativeModule(moduleName);
  } catch {
    return null;
  }
}

export function getNativeOnDeviceModelBridge(
  preferredModuleName = DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
): NativeOnDeviceModelBridge | null {
  const testBridge = (globalThis as Record<string, unknown>)[
    "__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__"
  ];
  if (isBridge(testBridge)) {
    return testBridge;
  }

  const moduleNames = [
    preferredModuleName,
    ...KNOWN_NATIVE_MODULE_NAMES.filter((name) => name !== preferredModuleName),
  ];

  for (const moduleName of moduleNames) {
    const expoBridge = getExpoNativeModule(moduleName);
    if (isBridge(expoBridge)) {
      return expoBridge;
    }
  }

  const nativeModules = maybeRequireReactNative()?.NativeModules || {};
  for (const moduleName of moduleNames) {
    const bridge = nativeModules[moduleName];
    if (isBridge(bridge)) {
      return bridge;
    }
  }

  return null;
}

export function hasUsableNativeOnDeviceModelBridge(
  bridge: NativeOnDeviceModelBridge | null | undefined,
) {
  return isBridge(bridge);
}

export function setNativeOnDeviceModelBridgeForTests(
  bridge: NativeOnDeviceModelBridge | null,
) {
  if (bridge) {
    (globalThis as Record<string, unknown>)[
      "__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__"
    ] = bridge;
    return;
  }

  delete (globalThis as Record<string, unknown>)[
    "__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__"
  ];
}

export function nativeOnDeviceBridgeMissingMessage(
  featureName: string,
  moduleName = DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
) {
  return `${featureName} selected runtime.mode=native_on_device, but the native on-device inference module "${moduleName}" is not installed in this app binary. This mode never calls backend/OpenAI by itself. Build a custom Expo development build or prebuild/bare React Native app, add the llama.cpp-backed native module, expose initialize(), completeChat(), and embedTexts(), and download the configured GGUF model files into app-private storage or enable bundled_assets mode.`;
}

export function nativeOnDeviceSttMissingMessage(
  featureName: string,
  moduleName = DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
) {
  return `${featureName} selected runtime.mode=native_on_device, but the native on-device speech-to-text bridge "${moduleName}.transcribeAudio()" is not available in this app binary. Recorded voice requires a phone-local native STT implementation, such as whisper.cpp, or a configured development-only local_adapter STT endpoint. This mode never calls backend/OpenAI by itself.`;
}

export const LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE =
  "Local voice recognition is not available in this build yet.";

export async function getNativeOnDeviceSpeechToTextCapability(
  preferredModuleName = DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
): Promise<NativeOnDeviceSpeechToTextCapability> {
  const bridge = getNativeOnDeviceModelBridge(preferredModuleName);
  const endpoint = `${preferredModuleName}.transcribeAudio`;

  if (!bridge) {
    return {
      available: false,
      bridgeAvailable: false,
      moduleName: preferredModuleName,
      endpoint,
      reason: LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    };
  }

  if (typeof bridge.transcribeAudio !== "function") {
    return {
      available: false,
      bridgeAvailable: true,
      moduleName: preferredModuleName,
      endpoint,
      reason: LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    };
  }

  if (typeof bridge.isSpeechToTextAvailable !== "function") {
    return {
      available: false,
      bridgeAvailable: true,
      moduleName: preferredModuleName,
      endpoint,
      reason: LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    };
  }

  try {
    const available = await bridge.isSpeechToTextAvailable();
    return {
      available: available === true,
      bridgeAvailable: true,
      moduleName: preferredModuleName,
      endpoint,
      reason:
        available === true
          ? undefined
          : LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    };
  } catch {
    return {
      available: false,
      bridgeAvailable: true,
      moduleName: preferredModuleName,
      endpoint,
      reason: LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    };
  }
}
