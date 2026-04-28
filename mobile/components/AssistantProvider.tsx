import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useAuth } from "@/components/AuthProvider";
import {
  createProfileOnBackend,
  getProfile,
  getProfileForFirebaseUid,
  saveProfile,
  UserProfile,
} from "@/lib/account";
import {
  AssistantSettings,
  DEFAULTS,
  getAssistantName,
  getSettings,
  setAssistantName,
  setSettings,
} from "@/lib/storage";

type AssistantContextType = {
  name: string;
  settings: AssistantSettings;
  profile: UserProfile | null;
  userId: number | null;
  loading: boolean;
  refresh: () => Promise<UserProfile | null>;
  updateName: (nextName: string) => Promise<void>;
  updateSettings: (nextSettings: Partial<AssistantSettings>) => Promise<void>;
};

const AssistantContext = createContext<AssistantContextType | null>(null);

function normalizeName(value?: string | null) {
  const trimmed = String(value || "").trim();
  return trimmed || DEFAULTS.name;
}

function normalizeWakePhrase(value?: string | null) {
  const trimmed = String(value || "").trim();
  return trimmed || DEFAULTS.settings.wakePhrase;
}

function normalizeWakeTrainingSamples(value?: string[] | null) {
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

function normalizeSettings(value?: Partial<AssistantSettings> | null): AssistantSettings {
  return {
    tone: value?.tone === "friendly" ? "friendly" : DEFAULTS.settings.tone,
    languageMode:
      value?.languageMode === "en" || value?.languageMode === "ta"
        ? value.languageMode
        : DEFAULTS.settings.languageMode,
    allowCloudFallback: value?.allowCloudFallback === true,
    handsFreeEnabled: Boolean(value?.handsFreeEnabled),
    wakePhrase: normalizeWakePhrase(value?.wakePhrase),
    wakeTrainingSamples: normalizeWakeTrainingSamples(value?.wakeTrainingSamples),
  };
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [name, setNameState] = useState<string>(DEFAULTS.name);
  const [settings, setSettingsState] = useState<AssistantSettings>(DEFAULTS.settings);
  const [profile, setProfileState] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [storedName, storedSettings] = await Promise.all([getAssistantName(), getSettings()]);

    const normalizedStoredName = normalizeName(storedName);
    const normalizedStoredSettings = normalizeSettings(storedSettings);

    let nextProfile: UserProfile | null = null;

    if (user?.uid || user?.email) {
      nextProfile = await getProfileForFirebaseUid(user.uid, user.email);
    } else {
      nextProfile = await getProfile();
    }

    const resolvedName = normalizeName(
      nextProfile?.assistantName || normalizedStoredName || DEFAULTS.name
    );

    const resolvedSettings: AssistantSettings = {
      ...normalizedStoredSettings,
      languageMode:
        nextProfile?.replyLanguage === "en" || nextProfile?.replyLanguage === "ta"
          ? nextProfile.replyLanguage
          : normalizedStoredSettings.languageMode,
    };

    setNameState(resolvedName);
    setSettingsState(resolvedSettings);
    setProfileState(nextProfile);

    if (resolvedName !== normalizedStoredName) {
      await setAssistantName(resolvedName);
    }

    const settingsChanged =
      resolvedSettings.tone !== normalizedStoredSettings.tone ||
      resolvedSettings.languageMode !== normalizedStoredSettings.languageMode ||
      resolvedSettings.allowCloudFallback !== normalizedStoredSettings.allowCloudFallback ||
      resolvedSettings.handsFreeEnabled !== normalizedStoredSettings.handsFreeEnabled ||
      resolvedSettings.wakePhrase !== normalizedStoredSettings.wakePhrase ||
      JSON.stringify(resolvedSettings.wakeTrainingSamples) !==
        JSON.stringify(normalizedStoredSettings.wakeTrainingSamples);

    if (settingsChanged) {
      await setSettings(resolvedSettings);
    }

    return nextProfile;
  }, [user?.email, user?.uid]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        await refresh();
      } catch (error) {
        console.warn("[assistant] Failed to bootstrap assistant state:", error);
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [refresh]);

  const updateName = useCallback(
    async (nextName: string) => {
      const resolvedName = normalizeName(nextName);

      await setAssistantName(resolvedName);
      setNameState(resolvedName);

      if (!profile) {
        return;
      }

      const updatedProfile: UserProfile = {
        ...profile,
        assistantName: resolvedName,
      };

      await saveProfile(updatedProfile);
      setProfileState(updatedProfile);

      try {
        const syncedProfile = await createProfileOnBackend(updatedProfile);
        setProfileState(syncedProfile);
      } catch (error) {
        console.warn("[assistant] Failed to sync assistant name to backend:", error);
      }
    },
    [profile]
  );

  const updateSettings = useCallback(
    async (nextSettings: Partial<AssistantSettings>) => {
      const resolvedSettings = normalizeSettings({
        ...settings,
        ...nextSettings,
      });

      await setSettings(resolvedSettings);
      setSettingsState(resolvedSettings);

      if (!profile) {
        return;
      }

      const updatedProfile: UserProfile = {
        ...profile,
        replyLanguage: resolvedSettings.languageMode,
      };

      await saveProfile(updatedProfile);
      setProfileState(updatedProfile);

      try {
        const syncedProfile = await createProfileOnBackend(updatedProfile);
        setProfileState(syncedProfile);
      } catch (error) {
        console.warn("[assistant] Failed to sync assistant settings to backend:", error);
      }
    },
    [name, profile, settings]
  );

  const value = useMemo<AssistantContextType>(
    () => ({
      name,
      settings,
      profile,
      userId: profile?.userId ?? null,
      loading,
      refresh,
      updateName,
      updateSettings,
    }),
    [loading, name, profile, refresh, settings, updateName, updateSettings]
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);

  if (!ctx) {
    throw new Error("useAssistant must be used within AssistantProvider");
  }

  return ctx;
}
