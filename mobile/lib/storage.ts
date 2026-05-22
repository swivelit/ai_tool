import AsyncStorage from "@react-native-async-storage/async-storage";

let SecureStore: any = null;
try {
  SecureStore = require("expo-secure-store");
} catch {
  SecureStore = null;
}

async function secureSet(key: string, value: string) {
  if (SecureStore?.setItemAsync) {
    await SecureStore.setItemAsync(key, value);
    await AsyncStorage.removeItem(key).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function secureGet(key: string) {
  if (SecureStore?.getItemAsync) {
    const value = await SecureStore.getItemAsync(key);
    if (value !== null && typeof value !== "undefined") return value;
  }
  return AsyncStorage.getItem(key);
}

async function secureDelete(key: string) {
  await Promise.all([
    SecureStore?.deleteItemAsync ? SecureStore.deleteItemAsync(key).catch(() => undefined) : Promise.resolve(),
    AsyncStorage.removeItem(key),
  ]);
}

export const KEYS = {
  assistantName: "assistant_name_v1",
  settings: "assistant_settings_v1",
};

export type AssistantTone = "pro" | "friendly";
export type LanguageMode = "en" | "ta";
export type WakeModelStatus = "missing" | "pending" | "ready" | "unsupported" | "error" | "e2e_mock";
export type WakeModelSettings = {
  status: WakeModelStatus;
  phraseKey?: string;
  wakePhrase?: string;
  modelType?: "supported_base" | "custom" | "e2e_mock" | string;
  threshold?: number;
  sampleRate?: number;
  frameMs?: number;
  modelPaths?: {
    wakeModel?: string;
    melspectrogramModel?: string;
    embeddingModel?: string;
  };
  detail?: string;
  updatedAt?: string;
};

export type AssistantSettings = {
  tone: AssistantTone;
  languageMode: LanguageMode;
  allowCloudFallback: boolean;
  cloudFallbackUserChoice?: boolean;
  cloudFallbackPolicyVersion?: number;
  handsFreeEnabled: boolean;
  autoSpeakReplies: boolean;
  wakePhrase: string;
  wakeTrainingSamples: string[];
  wakeObservedTranscriptions: string[];
  wakeModel: WakeModelSettings;
};

export const CLOUD_FALLBACK_POLICY_VERSION = 2;

export const DEFAULTS: { name: string; settings: AssistantSettings } = {
  name: "Elli",
  settings: {
    tone: "pro",
    languageMode: "ta",
    allowCloudFallback: true,
    cloudFallbackPolicyVersion: CLOUD_FALLBACK_POLICY_VERSION,
    handsFreeEnabled: false,
    autoSpeakReplies: false,
    wakePhrase: "Hey Elli",
    wakeTrainingSamples: [],
    wakeObservedTranscriptions: [],
    wakeModel: {
      status: "missing",
    },
  },
};

function normalizeLanguageMode(value: unknown): LanguageMode {
  if (value === "en" || value === "ta") {
    return value;
  }

  if (value === "mixed") {
    return "ta";
  }

  return DEFAULTS.settings.languageMode;
}

function normalizeWakePhrase(value: unknown): string {
  const trimmed = String(value || "").trim();
  return trimmed || DEFAULTS.settings.wakePhrase;
}

function normalizeWakeTrainingSamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    )
  );
}

function normalizeWakeObservedTranscriptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 12)
    )
  );
}

function normalizeWakeModel(value: unknown, wakePhrase: string): WakeModelSettings {
  const input = value && typeof value === "object" ? (value as Record<string, any>) : {};
  const rawStatus = String(input.status || "").trim();
  const status: WakeModelStatus =
    rawStatus === "pending" ||
    rawStatus === "ready" ||
    rawStatus === "unsupported" ||
    rawStatus === "error" ||
    rawStatus === "e2e_mock"
      ? rawStatus
      : "missing";
  const modelPaths =
    input.modelPaths && typeof input.modelPaths === "object"
      ? {
          wakeModel: String(input.modelPaths.wakeModel || "").trim() || undefined,
          melspectrogramModel:
            String(input.modelPaths.melspectrogramModel || "").trim() || undefined,
          embeddingModel: String(input.modelPaths.embeddingModel || "").trim() || undefined,
        }
      : undefined;

  return {
    status,
    phraseKey: String(input.phraseKey || "").trim() || undefined,
    wakePhrase: String(input.wakePhrase || "").trim() || wakePhrase,
    modelType: String(input.modelType || "").trim() || undefined,
    threshold:
      Number.isFinite(Number(input.threshold)) && Number(input.threshold) > 0
        ? Number(input.threshold)
        : undefined,
    sampleRate:
      Number.isFinite(Number(input.sampleRate)) && Number(input.sampleRate) > 0
        ? Math.floor(Number(input.sampleRate))
        : undefined,
    frameMs:
      Number.isFinite(Number(input.frameMs)) && Number(input.frameMs) > 0
        ? Math.floor(Number(input.frameMs))
        : undefined,
    modelPaths,
    detail: String(input.detail || "").trim() || undefined,
    updatedAt: String(input.updatedAt || "").trim() || undefined,
  };
}

function normalizeCloudFallback(value: Partial<AssistantSettings> | null | undefined): boolean {
  if (value?.cloudFallbackUserChoice === true) {
    return value.allowCloudFallback === true;
  }

  if (value?.allowCloudFallback === true) {
    return true;
  }

  return DEFAULTS.settings.allowCloudFallback;
}

function normalizeCloudFallbackPolicyVersion(value: unknown): number {
  const version = Number(value);
  return Number.isFinite(version) && version >= CLOUD_FALLBACK_POLICY_VERSION
    ? version
    : CLOUD_FALLBACK_POLICY_VERSION;
}

export function normalizeAssistantSettings(
  value?: Partial<AssistantSettings> | null
): AssistantSettings {
  const cloudFallbackUserChoice = value?.cloudFallbackUserChoice === true;
  const wakePhrase = normalizeWakePhrase(value?.wakePhrase);

  return {
    tone: value?.tone === "friendly" ? "friendly" : DEFAULTS.settings.tone,
    languageMode: normalizeLanguageMode(value?.languageMode),
    allowCloudFallback: normalizeCloudFallback(value),
    ...(cloudFallbackUserChoice ? { cloudFallbackUserChoice: true } : {}),
    cloudFallbackPolicyVersion: normalizeCloudFallbackPolicyVersion(
      value?.cloudFallbackPolicyVersion
    ),
    handsFreeEnabled: Boolean(value?.handsFreeEnabled),
    autoSpeakReplies: value?.autoSpeakReplies === true,
    wakePhrase,
    wakeTrainingSamples: normalizeWakeTrainingSamples(value?.wakeTrainingSamples),
    wakeObservedTranscriptions: normalizeWakeObservedTranscriptions(
      value?.wakeObservedTranscriptions
    ),
    wakeModel: normalizeWakeModel(value?.wakeModel, wakePhrase),
  };
}

export async function getAssistantName(): Promise<string> {
  return (await secureGet(KEYS.assistantName)) || DEFAULTS.name;
}

export async function setAssistantName(name: string): Promise<void> {
  await secureSet(KEYS.assistantName, name);
}

export async function getSettings(): Promise<AssistantSettings> {
  const raw = await secureGet(KEYS.settings);
  if (!raw) return DEFAULTS.settings;

  try {
    const parsed = JSON.parse(raw) || {};
    return normalizeAssistantSettings(parsed);
  } catch {
    return DEFAULTS.settings;
  }
}

export async function setSettings(s: AssistantSettings): Promise<void> {
  const normalized = normalizeAssistantSettings(s);

  await secureSet(KEYS.settings, JSON.stringify(normalized));
}


export async function clearAssistantStorage(): Promise<void> {
  await Promise.all([secureDelete(KEYS.assistantName), secureDelete(KEYS.settings)]);
}
