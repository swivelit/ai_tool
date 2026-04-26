export const OPENAI_FALLBACK_SIGNAL = "__OPENAI_FALLBACK__";

export type LocalRuntimeChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LocalRuntimeConfig = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type LocalRuntimeInfo = {
  kind: "openai_compatible_adapter";
  configured: boolean;
  baseUrl: string;
  note: string;
};

export interface LocalModelRuntime {
  readonly kind: "openai_compatible_adapter";
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

export function isLoopbackLocalRuntimeBaseUrl(value: unknown) {
  const normalized = normalizeLocalRuntimeBaseUrl(value).toLowerCase();

  if (!normalized) {
    return false;
  }

  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(
    normalized,
  );
}

function runtimeConfigError(baseUrl: string, featureName: string) {
  if (!baseUrl) {
    return `${featureName} needs a phone-local model runtime. TODO(native-runtime): plug in llama.cpp, MediaPipe LLM Inference, ExecuTorch, MLC LLM, ONNX Runtime, Core ML, or another on-device backend. Until then, set LOCAL_MODEL_BASE_URL / EXPO_PUBLIC_LOCAL_MODEL_BASE_URL to a local OpenAI-compatible adapter.`;
  }

  if (isLoopbackLocalRuntimeBaseUrl(baseUrl)) {
    return `${featureName} cannot use ${baseUrl}. 127.0.0.1/localhost points at the phone itself on a physical device. Use an on-device runtime binding, your laptop's LAN IP during development, or 10.0.2.2 for the Android emulator.`;
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

export class OpenAiCompatibleLocalModelRuntime implements LocalModelRuntime {
  readonly kind = "openai_compatible_adapter" as const;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: LocalRuntimeConfig) {
    this.baseUrl = normalizeLocalRuntimeBaseUrl(config.baseUrl);
    this.apiKey = String(config.apiKey || "");
    this.timeoutMs = Number(config.timeoutMs || 45_000);
  }

  isConfigured() {
    return (
      Boolean(this.baseUrl) && !isLoopbackLocalRuntimeBaseUrl(this.baseUrl)
    );
  }

  describe(): LocalRuntimeInfo {
    return {
      kind: this.kind,
      configured: this.isConfigured(),
      baseUrl: this.baseUrl,
      note: "This is a local runtime interface. The current implementation is an OpenAI-compatible adapter used only as the phone-local model boundary until a native on-device backend is plugged in.",
    };
  }

  private endpoint(path: string, featureName: string) {
    const error = runtimeConfigError(this.baseUrl, featureName);
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

export function createLocalModelRuntime(
  config: LocalRuntimeConfig,
): LocalModelRuntime {
  return new OpenAiCompatibleLocalModelRuntime(config);
}
