import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";

export default function CustomiseScreen() {
  const insets = useSafeAreaInsets();
  const { name, settings, refresh, updateName, updateSettings } = useAssistant();

  const [assistantNameInput, setAssistantNameInput] = useState(name || "Elli");
  const [tone, setTone] = useState<"pro" | "friendly">(settings.tone);
  const [languageMode, setLanguageMode] = useState<"en" | "ta">(settings.languageMode);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
  }, [settings.languageMode, settings.tone]);

  const assistantLabel = useMemo(() => (name || "Elli").trim() || "Elli", [name]);

  const isDirty =
    assistantNameInput.trim() !== assistantLabel ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode;

  async function handleSave() {
    const trimmedName = assistantNameInput.trim();

    if (!trimmedName) {
      Alert.alert("Assistant name required", "Please enter an assistant name.");
      return;
    }

    try {
      setSaving(true);

      if (trimmedName !== assistantLabel) {
        await updateName(trimmedName);
      }

      if (tone !== settings.tone || languageMode !== settings.languageMode) {
        await updateSettings({
          tone,
          languageMode,
        });
      }

      await refresh();
      Alert.alert("Preferences saved", "Your assistant preferences have been updated.");
    } catch (error: any) {
      Alert.alert("Save failed", error?.message || "Could not save assistant preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 18,
            paddingBottom: Math.max(insets.bottom + 28, 28),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.topBar}>
            <Pressable style={styles.topIconBtn} onPress={() => router.back()}>
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
            </Pressable>

            <View style={styles.topCenter}>
              <Text style={styles.topTitle}>{`Customise (${assistantLabel})`}</Text>
            </View>

            <View style={styles.topIconBtn} />
          </View>

          <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
            <View style={styles.heroBadge}>
              <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
              <Text style={styles.heroBadgeText}>Assistant identity</Text>
            </View>

            <Text style={styles.heroTitle}>{assistantLabel}</Text>
            <Text style={styles.heroSubtitle}>
              Move assistant identity settings here so the main Settings screen stays lighter and easier to scan.
            </Text>

            <View style={styles.metricRow}>
              <MetricCard
                icon="briefcase-outline"
                label="Tone"
                value={tone === "friendly" ? "Friendly" : "Professional"}
              />
              <MetricCard
                icon="language-outline"
                label="Language"
                value={languageMode === "ta" ? "Tamil" : "English"}
              />
            </View>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Assistant name</Text>

            <Field
              label="Assistant name"
              value={assistantNameInput}
              onChangeText={setAssistantNameInput}
              placeholder="Elli"
              icon="sparkles-outline"
            />
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Tone</Text>

            <View style={styles.choiceRow}>
              <ChoiceCard
                label="Professional"
                helper="Sharper, structured replies"
                icon="briefcase-outline"
                active={tone === "pro"}
                onPress={() => setTone("pro")}
              />
              <ChoiceCard
                label="Friendly"
                helper="Warmer, casual replies"
                icon="happy-outline"
                active={tone === "friendly"}
                onPress={() => setTone("friendly")}
              />
            </View>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Reply language</Text>

            <View style={styles.choiceRow}>
              <ChoiceCard
                label="Tamil"
                helper="Localized assistant replies"
                icon="language-outline"
                active={languageMode === "ta"}
                onPress={() => setLanguageMode("ta")}
              />
              <ChoiceCard
                label="English"
                helper="Global default response mode"
                icon="globe-outline"
                active={languageMode === "en"}
                onPress={() => setLanguageMode("en")}
              />
            </View>

            <Pressable
              onPress={handleSave}
              disabled={saving || !isDirty}
              style={({ pressed }) => [
                styles.primaryButtonShell,
                (saving || !isDirty) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <LinearGradient
                colors={Brand.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {saving ? (
                  <ActivityIndicator color={Brand.ink} />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>Save</Text>
                    <Ionicons name="checkmark" size={16} color={Brand.ink} />
                  </>
                )}
              </LinearGradient>
            </Pressable>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={16} color={Brand.bronze} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ChoiceCard({
  label,
  helper,
  icon,
  active,
  onPress,
}: {
  label: string;
  helper: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceCard,
        active && styles.choiceCardActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.choiceCardIconWrap}>
        <Ionicons name={icon} size={16} color={active ? Brand.ink : Brand.bronze} />
      </View>
      <Text style={[styles.choiceCardTitle, active && styles.choiceCardTitleActive]}>
        {label}
      </Text>
      <Text style={styles.choiceCardHelper}>{helper}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  icon,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldShell}>
        <View style={styles.fieldIconWrap}>
          <Ionicons name={icon} size={16} color={Brand.bronze} />
        </View>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="rgba(124, 99, 80, 0.52)"
          autoCapitalize="words"
          style={styles.fieldInput}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
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
    width: 210,
    height: 210,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 270,
    height: 270,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  topBar: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topIconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },

  topTitle: {
    marginTop: 2,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  heroBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.70)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  heroTitle: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 28,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  metricLabel: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  metricValue: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 19,
    fontWeight: "900",
  },

  fieldLabel: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
  },

  fieldShell: {
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    minHeight: 56,
  },

  fieldIconWrap: {
    width: 46,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
  },

  fieldInput: {
    flex: 1,
    minHeight: 56,
    paddingRight: 14,
    color: Brand.ink,
    fontSize: 15,
  },

  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  choiceCard: {
    flex: 1,
    minWidth: 140,
    borderRadius: 22,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  choiceCardActive: {
    backgroundColor: "rgba(255,229,180,0.78)",
    borderColor: "rgba(185,120,54,0.22)",
  },

  choiceCardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  choiceCardTitle: {
    marginTop: 12,
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  choiceCardTitleActive: {
    color: Brand.ink,
  },

  choiceCardHelper: {
    marginTop: 5,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  primaryButtonShell: {
    borderRadius: 18,
    overflow: "hidden",
    marginTop: 22,
  },

  primaryButton: {
    minHeight: 54,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#d4934f",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },

  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  disabled: {
    opacity: 0.6,
  },

  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.995 }],
  },
});
