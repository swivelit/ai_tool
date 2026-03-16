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

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [name, setName] = useState("Elli");
  const [settings, setS] = useState<AssistantSettings>({
    tone: "pro",
    languageMode: "ta",
  });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [assistantName, savedSettings, savedProfile] = await Promise.all([
      getAssistantName(),
      getSettings(),
      getProfileForFirebaseUid(user?.uid, user?.email),
    ]);

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
  }, [user?.email, user?.uid]);

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