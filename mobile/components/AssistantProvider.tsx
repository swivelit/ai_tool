import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  AssistantSettings,
  getAssistantName,
  getSettings,
  setAssistantName,
  setSettings,
} from "@/lib/storage";
import { getProfile, UserProfile } from "@/lib/account";

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
  const [name, setName] = useState("Elli");
  const [settings, setS] = useState<AssistantSettings>({
    tone: "pro",
    languageMode: "mixed",
  });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setLoading(true);
      const [assistantName, savedSettings, savedProfile] = await Promise.all([
        getAssistantName(),
        getSettings(),
        getProfile(),
      ]);

      setName(assistantName || "Elli");
      setS(savedSettings);
      setProfile(savedProfile);
    } finally {
      setLoading(false);
    }
  }

  async function updateName(n: string) {
    await setAssistantName(n);
    await refresh();
  }

  async function updateSettings(s: AssistantSettings) {
    await setSettings(s);
    await refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

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
    [name, settings, profile, loading]
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}