import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";

type Tone = "pro" | "friendly";
type LanguageMode = "en" | "ta";

function compactWakeSamples(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5),
    ),
  );
}

function getWakeStatusLabel(status?: string) {
  if (status === "ready" || status === "e2e_mock") return "Ready";
  if (status === "pending" || status === "missing" || status === "unsupported") return "Needs model";
  if (status === "error") return "Try again";
  return "Needs model";
}

export default function CustomiseScreen() {
  const insets = useSafeAreaInsets();
  const { name, settings, refresh, updateName, updateSettings } = useAssistant();

  const [assistantNameInput, setAssistantNameInput] = useState(name || "Elli");
  const [tone, setTone] = useState<Tone>(settings.tone);
  const [languageMode, setLanguageMode] = useState<LanguageMode>(settings.languageMode);
  const [allowCloudFallback, setAllowCloudFallback] = useState(settings.allowCloudFallback);
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(settings.handsFreeEnabled);
  const [wakePhrase, setWakePhrase] = useState(settings.wakePhrase || `Hey ${name || "Elli"}`);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
    setAllowCloudFallback(settings.allowCloudFallback);
    setHandsFreeEnabled(settings.handsFreeEnabled);
    setWakePhrase(settings.wakePhrase || `Hey ${name || "Elli"}`);
  }, [name, settings]);

  const assistantLabel = useMemo(() => (name || "Elli").trim() || "Elli", [name]);
  const displayName = useMemo(
    () => assistantNameInput.trim() || assistantLabel,
    [assistantLabel, assistantNameInput],
  );
  const wakePrompt = useMemo(
    () => wakePhrase.trim() || `Hey ${displayName}`,
    [displayName, wakePhrase],
  );
  const savedWakePrompt = (settings.wakePhrase || `Hey ${name || "Elli"}`).trim();
  const wakeStatusLabel = getWakeStatusLabel(settings.wakeModel?.status);

  const isDirty =
    assistantNameInput.trim() !== assistantLabel ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode ||
    allowCloudFallback !== settings.allowCloudFallback ||
    handsFreeEnabled !== settings.handsFreeEnabled ||
    wakePrompt !== savedWakePrompt;

  async function handleSave() {
    const trimmedName = assistantNameInput.trim();
    const cloudFallbackChanged = allowCloudFallback !== settings.allowCloudFallback;

    if (!trimmedName) {
      Alert.alert("Assistant name required", "Enter an assistant name.");
      return;
    }

    try {
      setSaving(true);

      if (trimmedName !== assistantLabel) {
        await updateName(trimmedName);
      }

      if (isDirty) {
        const wakePhraseChanged = wakePrompt !== savedWakePrompt;
        await updateSettings({
          tone,
          languageMode,
          ...(cloudFallbackChanged
            ? { allowCloudFallback, cloudFallbackUserChoice: true }
            : {}),
          handsFreeEnabled,
          wakePhrase: wakePrompt,
          wakeTrainingSamples: compactWakeSamples(settings.wakeTrainingSamples || []),
          ...(wakePhraseChanged
            ? {
                wakeModel: {
                  status: "pending",
                  wakePhrase: wakePrompt,
                  updatedAt: new Date().toISOString(),
                  detail: "Needs model",
                },
              }
            : {}),
        });
      }

      await refresh();
      Alert.alert("Saved", "Settings updated.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not save settings.";
      Alert.alert("Save failed", message);
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
            <Pressable style={styles.iconBtn} onPress={() => router.back()}>
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
            </Pressable>
            <Text style={styles.topTitle}>Settings</Text>
            <View style={styles.iconBtnPlaceholder} />
          </View>

          <GlassCard style={styles.card}>
            <Text style={styles.sectionTitle}>Assistant name</Text>
            <LabeledInput
              label="Assistant name"
              icon="sparkles-outline"
              value={assistantNameInput}
              onChangeText={setAssistantNameInput}
              placeholder="Elli"
            />
          </GlassCard>

          <GlassCard style={styles.card}>
            <Text style={styles.sectionTitle}>Tone</Text>
            <View style={styles.optionRow}>
              <OptionCard
                icon="briefcase-outline"
                title="Professional"
                active={tone === "pro"}
                onPress={() => setTone("pro")}
              />
              <OptionCard
                icon="happy-outline"
                title="Friendly"
                active={tone === "friendly"}
                onPress={() => setTone("friendly")}
              />
            </View>
          </GlassCard>

          <GlassCard style={styles.card}>
            <Text style={styles.sectionTitle}>Reply language</Text>
            <View style={styles.optionRow}>
              <OptionCard
                icon="language-outline"
                title="Tamil"
                active={languageMode === "ta"}
                onPress={() => setLanguageMode("ta")}
              />
              <OptionCard
                icon="globe-outline"
                title="English"
                active={languageMode === "en"}
                onPress={() => setLanguageMode("en")}
              />
            </View>
          </GlassCard>

          <GlassCard style={styles.card}>
            <Text style={styles.sectionTitle}>Hands-free</Text>

            <View style={styles.switchCard}>
              <Text style={styles.inputLabel}>Hands-free</Text>
              <Switch
                value={handsFreeEnabled}
                onValueChange={(enabled) => {
                  setHandsFreeEnabled(enabled);
                  if (enabled && !wakePhrase.trim()) {
                    setWakePhrase(`Hey ${displayName}`);
                  }
                }}
                testID="customise-hands-free-switch"
                accessibilityLabel="customise-hands-free-switch"
                trackColor={{ false: "rgba(124, 99, 80, 0.18)", true: "rgba(215,154,89,0.55)" }}
                thumbColor="#fff7ef"
              />
            </View>

            <LabeledInput
              label="Wake phrase"
              icon="mic-outline"
              value={wakePhrase}
              onChangeText={setWakePhrase}
              placeholder={`Hey ${displayName}`}
              testID="customise-wake-phrase-input"
              accessibilityLabel="customise-wake-phrase-input"
            />

            <View style={styles.statusRow}>
              <View style={styles.statusChip}>
                <Text style={styles.statusChipText}>{wakeStatusLabel}</Text>
              </View>
              <Pressable
                onPress={() => router.push("/setup")}
                testID="customise-wake-trainer-button"
                accessibilityLabel="customise-wake-trainer-button"
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Ionicons name="radio-outline" size={16} color={Brand.ink} />
                <Text style={styles.secondaryBtnText}>Train wake phrase</Text>
              </Pressable>
            </View>

            <View style={styles.switchCard}>
              <Text style={styles.inputLabel}>Cloud fallback</Text>
              <Switch
                value={allowCloudFallback}
                onValueChange={setAllowCloudFallback}
                trackColor={{ false: "rgba(124, 99, 80, 0.18)", true: "rgba(215,154,89,0.55)" }}
                thumbColor="#fff7ef"
              />
            </View>

            <Pressable
              onPress={handleSave}
              disabled={saving || !isDirty}
              testID="customise-save-button"
              accessibilityLabel="customise-save-button"
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primaryShell,
                (saving || !isDirty) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <LinearGradient
                colors={Brand.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryBtn}
              >
                {saving ? (
                  <ActivityIndicator color={Brand.ink} />
                ) : (
                  <>
                    <Text style={styles.primaryBtnText}>Save</Text>
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

function OptionCard({
  icon,
  title,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionCard,
        active && styles.optionCardActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.optionIconWrap}>
        <Ionicons name={icon} size={16} color={active ? Brand.ink : Brand.bronze} />
      </View>
      <Text style={[styles.optionTitle, active && styles.optionTitleActive]}>{title}</Text>
    </Pressable>
  );
}

function LabeledInput({
  label,
  icon,
  value,
  onChangeText,
  placeholder,
  testID,
  accessibilityLabel,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.inputShell}>
        <View style={styles.inputIconWrap}>
          <Ionicons name={icon} size={16} color={Brand.bronze} />
        </View>
        <TextInput
          value={value}
          testID={testID}
          accessibilityLabel={accessibilityLabel}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="rgba(124, 99, 80, 0.52)"
          autoCapitalize="words"
          style={styles.input}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
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
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  iconBtnPlaceholder: { width: 42, height: 42 },
  topTitle: { color: Brand.ink, fontSize: 18, fontWeight: "900" },
  card: { borderRadius: 28, marginTop: 16 },
  sectionTitle: { color: Brand.ink, fontSize: 19, fontWeight: "900" },
  inputLabel: { color: Brand.cocoa, fontSize: 13, fontWeight: "800", marginBottom: 8 },
  inputShell: {
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  inputIconWrap: { width: 46, minHeight: 56, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: 56, paddingRight: 14, color: Brand.ink, fontSize: 15 },
  switchCard: {
    marginTop: 16,
    minHeight: 66,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  optionCard: {
    flex: 1,
    minWidth: 140,
    borderRadius: 22,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  optionCardActive: {
    backgroundColor: "rgba(255,229,180,0.78)",
    borderColor: "rgba(185,120,54,0.22)",
  },
  optionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  optionTitle: { marginTop: 12, color: Brand.cocoa, fontSize: 14, fontWeight: "900" },
  optionTitleActive: { color: Brand.ink },
  statusRow: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  statusChip: {
    minHeight: 38,
    borderRadius: 999,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.66)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.18)",
  },
  statusChipText: { color: Brand.ink, fontSize: 12, fontWeight: "900" },
  secondaryBtn: {
    minHeight: 44,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.68)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  secondaryBtnText: { color: Brand.ink, fontSize: 14, fontWeight: "800" },
  primaryShell: { borderRadius: 18, overflow: "hidden", marginTop: 22 },
  primaryBtn: {
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
  primaryBtnText: { color: Brand.ink, fontSize: 15, fontWeight: "900" },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.94, transform: [{ scale: 0.995 }] },
});
