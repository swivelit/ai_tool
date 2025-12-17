import AsyncStorage from "@react-native-async-storage/async-storage";

export const KEYS = {
  assistantName: "assistant_name_v1",
  settings: "assistant_settings_v1",
};

export type AssistantTone = "pro" | "friendly";
export type LanguageMode = "ta" | "mixed";

export type AssistantSettings = {
  tone: AssistantTone;
  languageMode: LanguageMode;
};

export const DEFAULTS: { name: string; settings: AssistantSettings } = {
  name: "Elli",
  settings: { tone: "pro", languageMode: "mixed" },
};

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
    return { ...DEFAULTS.settings, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS.settings;
  }
}

export async function setSettings(s: AssistantSettings): Promise<void> {
  await AsyncStorage.setItem(KEYS.settings, JSON.stringify(s));
}
