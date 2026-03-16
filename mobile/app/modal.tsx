import React, { useEffect, useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { AssistantSettings } from "@/lib/storage";

export default function SettingsModal() {
  const { name, settings, updateName, updateSettings } = useAssistant();
  const [n, setN] = useState(name);
  const [tone, setTone] = useState<AssistantSettings["tone"]>(settings.tone);
  const [languageMode, setLanguageMode] = useState<AssistantSettings["languageMode"]>(
    settings.languageMode
  );

  useEffect(() => {
    setN(name);
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
  }, [name, settings.languageMode, settings.tone]);

  async function save() {
    await updateName(n.trim() || "Elli");
    await updateSettings({ tone, languageMode });
    router.back();
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 16 }}>
        <Pressable onPress={() => router.back()} style={{ marginBottom: 10 }}>
          <Text style={{ color: "rgba(255,255,255,0.75)", fontWeight: "900" }}>✕ Close</Text>
        </Pressable>

        <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 26, fontWeight: "900" }}>
          Settings
        </Text>

        <GlassCard style={{ marginTop: 14 }}>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontWeight: "900" }}>
            Assistant name
          </Text>
          <TextInput
            value={n}
            onChangeText={setN}
            placeholder="Elli"
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{
              marginTop: 10,
              height: 48,
              borderRadius: 14,
              paddingHorizontal: 12,
              color: "white",
              backgroundColor: "rgba(255,255,255,0.06)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.10)",
            }}
          />
        </GlassCard>

        <GlassCard style={{ marginTop: 14 }}>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontWeight: "900" }}>
            Personality
          </Text>

          <Row>
            <Pill active={tone === "pro"} label="Professional" onPress={() => setTone("pro")} />
            <Pill active={tone === "friendly"} label="Friendly" onPress={() => setTone("friendly")} />
          </Row>
        </GlassCard>

        <GlassCard style={{ marginTop: 14 }}>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontWeight: "900" }}>
            Reply language
          </Text>

          <Row>
            <Pill
              active={languageMode === "en"}
              label="English"
              onPress={() => setLanguageMode("en")}
            />
            <Pill
              active={languageMode === "ta"}
              label="Tamil"
              onPress={() => setLanguageMode("ta")}
            />
          </Row>

          <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.55)" }}>
            New replies will follow this language preference.
          </Text>
        </GlassCard>

        <Pressable
          onPress={save}
          style={{
            marginTop: 16,
            height: 54,
            borderRadius: 16,
            backgroundColor: "rgba(34,211,238,0.22)",
            borderWidth: 1,
            borderColor: "rgba(34,211,238,0.35)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "white", fontWeight: "900", fontSize: 16 }}>Save</Text>
        </Pressable>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 10, marginTop: 12, flexWrap: "wrap" }}>{children}</View>;
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? "rgba(34,211,238,0.45)" : "rgba(255,255,255,0.10)",
        backgroundColor: active ? "rgba(34,211,238,0.16)" : "rgba(255,255,255,0.06)",
      }}
    >
      <Text style={{ color: "rgba(255,255,255,0.85)", fontWeight: "900" }}>{label}</Text>
    </Pressable>
  );
}