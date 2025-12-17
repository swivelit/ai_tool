import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { AssistantSettings, getAssistantName, getSettings, setAssistantName, setSettings } from "@/lib/storage";

type Ctx = {
  name: string;
  settings: AssistantSettings;
  refresh: () => Promise<void>;
  updateName: (n: string) => Promise<void>;
  updateSettings: (s: AssistantSettings) => Promise<void>;
};

const AssistantContext = createContext<Ctx | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState("Elli");
  const [settings, setS] = useState<AssistantSettings>({ tone: "pro", languageMode: "mixed" });

  async function refresh() {
    setName(await getAssistantName());
    setS(await getSettings());
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

  const value = useMemo(() => ({ name, settings, refresh, updateName, updateSettings }), [name, settings]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}
