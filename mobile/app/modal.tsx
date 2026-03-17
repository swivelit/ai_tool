import React, { useEffect, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { AssistantSettings } from "@/lib/storage";
import { Brand } from "@/constants/theme";

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
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.page}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={styles.topGlow} />
          <View style={styles.leftGlow} />
          <View style={styles.bottomGlow} />
        </View>

        <View style={styles.content}>
          <Pressable onPress={() => router.back()} style={styles.closeBtn}>
            <Ionicons name="close" size={18} color={Brand.cocoa} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>

          <Text style={styles.title}>Quick settings</Text>
          <Text style={styles.subtitle}>
            A compact premium panel for fast preference changes.
          </Text>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Assistant name</Text>
            <TextInput
              value={n}
              onChangeText={setN}
              placeholder="Elli"
              placeholderTextColor="rgba(124, 99, 80, 0.52)"
              style={styles.input}
            />
          </GlassCard>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Personality</Text>
            <Row>
              <Pill active={tone === "pro"} label="Professional" onPress={() => setTone("pro")} />
              <Pill
                active={tone === "friendly"}
                label="Friendly"
                onPress={() => setTone("friendly")}
              />
            </Row>
          </GlassCard>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Reply language</Text>

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

            <Text style={styles.helperText}>
              New replies will follow this language preference.
            </Text>
          </GlassCard>

          <Pressable onPress={save} style={({ pressed }) => [styles.saveShell, pressed && styles.pressed]}>
            <LinearGradient
              colors={Brand.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtn}
            >
              <Text style={styles.saveText}>Save</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Pill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        active && styles.pillActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  content: {
    flex: 1,
    padding: 16,
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 240,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  closeBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  closeText: {
    color: Brand.cocoa,
    fontWeight: "900",
    fontSize: 14,
  },

  title: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 28,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  sectionTitle: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 16,
  },

  input: {
    marginTop: 10,
    height: 50,
    borderRadius: 16,
    paddingHorizontal: 12,
    color: Brand.ink,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  row: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
    flexWrap: "wrap",
  },

  pill: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.60)",
  },

  pillActive: {
    borderColor: "rgba(185,120,54,0.22)",
    backgroundColor: "rgba(255,229,180,0.82)",
  },

  pillText: {
    color: Brand.cocoa,
    fontWeight: "900",
  },

  pillTextActive: {
    color: Brand.ink,
  },

  helperText: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  saveShell: {
    marginTop: 16,
    borderRadius: 18,
    overflow: "hidden",
  },

  saveBtn: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },

  saveText: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 16,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});