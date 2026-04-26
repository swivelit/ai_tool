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
   * native_on_device is the future bundled inference path. local_adapter is the
   * development/runtime-contract HTTP boundary used until native inference exists.
   */
  mode?: LocalRuntimeMode | string;
  /**
   * OpenAI/backend must never become the default provider from this runtime.
   */
  backendRole?: "fallback_only" | string;
  openAiPolicy?: "fallback_only" | "disabled" | string;
  /**
   * OpenAI-compatible local adapter base URL, for example a LAN IP, emulator
   * host alias, or explicit device loopback endpoint.
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
  }): Promise<any>;
  embedTexts(input: { model: string; texts: string[] }): Promise<number[][]>;
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

export function isDeviceLoopbackAllowed(config: LocalRuntimeConfig) {
  return (
    normalizeLocalRuntimeMode(config.mode) === "local_adapter" &&
    (config.allowDeviceLoopback === true ||
      normalizeLocalAdapterLocation(config.adapterLocation) ===
        "device_loopback")
  );
}

export function getLocalRuntimeConfigError(
  config: LocalRuntimeConfig,
  featureName: string,
) {
  const mode = normalizeLocalRuntimeMode(config.mode);
  const baseUrl = normalizeLocalRuntimeBaseUrl(config.baseUrl);
  const adapterLocation = normalizeLocalAdapterLocation(config.adapterLocation);

  if (mode === "native_on_device") {
    return `${featureName} selected native_on_device runtime, but native bundled phone inference is not implemented yet. TODO(native-runtime): plug in llama.cpp, MediaPipe LLM Inference, ExecuTorch, MLC LLM, ONNX Runtime, Core ML, or another on-device backend.`;
  }

  if (!baseUrl) {
    return `${featureName} needs a phone-local model runtime adapter. /chat/completions and /embeddings are local adapter contracts only; backend/OpenAI remains fallback-only. Set LOCAL_MODEL_BASE_URL / EXPO_PUBLIC_LOCAL_MODEL_BASE_URL for development, or switch to native_on_device after a real native runtime is implemented.`;
  }

  if (
    isLoopbackLocalRuntimeBaseUrl(baseUrl) &&
    !isDeviceLoopbackAllowed({ ...config, baseUrl, mode, adapterLocation })
  ) {
    return `${featureName} cannot use ${baseUrl} while adapterLocation=${adapterLocation}. 127.0.0.1/localhost points at the phone itself on a physical device. Use a LAN IP for an external adapter, 10.0.2.2 for the Android emulator, or set runtime.allowDeviceLoopback=true with adapterLocation=device_loopback when the adapter is intentionally hosted on the phone.`;
  }

  return "";
}

function extractEmbeddingRows(json: any) {
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
 * Placeholder for true bundled phone inference.
 *
 * This class is intentionally not wired to any cloud or OpenAI endpoint. It
 * fails clearly until a native model binding is implemented and injected here.
 */
export class NativeOnDeviceModelRuntime implements LocalModelRuntime {
  readonly kind = "native_on_device" as const;

  private readonly config: LocalRuntimeConfig;

  constructor(config: LocalRuntimeConfig = {}) {
    this.config = config;
  }

  isConfigured() {
    return false;
  }

  describe(): LocalRuntimeInfo {
    return {
      kind: this.kind,
      mode: "native_on_device",
      primary: "phone_local",
      configured: false,
      backendRole: "fallback_only",
      openAiPolicy: String(
        this.config.openAiPolicy || "fallback_only",
      ) as LocalRuntimeInfo["openAiPolicy"],
      allowDeviceLoopback: false,
      adapterLocation: "unspecified",
      note: "TODO(native-runtime): native_on_device is represented for production architecture, but no bundled Gemma/Qwen inference binding is implemented yet. It never calls backend/OpenAI directly.",
    };
  }

  private notImplemented(featureName: string): never {
    throw new Error(getLocalRuntimeConfigError(this.config, featureName));
  }

  async completeChat(_input: {
    model: string;
    messages: LocalRuntimeChatMessage[];
    temperature?: number;
  }): Promise<any> {
    this.notImplemented("Native on-device chat");
  }

  async embedTexts(_input: {
    model: string;
    texts: string[];
  }): Promise<number[][]> {
    this.notImplemented("Native on-device embeddings");
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
    this.timeoutMs = Number(config.timeoutMs || 45_000);
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
      note: "This is a local runtime adapter boundary. /chat/completions and /embeddings are treated as phone-local adapter contracts for development or device-hosted runtimes, not as OpenAI/backend primary paths.",
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
  }) {
    return this.postJson(
      this.endpoint("/chat/completions", "Local chat/profiler"),
      {
        model: input.model,
        temperature: input.temperature ?? 0.2,
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
