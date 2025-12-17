import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "assistant_name_v1";
const DEFAULT_NAME = "Elli";

export async function getAssistantName(): Promise<string | null> {
  const v = await AsyncStorage.getItem(KEY);
  return v;
}

export async function setAssistantName(name: string): Promise<void> {
  await AsyncStorage.setItem(KEY, name);
}

export async function ensureAssistantName(): Promise<string> {
  const existing = await getAssistantName();
  return existing ?? DEFAULT_NAME;
}

export { KEY as ASSISTANT_NAME_KEY, DEFAULT_NAME as DEFAULT_ASSISTANT_NAME };
