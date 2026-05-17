import {
  ReplyLanguage,
  normalizeReplyLanguage,
} from "./replyLanguage";

const PROFILE_CACHE_KEY = "user_profile_v1";
const PROFILE_BACKUP_CACHE_KEY = "user_profile_v1_backup";

type LocalProfileCacheRecord = Record<string, any>;

export type LocalAssistantUserProfile = {
  name?: string;
  place?: string;
  assistantName?: string;
  replyLanguage?: ReplyLanguage;
};

async function safeGetStoredValue(key: string): Promise<string | null> {
  try {
    const SecureStore = await import("expo-secure-store");
    if (typeof SecureStore?.getItemAsync === "function") {
      const secureValue = await SecureStore.getItemAsync(key);
      if (typeof secureValue === "string") return secureValue;
    }
  } catch {
    // Fall back to AsyncStorage; profile context is optional for local chat.
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

function safeParseProfile(raw: string | null): LocalProfileCacheRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  const trimmed = String(value || "").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function toLocalAssistantProfile(
  cached: LocalProfileCacheRecord | null,
  requestedUserId?: number,
): LocalAssistantUserProfile | undefined {
  if (!cached) return undefined;
  if (cached.restoreFailed && !positiveNumber(cached.userId ?? cached.user_id)) {
    return undefined;
  }

  const cachedUserId = positiveNumber(cached.userId ?? cached.user_id ?? cached.id);
  if (requestedUserId && cachedUserId && cachedUserId !== requestedUserId) {
    return undefined;
  }

  const profile: LocalAssistantUserProfile = {};
  const name = cleanString(cached.name, 120);
  const place = cleanString(cached.place, 200);
  const assistantName = cleanString(
    cached.assistantName ?? cached.assistant_name,
    80,
  );
  const replyLanguage = normalizeReplyLanguage(
    cached.replyLanguage ?? cached.reply_language,
  );

  if (name) profile.name = name;
  if (place) profile.place = place;
  if (assistantName) profile.assistantName = assistantName;
  if (replyLanguage) profile.replyLanguage = replyLanguage;

  return Object.keys(profile).length ? profile : undefined;
}

export async function loadCachedLocalAssistantProfile(
  requestedUserId?: number,
): Promise<LocalAssistantUserProfile | undefined> {
  const primary = toLocalAssistantProfile(
    safeParseProfile(await safeGetStoredValue(PROFILE_CACHE_KEY)),
    requestedUserId,
  );
  if (primary) return primary;

  return toLocalAssistantProfile(
    safeParseProfile(await safeGetStoredValue(PROFILE_BACKUP_CACHE_KEY)),
    requestedUserId,
  );
}

export function withResolvedReplyLanguage(
  profile: LocalAssistantUserProfile | undefined,
  replyLanguage: ReplyLanguage,
): LocalAssistantUserProfile | undefined {
  if (!profile) return undefined;
  return {
    ...profile,
    replyLanguage,
  };
}
