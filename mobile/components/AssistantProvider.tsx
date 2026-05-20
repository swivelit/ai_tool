import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  getE2eMockUserProfile,
  isE2eMockAuthEnabled,
} from "@/lib/e2eMode";
import { resolveSettingsLanguageAfterProfileRestore } from "@/lib/profileSync";
import {
  AssistantSettings,
  DEFAULTS,
  getAssistantName,
  getSettings,
  normalizeAssistantSettings,
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

function normalizeSettings(value?: Partial<AssistantSettings> | null): AssistantSettings {
  return normalizeAssistantSettings(value);
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [name, setNameState] = useState<string>(DEFAULTS.name);
  const [settings, setSettingsState] = useState<AssistantSettings>(DEFAULTS.settings);
  const [profile, setProfileState] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const localSettingsChangedThisSessionRef = useRef(false);

  const refresh = useCallback(async () => {
    if (isE2eMockAuthEnabled()) {
      const mockProfile = getE2eMockUserProfile();
      const mockSettings: AssistantSettings = {
        ...DEFAULTS.settings,
        languageMode: mockProfile.replyLanguage || "en",
      };

      await Promise.all([
        saveProfile(mockProfile),
        setAssistantName(mockProfile.assistantName || DEFAULTS.name),
        setSettings(mockSettings),
      ]);

      setNameState(mockProfile.assistantName || DEFAULTS.name);
      setSettingsState(mockSettings);
      setProfileState(mockProfile);
      return mockProfile;
    }

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
      languageMode: resolveSettingsLanguageAfterProfileRestore({
        storedLanguageMode: normalizedStoredSettings.languageMode,
        backendReplyLanguage: nextProfile?.replyLanguage,
        localSettingsChangedThisSession: localSettingsChangedThisSessionRef.current,
      }),
    };
    const resolvedProfile = nextProfile
      ? {
          ...nextProfile,
          replyLanguage: resolvedSettings.languageMode,
        }
      : null;

    setNameState(resolvedName);
    setSettingsState(resolvedSettings);
    setProfileState(resolvedProfile);

    if (resolvedName !== normalizedStoredName) {
      await setAssistantName(resolvedName);
    }

    const settingsChanged =
      resolvedSettings.tone !== normalizedStoredSettings.tone ||
      resolvedSettings.languageMode !== normalizedStoredSettings.languageMode ||
      resolvedSettings.allowCloudFallback !== normalizedStoredSettings.allowCloudFallback ||
      resolvedSettings.cloudFallbackUserChoice !==
        normalizedStoredSettings.cloudFallbackUserChoice ||
      resolvedSettings.cloudFallbackPolicyVersion !==
        normalizedStoredSettings.cloudFallbackPolicyVersion ||
      resolvedSettings.handsFreeEnabled !== normalizedStoredSettings.handsFreeEnabled ||
      resolvedSettings.autoSpeakReplies !== normalizedStoredSettings.autoSpeakReplies ||
      resolvedSettings.wakePhrase !== normalizedStoredSettings.wakePhrase ||
      JSON.stringify(resolvedSettings.wakeTrainingSamples) !==
        JSON.stringify(normalizedStoredSettings.wakeTrainingSamples);

    if (settingsChanged) {
      await setSettings(resolvedSettings);
    }
    if (resolvedProfile && resolvedProfile.replyLanguage !== nextProfile?.replyLanguage) {
      await saveProfile(resolvedProfile);
    }

    return resolvedProfile;
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
      const languageChanged =
        typeof nextSettings.languageMode !== "undefined" &&
        resolvedSettings.languageMode !== settings.languageMode;
      if (languageChanged) {
        localSettingsChangedThisSessionRef.current = true;
      }

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
        setProfileState({
          ...syncedProfile,
          replyLanguage: resolvedSettings.languageMode,
        });
      } catch (error) {
        console.warn("[assistant] Failed to sync assistant settings to backend:", error);
      }
    },
    [profile, settings]
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
