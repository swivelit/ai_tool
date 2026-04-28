const SETTINGS_CACHE_KEY = "assistant_settings_v1";

async function safeGetStoredValue(key: string): Promise<string | null> {
  try {
    const SecureStore = await import("expo-secure-store");
    if (typeof SecureStore?.getItemAsync === "function") {
      const secureValue = await SecureStore.getItemAsync(key);
      if (typeof secureValue === "string") return secureValue;
    }
  } catch {
    // Fall back to AsyncStorage; cloud fallback consent defaults to false.
  }

  try {
    const mod = await import("@react-native-async-storage/async-storage");
    const AsyncStorage = ((mod as any)?.default || mod) as {
      getItem?: (key: string) => Promise<string | null>;
    };
    if (typeof AsyncStorage?.getItem === "function") {
      const value = await AsyncStorage.getItem(key);
      return typeof value === "string" ? value : null;
    }
  } catch {
    return null;
  }

  return null;
}

export async function loadCloudFallbackConsent(): Promise<boolean> {
  const raw = await safeGetStoredValue(SETTINGS_CACHE_KEY);
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    return parsed?.allowCloudFallback === true;
  } catch {
    return false;
  }
}
