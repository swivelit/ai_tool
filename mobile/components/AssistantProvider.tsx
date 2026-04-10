import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AssistantSettings,
  getAssistantName,
  getSettings,
  setAssistantName,
  setSettings,
} from "@/lib/storage";
import { createProfileOnBackend, getProfileForFirebaseUid, UserProfile } from "@/lib/account";
import { useAuth } from "@/components/AuthProvider";

type Ctx = {
  name: string;
  settings: AssistantSettings;
  profile: UserProfile | null;
  userId?: number;
  loading: boolean;
  refresh: () => Promise<void>;
  updateName: (n: string) => Promise<void>;
  updateSettings: (s: AssistantSettings) => Promise<void>;
};

const AssistantContext = createContext<Ctx | null>(null);

const PROFILE_RESTORE_TIMEOUT_MS = 4500;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: boolean; value: T | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, value: null });
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [name, setName] = useState("Elli");
  const [settings, setS] = useState<AssistantSettings>({
    tone: "pro",
    languageMode: "ta",
  });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrateState = useCallback(
    async (
      assistantName: string,
      savedSettings: AssistantSettings,
      savedProfile: UserProfile | null
    ) => {
      const resolvedAssistantName =
        assistantName && assistantName !== "Elli"
          ? assistantName
          : savedProfile?.assistantName || assistantName || "Elli";

      if (savedProfile?.assistantName && savedProfile.assistantName !== assistantName) {
        await setAssistantName(savedProfile.assistantName);
      }

      const resolvedSettings: AssistantSettings = {
        tone: savedSettings.tone,
        languageMode: savedProfile?.replyLanguage || savedSettings.languageMode || "ta",
      };

      if (
        resolvedSettings.tone !== savedSettings.tone ||
        resolvedSettings.languageMode !== savedSettings.languageMode
      ) {
        await setSettings(resolvedSettings);
      }

      setName(resolvedAssistantName);
      setS(resolvedSettings);
      setProfile(savedProfile);
    },
    []
  );

  const loadProfileWithTimeout = useCallback(async () => {
    if (!user?.uid && !user?.email) {
      return null;
    }

    try {
      const result = await withTimeout(
        getProfileForFirebaseUid(user?.uid, user?.email),
        PROFILE_RESTORE_TIMEOUT_MS
      );

      if (result.timedOut) {
        console.warn(
          `[assistant] Profile restore timed out after ${PROFILE_RESTORE_TIMEOUT_MS}ms. Continuing app boot without blocking.`
        );
        return null;
      }

      return result.value;
    } catch (error) {
      console.warn("[assistant] Failed to restore assistant profile:", error);
      return null;
    }
  }, [user?.email, user?.uid]);

  const refresh = useCallback(async () => {
    const [assistantName, savedSettings, savedProfile] = await Promise.all([
      getAssistantName(),
      getSettings(),
      loadProfileWithTimeout(),
    ]);

    await hydrateState(assistantName, savedSettings, savedProfile);
  }, [hydrateState, loadProfileWithTimeout]);

  async function updateName(nextName: string) {
    await setAssistantName(nextName);

    if (profile) {
      try {
        await createProfileOnBackend({
          ...profile,
          assistantName: nextName,
          replyLanguage: profile.replyLanguage || settings.languageMode,
        });
      } catch (error) {
        console.warn("[assistant] Failed to sync assistant name to backend:", error);
      }
    }

    await refresh();
  }

  async function updateSettings(nextSettings: AssistantSettings) {
    await setSettings(nextSettings);

    if (profile) {
      try {
        await createProfileOnBackend({
          ...profile,
          assistantName: name,
          replyLanguage: nextSettings.languageMode,
        });
      } catch (error) {
        console.warn("[assistant] Failed to sync reply language to backend:", error);
      }
    }

    await refresh();
  }

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoading(true);
        await refresh();
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      alive = false;
    };
  }, [refresh]);

  const value = useMemo(
    () => ({
      name,
      settings,
      profile,
      userId: profile?.userId,
      loading,
      refresh,
      updateName,
      updateSettings,
    }),
    [name, settings, profile, loading, refresh]
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}