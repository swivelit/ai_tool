import {
  DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  NativeOnDeviceModelAsset,
  NativeOnDeviceModelBridge,
  NativeRuntimeDiagnostics,
  getNativeOnDeviceModelBridge,
  hasUsableNativeOnDeviceModelBridge,
  nativeOnDeviceBridgeMissingMessage,
} from "./nativeOnDeviceModelBridge";
import { withLocalTimeout } from "./localTurnTimeouts";
import {
  DeviceCapabilitySnapshot,
  ModelDeliveryConfig,
  ModelDeliveryMode,
  ModelDownloadConfigRoot,
  ModelTierName,
  getModelDeliveryMode,
  resolveInstalledNativeModelAssets,
} from "./modelDownloadManager";
import { renderNativeChatPrompt } from "./nativePromptTemplates";

export const OPENAI_FALLBACK_SIGNAL = "__OPENAI_FALLBACK__";

export type LocalRuntimeChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LocalRuntimeMode = "native_on_device" | "local_adapter";

export type LocalAdapterLocation =
  | "device_loopback"
  | "external_lan"
  | "emulator_host"
  | "unspecified";

export type LocalRuntimeConfig = {
  /**
   * The stable product policy. This must stay phone_local for normal chat.
   */
  primary?: "phone_local" | string;
  /**
   * native_on_device is the production bundled inference path. local_adapter is
   * development-only and exists to test the same /chat/completions and
   * /embeddings contracts before a native phone runtime is linked.
   */
  mode?: LocalRuntimeMode | string;
  /**
   * OpenAI/backend must never become the default provider from this runtime.
   */
  backendRole?: "fallback_only" | string;
  openAiPolicy?: "fallback_only" | "disabled" | string;
  /**
   * OpenAI-compatible local adapter base URL, for example a LAN IP, emulator
   * host alias, or explicit device loopback endpoint. Used only in
   * runtime.mode=local_adapter development builds.
   */
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /**
   * Enables http://localhost / http://127.0.0.1 only when the adapter is hosted
   * on the phone/device itself. Leave false for external LAN adapters.
   */
  allowDeviceLoopback?: boolean;
  adapterLocation?: LocalAdapterLocation | string;
  /**
   * Native production runtime settings. The bridge is intentionally generic so
   * the native side can be implemented with llama.cpp now and swapped later if
   * the model format changes.
   */
  nativeBackend?: "llama_cpp" | string;
  nativeModuleName?: string;
  modelRoot?: string;
  modelAssets?: Record<string, NativeOnDeviceModelAsset>;
  modelDeliveryMode?: ModelDeliveryMode | string;
  modelDelivery?: ModelDeliveryConfig;
  modelTier?: ModelTierName;
  deviceInfo?: DeviceCapabilitySnapshot;
  proOptIn?: boolean;
  nativeBridge?: NativeOnDeviceModelBridge | null;
  /**
   * Test/dev escape hatch only. local_adapter is intentionally blocked in
   * production builds unless this is explicitly true.
   */
  allowProductionLocalAdapter?: boolean;
};

export type LocalRuntimeInfo = {
  kind: "native_on_device" | "openai_compatible_local_adapter";
  mode: LocalRuntimeMode;
  primary: "phone_local";
  configured: boolean;
  baseUrl?: string;
  backendRole: "fallback_only";
  openAiPolicy: "fallback_only" | "disabled" | string;
  allowDeviceLoopback: boolean;
  adapterLocation: LocalAdapterLocation;
  nativeBackend?: string;
  nativeModuleName?: string;
  modelRoot?: string;
  modelDeliveryMode?: ModelDeliveryMode;
  modelCount?: number;
  runtimeDiagnostics?: NativeRuntimeDiagnostics;
  developmentOnly?: boolean;
  note: string;
};

export interface LocalModelRuntime {
  readonly kind: "native_on_device" | "openai_compatible_local_adapter";
  isConfigured(): boolean;
  describe(): LocalRuntimeInfo;
  completeChat(input: {
    model: string;
    messages: LocalRuntimeChatMessage[];
    temperature?: number;
    maxTokens?: number;
    requestId?: string;
  }): Promise<any>;
  embedTexts(input: {
    model: string;
    texts: string[];
    requestId?: string;
  }): Promise<number[][]>;
}

export class NativeOnDeviceRuntimeUnavailableError extends Error {
  readonly code = "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "NativeOnDeviceRuntimeUnavailableError";
  }
}

export function isNativeOnDeviceRuntimeUnavailableError(error: unknown) {
  return (
    error instanceof NativeOnDeviceRuntimeUnavailableError ||
    (error as any)?.code === "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE"
  );
}

export function normalizeLocalRuntimeBaseUrl(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

export function normalizeLocalRuntimeMode(value: unknown): LocalRuntimeMode {
  return String(value || "")
    .trim()
    .toLowerCase() === "native_on_device"
    ? "native_on_device"
    : "local_adapter";
}

export function normalizeLocalAdapterLocation(
  value: unknown,
): LocalAdapterLocation {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "device_loopback" ||
    normalized === "external_lan" ||
    normalized === "emulator_host"
  ) {
    return normalized;
  }
  return "unspecified";
}

export function isLoopbackLocalRuntimeBaseUrl(value: unknown) {
  const normalized = normalizeLocalRuntimeBaseUrl(value).toLowerCase();

  if (!normalized) {
    return false;
  }

  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(
    normalized,
  );
}

function isProductionRuntimeEnvironment() {
  return String((globalThis as any)?.process?.env?.NODE_ENV || "").toLowerCase() === "production";
}

export function isLocalAdapterDevelopmentOnly(config: LocalRuntimeConfig) {
  return normalizeLocalRuntimeMode(config.mode) === "local_adapter" && !config.allowProductionLocalAdapter;
}

export function isDeviceLoopbackAllowed(config: LocalRuntimeConfig) {
  return (
    normalizeLocalRuntimeMode(config.mode) === "local_adapter" &&
    (config.allowDeviceLoopback === true ||
      normalizeLocalAdapterLocation(config.adapterLocation) ===
        "device_loopback")
  );
}

function normalizeNativeModelAssets(
  value: LocalRuntimeConfig["modelAssets"],
): Record<string, NativeOnDeviceModelAsset> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.entries(value).reduce<Record<string, NativeOnDeviceModelAsset>>(
    (acc, [key, raw]) => {
      const asset = raw as NativeOnDeviceModelAsset;
      const id = String(asset?.id || key).trim();
      const modelPath = String(asset?.modelPath || "").trim();
      if (!id || !modelPath) {
        return acc;
      }
      acc[id] = {
        ...asset,
        id,
        modelPath,
      };
      return acc;
    },
    {},
  );
}

function getNativeModelAsset(
  config: LocalRuntimeConfig,
  model: string,
): NativeOnDeviceModelAsset | null {
  const assets = normalizeNativeModelAssets(config.modelAssets);
  const requested = String(model || "").trim();
  if (!requested) return null;
  return assets[requested] || null;
}

function getNativeRuntimeConfigError(
  config: LocalRuntimeConfig,
  featureName: string,
  requestedModel?: string,
) {
  const moduleName = String(
    config.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
  );
  const bridge = config.nativeBridge ?? getNativeOnDeviceModelBridge(moduleName);

  if (!hasUsableNativeOnDeviceModelBridge(bridge)) {
    return nativeOnDeviceBridgeMissingMessage(featureName, moduleName);
  }

  const assets = normalizeNativeModelAssets(config.modelAssets);
  if (!Object.keys(assets).length) {
    return `${featureName} selected runtime.mode=native_on_device, but no native model assets are configured. Add native.models entries in mobile/data/config/models.json with GGUF modelPath values for Gemma/Qwen before shipping production.`;
  }

  if (requestedModel && !getNativeModelAsset(config, requestedModel)) {
    return `${featureName} selected runtime.mode=native_on_device, but model "${requestedModel}" has no native asset entry. Add it to native.models in mobile/data/config/models.json and deliver the quantized GGUF through modelDelivery or bundled_assets mode.`;
  }

  return "";
}

function nativeRuntimeUnavailableReason(
  featureName: string,
  moduleName: string,
  diagnostics?: NativeRuntimeDiagnostics | null,
) {
  const reason = String(diagnostics?.reason || "").trim();
  if (reason) {
    return `${featureName} selected runtime.mode=native_on_device, but ${reason}`;
  }

  if (diagnostics && diagnostics.llamaCppBackendAvailable === false) {
    return `${featureName} selected runtime.mode=native_on_device, but the llama.cpp backend is not available in "${moduleName}".`;
  }

  return nativeOnDeviceBridgeMissingMessage(featureName, moduleName);
}

function isNativeRuntimeSetupError(error: unknown) {
  const message = String((error as any)?.message || error || "");
  const code = String((error as any)?.code || (error as any)?.nativeCode || "");

  return (
    code === "JAI_LLAMA_CPP_BACKEND_MISSING" ||
    code === "JAI_MODEL_FILE_MISSING" ||
    code === "JAI_NATIVE_MODELS_MISSING" ||
    code === "JAI_MODEL_NOT_CONFIGURED" ||
    code === "JAI_MODEL_PATH_MISSING" ||
    message.includes("JAI_LLAMA_CPP_BACKEND_MISSING") ||
    message.includes("JAI_MODEL_FILE_MISSING") ||
    message.includes("JAI_NATIVE_MODELS_MISSING") ||
    message.includes("JAI_MODEL_NOT_CONFIGURED") ||
    message.includes("JAI_MODEL_PATH_MISSING")
  );
}

function asNativeRuntimeUnavailable(
  featureName: string,
  error: unknown,
): NativeOnDeviceRuntimeUnavailableError {
  if (isNativeOnDeviceRuntimeUnavailableError(error)) {
    return error as NativeOnDeviceRuntimeUnavailableError;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return new NativeOnDeviceRuntimeUnavailableError(
    `${featureName} is not ready on this phone. ${message}`.trim(),
  );
}

export function getLocalRuntimeConfigError(
  config: LocalRuntimeConfig,
  featureName: string,
  requestedModel?: string,
) {
  const mode = normalizeLocalRuntimeMode(config.mode);
  const baseUrl = normalizeLocalRuntimeBaseUrl(config.baseUrl);
  const adapterLocation = normalizeLocalAdapterLocation(config.adapterLocation);

  if (mode === "native_on_device") {
    return getNativeRuntimeConfigError(config, featureName, requestedModel);
  }

  if (isProductionRuntimeEnvironment() && isLocalAdapterDevelopmentOnly(config)) {
    return `${featureName} selected runtime.mode=local_adapter, but local_adapter is development-only. Production must use runtime.mode=native_on_device with the JaiOnDeviceModel native bridge and bundled GGUF files.`;
  }

  if (!baseUrl) {
    return `${featureName} needs a phone-local model runtime adapter. /chat/completions and /embeddings are local adapter contracts only for development; backend/OpenAI remains fallback-only. Set LOCAL_MODEL_BASE_URL / EXPO_PUBLIC_LOCAL_MODEL_BASE_URL for development, or use runtime.mode=native_on_device with a real native bridge for production.`;
  }

  if (
    isLoopbackLocalRuntimeBaseUrl(baseUrl) &&
    !isDeviceLoopbackAllowed({ ...config, baseUrl, mode, adapterLocation })
  ) {
    return `${featureName} cannot use ${baseUrl} while adapterLocation=${adapterLocation}. 127.0.0.1/localhost points at the phone itself on a physical device. Use a LAN IP for an external adapter, 10.0.2.2 for the Android emulator, or set runtime.allowDeviceLoopback=true with adapterLocation=device_loopback when the adapter is intentionally hosted on the phone.`;
  }

  return "";
}

function extractCompletionText(json: any) {
  if (typeof json === "string") return json;
  if (typeof json?.text === "string") return json.text;
  if (typeof json?.content === "string") return json.content;
  if (typeof json?.message === "string") return json.message;
  const message = json?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  return "";
}

function normalizeChatCompletionResponse(value: any) {
  if (Array.isArray(value?.choices)) {
    return value;
  }

  const content = extractCompletionText(value);
  if (!content) {
    throw new Error("Native on-device chat runtime returned an empty response.");
  }

  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

function extractEmbeddingRows(json: any) {
  if (Array.isArray(json) && Array.isArray(json[0])) {
    return json.map((row: any, index: number) => {
      const embedding = Array.isArray(row) ? row.map(Number) : [];
      if (
        !embedding.length ||
        embedding.some((value: number) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Local embedding runtime returned an invalid vector for input ${index}.`,
        );
      }
      return embedding;
    });
  }

  const data = Array.isArray(json?.data) ? json.data : [];
  if (!data.length) {
    throw new Error("Local embedding runtime returned no data.");
  }

  return data.map((item: any, index: number) => {
    const embedding = Array.isArray(item?.embedding)
      ? item.embedding.map(Number)
      : [];
    if (
      !embedding.length ||
      embedding.some((value: number) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Local embedding runtime returned an invalid vector for input ${index}.`,
      );
    }
    return embedding;
  });
}

/**
 * Production path for true bundled phone inference.
 *
 * This class never talks to the backend or OpenAI. It calls a native module that
 * must be linked into a custom Expo development build/prebuild/bare app. The
 * selected native backend is llama.cpp because the target Gemma/Qwen assets can
 * be packaged as quantized GGUF files and used for both chat and embeddings.
 */
export class NativeOnDeviceModelRuntime implements LocalModelRuntime {
  readonly kind = "native_on_device" as const;

  private readonly config: LocalRuntimeConfig;
  private readonly bridge: NativeOnDeviceModelBridge | null;
  private readonly timeoutMs: number;
  private initialized = false;
  private runtimeDiagnostics: NativeRuntimeDiagnostics | undefined;

  constructor(config: LocalRuntimeConfig = {}) {
    const moduleName = String(
      config.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
    );
    this.config = {
      ...config,
      primary: "phone_local",
      mode: "native_on_device",
      backendRole: "fallback_only",
      openAiPolicy: config.openAiPolicy || "fallback_only",
      nativeBackend: config.nativeBackend || "llama_cpp",
      nativeModuleName: moduleName,
      timeoutMs: Number(config.timeoutMs || 120_000),
    };
    this.timeoutMs = Number(this.config.timeoutMs || 120_000);
    this.bridge = config.nativeBridge ?? getNativeOnDeviceModelBridge(moduleName);
  }

  isConfigured() {
    return !getLocalRuntimeConfigError(this.config, "Native on-device runtime");
  }

  describe(): LocalRuntimeInfo {
    const assets = normalizeNativeModelAssets(this.config.modelAssets);
    return {
      kind: this.kind,
      mode: "native_on_device",
      primary: "phone_local",
      configured: this.isConfigured(),
      backendRole: "fallback_only",
      openAiPolicy: String(
        this.config.openAiPolicy || "fallback_only",
      ) as LocalRuntimeInfo["openAiPolicy"],
      allowDeviceLoopback: false,
      adapterLocation: "unspecified",
      nativeBackend: String(this.config.nativeBackend || "llama_cpp"),
      nativeModuleName: String(
        this.config.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
      ),
      modelRoot: this.config.modelRoot,
      modelDeliveryMode: getModelDeliveryMode(this.modelDeliveryConfig()),
      modelCount: Object.keys(assets).length,
      runtimeDiagnostics: this.runtimeDiagnostics,
      developmentOnly: false,
      note: "Production path: calls the native on-device model bridge for downloaded Gemma/Qwen GGUF files. It never calls backend/OpenAI directly; missing bindings, failed downloads, or missing llama.cpp bindings fail clearly.",
    };
  }

  private moduleName() {
    return String(
      this.config.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME,
    );
  }

  private async readRuntimeDiagnostics(
    bridge: NativeOnDeviceModelBridge,
  ): Promise<NativeRuntimeDiagnostics | undefined> {
    if (typeof bridge.getRuntimeDiagnostics !== "function") {
      return undefined;
    }

    try {
      const diagnostics = await bridge.getRuntimeDiagnostics();
      this.runtimeDiagnostics = diagnostics;
      return diagnostics;
    } catch {
      return this.runtimeDiagnostics;
    }
  }

  private modelDeliveryConfig(): ModelDownloadConfigRoot {
    return {
      modelDelivery: this.config.modelDelivery || { mode: this.config.modelDeliveryMode },
      native: { models: normalizeNativeModelAssets(this.config.modelAssets) },
    };
  }

  private async prepareDownloadedAssets() {
    const mode = getModelDeliveryMode(this.modelDeliveryConfig());
    if (mode !== "download_on_first_launch") {
      return;
    }

    const resolvedAssets = await resolveInstalledNativeModelAssets(
      normalizeNativeModelAssets(this.config.modelAssets),
      {
        config: this.modelDeliveryConfig(),
        modelTier: this.config.modelTier,
        deviceInfo: this.config.deviceInfo,
        proOptIn: this.config.proOptIn,
      },
    );
    this.config.modelAssets = resolvedAssets;
    this.config.modelRoot = this.config.modelRoot || "document://models";
  }

  private requireReady(featureName: string, model: string) {
    const error = getLocalRuntimeConfigError(this.config, featureName, model);
    if (error) {
      throw new NativeOnDeviceRuntimeUnavailableError(error);
    }

    if (!this.bridge) {
      throw new NativeOnDeviceRuntimeUnavailableError(
        nativeOnDeviceBridgeMissingMessage(
          featureName,
          String(this.config.nativeModuleName || DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME),
        ),
      );
    }

    const asset = getNativeModelAsset(this.config, model);
    if (!asset) {
      throw new NativeOnDeviceRuntimeUnavailableError(
        `${featureName} cannot find model asset config for "${model}".`,
      );
    }

    return { bridge: this.bridge, asset };
  }

  private async ensureInitialized(bridge: NativeOnDeviceModelBridge) {
    await this.prepareDownloadedAssets();

    if (this.initialized) {
      return;
    }

    const moduleName = this.moduleName();
    const diagnostics = await this.readRuntimeDiagnostics(bridge);

    if (typeof bridge.isAvailable === "function") {
      const available = await bridge.isAvailable();
      if (!available) {
        throw new NativeOnDeviceRuntimeUnavailableError(
          nativeRuntimeUnavailableReason(
            "Native on-device runtime",
            moduleName,
            diagnostics,
          ),
        );
      }
    }

    try {
      await bridge.initialize({
        backend: String(this.config.nativeBackend || "llama_cpp"),
        modelRoot: this.config.modelRoot,
        models: normalizeNativeModelAssets(this.config.modelAssets),
      });
      this.initialized = true;
      await this.readRuntimeDiagnostics(bridge);
    } catch (error) {
      await this.readRuntimeDiagnostics(bridge);
      if (isNativeRuntimeSetupError(error)) {
        throw asNativeRuntimeUnavailable("Native on-device runtime", error);
      }
      throw error;
    }
  }

  async completeChat(input: {
    model: string;
    messages: LocalRuntimeChatMessage[];
    temperature?: number;
    maxTokens?: number;
    requestId?: string;
  }): Promise<any> {
    this.requireReady(
      "Native on-device chat",
      input.model,
    );
    await this.prepareDownloadedAssets();
    const { bridge, asset } = this.requireReady(
      "Native on-device chat",
      input.model,
    );
    await this.ensureInitialized(bridge);
    const requestId =
      input.requestId ||
      `native_chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const response = await withLocalTimeout(
        () => Promise.resolve(
          bridge.completeChat({
            model: input.model,
            temperature: input.temperature ?? 0.2,
            maxTokens: input.maxTokens,
            requestId,
            messages: input.messages,
            prompt: renderNativeChatPrompt(input.messages, asset),
            asset,
          }),
        ),
        this.timeoutMs,
        {
          source: "native_completeChat",
          message: `Native on-device chat timed out after ${this.timeoutMs}ms.`,
          onTimeout: () => {
            if (typeof bridge.cancelRequest === "function") {
              void bridge.cancelRequest(requestId);
            }
            return undefined;
          },
        },
      );
      return normalizeChatCompletionResponse(response);
    } catch (error) {
      if (isNativeRuntimeSetupError(error)) {
        throw asNativeRuntimeUnavailable("Native on-device chat", error);
      }
      throw error;
    }
  }

  async embedTexts(input: {
    model: string;
    texts: string[];
    requestId?: string;
  }): Promise<number[][]> {
    this.requireReady(
      "Native on-device embeddings",
      input.model,
    );
    await this.prepareDownloadedAssets();
    const { bridge, asset } = this.requireReady(
      "Native on-device embeddings",
      input.model,
    );
    await this.ensureInitialized(bridge);
    const requestId =
      input.requestId ||
      `native_embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const response = await withLocalTimeout(
        () => Promise.resolve(
          bridge.embedTexts({
            model: input.model,
            texts: input.texts,
            requestId,
            asset,
          }),
        ),
        this.timeoutMs,
        {
          source: "native_embedTexts",
          message: `Native on-device embeddings timed out after ${this.timeoutMs}ms.`,
          onTimeout: () => {
            if (typeof bridge.cancelRequest === "function") {
              void bridge.cancelRequest(requestId);
            }
            return undefined;
          },
        },
      );
      return extractEmbeddingRows(response);
    } catch (error) {
      if (isNativeRuntimeSetupError(error)) {
        throw asNativeRuntimeUnavailable("Native on-device embeddings", error);
      }
      throw error;
    }
  }
}

export class OpenAiCompatibleLocalAdapterRuntime implements LocalModelRuntime {
  readonly kind = "openai_compatible_local_adapter" as const;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly config: LocalRuntimeConfig;
  private readonly adapterLocation: LocalAdapterLocation;

  constructor(config: LocalRuntimeConfig) {
    this.baseUrl = normalizeLocalRuntimeBaseUrl(config.baseUrl);
    this.apiKey = String(config.apiKey || "");
    this.timeoutMs = Number(config.timeoutMs || 120_000);
    this.adapterLocation = normalizeLocalAdapterLocation(
      config.adapterLocation,
    );
    this.config = {
      ...config,
      primary: "phone_local",
      mode: "local_adapter",
      backendRole: "fallback_only",
      openAiPolicy: config.openAiPolicy || "fallback_only",
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      adapterLocation: this.adapterLocation,
    };
  }

  isConfigured() {
    return !getLocalRuntimeConfigError(this.config, "Local model runtime");
  }

  describe(): LocalRuntimeInfo {
    return {
      kind: this.kind,
      mode: "local_adapter",
      primary: "phone_local",
      configured: this.isConfigured(),
      baseUrl: this.baseUrl,
      backendRole: "fallback_only",
      openAiPolicy: String(
        this.config.openAiPolicy || "fallback_only",
      ) as LocalRuntimeInfo["openAiPolicy"],
      allowDeviceLoopback: isDeviceLoopbackAllowed(this.config),
      adapterLocation: this.adapterLocation,
      developmentOnly: true,
      note: "Development-only adapter boundary. /chat/completions and /embeddings are treated as phone-local adapter contracts for testing; they are not OpenAI/backend primary paths and should not be used as the production runtime mode.",
    };
  }

  private endpoint(path: string, featureName: string) {
    const error = getLocalRuntimeConfigError(this.config, featureName);
    if (error) {
      throw new Error(error);
    }

    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async postJson(endpoint: string, payload: any) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Local model runtime HTTP ${res.status}${text ? ` - ${text}` : ""}`,
        );
      }

      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async completeChat(input: {
    model: string;
    messages: LocalRuntimeChatMessage[];
    temperature?: number;
    maxTokens?: number;
  }) {
    return this.postJson(
      this.endpoint("/chat/completions", "Local chat/profiler"),
      {
        model: input.model,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens,
        messages: input.messages,
      },
    );
  }

  async embedTexts(input: { model: string; texts: string[] }) {
    const json = await this.postJson(
      this.endpoint("/embeddings", "Local embeddings"),
      {
        model: input.model,
        input: input.texts,
      },
    );
    return extractEmbeddingRows(json);
  }
}

// Backward-compatible export name for existing imports/tests.
export const OpenAiCompatibleLocalModelRuntime =
  OpenAiCompatibleLocalAdapterRuntime;

export function createLocalModelRuntime(
  config: LocalRuntimeConfig,
): LocalModelRuntime {
  const mode = normalizeLocalRuntimeMode(config.mode);
  if (mode === "native_on_device") {
    return new NativeOnDeviceModelRuntime({
      ...config,
      primary: "phone_local",
      mode,
      backendRole: "fallback_only",
      openAiPolicy: config.openAiPolicy || "fallback_only",
      nativeBackend: config.nativeBackend || "llama_cpp",
    });
  }

  return new OpenAiCompatibleLocalAdapterRuntime({
    ...config,
    primary: "phone_local",
    mode,
    backendRole: "fallback_only",
    openAiPolicy: config.openAiPolicy || "fallback_only",
  });
}
