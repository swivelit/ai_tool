import AsyncStorage from "@react-native-async-storage/async-storage";

export const KEYS = {
  assistantName: "assistant_name_v1",
  settings: "assistant_settings_v1",
};

export type AssistantTone = "pro" | "friendly";
export type LanguageMode = "en" | "ta";

export type AssistantSettings = {
  tone: AssistantTone;
  languageMode: LanguageMode;
};

export const DEFAULTS: { name: string; settings: AssistantSettings } = {
  name: "Elli",
  settings: { tone: "pro", languageMode: "ta" },
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

export async function getAssistantName(): Promise<string> {
  return (await AsyncStorage.getItem(KEYS.assistantName)) || DEFAULTS.name;
}

export async function setAssistantName(name: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.assistantName, name);
}

export async function getSettings(): Promise<AssistantSettings> {
  const raw = await AsyncStorage.getItem(KEYS.settings);
  if (!raw) return DEFAULTS.settings;

  try {
    const parsed = JSON.parse(raw) || {};
    return {
      tone: parsed.tone === "friendly" ? "friendly" : DEFAULTS.settings.tone,
      languageMode: normalizeLanguageMode(parsed.languageMode),
    };
  } catch {
    return DEFAULTS.settings;
  }
}

export async function setSettings(s: AssistantSettings): Promise<void> {
  const normalized: AssistantSettings = {
    tone: s.tone === "friendly" ? "friendly" : "pro",
    languageMode: normalizeLanguageMode(s.languageMode),
  };

  await AsyncStorage.setItem(KEYS.settings, JSON.stringify(normalized));
}