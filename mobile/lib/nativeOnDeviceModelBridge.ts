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
  temperature?: number;
  asset: NativeOnDeviceModelAsset;
};

export type NativeOnDeviceEmbeddingInput = {
  model: string;
  texts: string[];
  asset: NativeOnDeviceModelAsset;
};

export type NativeOnDeviceModelBridge = {
  isAvailable?: () => boolean | Promise<boolean>;
  initialize: (config: NativeOnDeviceBridgeInitConfig) => unknown | Promise<unknown>;
  completeChat: (input: NativeOnDeviceChatInput) => unknown | Promise<unknown>;
  embedTexts: (input: NativeOnDeviceEmbeddingInput) => unknown | Promise<unknown>;
};

declare const require: unknown;

export const DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME = "JaiOnDeviceModel";

const KNOWN_NATIVE_MODULE_NAMES = [
  DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  "NativeOnDeviceModelRuntime",
  "OnDeviceModelRuntime",
  "LocalLlmRuntime",
] as const;

function maybeRequireReactNative(): { NativeModules?: Record<string, unknown> } | null {
  try {
    if (typeof require !== "function") return null;
    return (require as (name: string) => unknown)("react-native") as {
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
    if (typeof require !== "function") return null;
    return (require as (name: string) => unknown)("expo-modules-core") as {
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
  return `${featureName} selected runtime.mode=native_on_device, but the native on-device inference module "${moduleName}" is not installed in this app binary. This mode never calls backend/OpenAI by itself. Build a custom Expo development build or prebuild/bare React Native app, add the llama.cpp-backed native module, expose initialize(), completeChat(), and embedTexts(), and bundle the configured GGUF model files.`;
}
