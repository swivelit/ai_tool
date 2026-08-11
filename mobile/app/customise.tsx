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
import { Screen } from "@/components/ui";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand, Elevation, Radius, Spacing, Type } from "@/constants/theme";

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
    setHandsFreeEnabled(
      settings.handsFreeEnabled &&
        (settings.wakeModel?.status === "ready" || settings.wakeModel?.status === "e2e_mock"),
    );
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
  const wakeModelReady =
    settings.wakeModel?.status === "ready" || settings.wakeModel?.status === "e2e_mock";
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
          // Clear any pre-cleanup opt-in stored by a historical Life Context build.
          lifeContextEnabled: false,
          shareLifeContextWithBackend: false,
          shareAppNamesWithAi: false,
          handsFreeEnabled: wakePhraseChanged ? false : handsFreeEnabled && wakeModelReady,
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
    <Screen safeArea={false} style={styles.page}>
      <StatusBar style="light" />

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            paddingTop: insets.top + Spacing.sm,
            paddingHorizontal: Spacing.lg,
            paddingBottom: Math.max(insets.bottom + Spacing.xxl, 28),
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
                value={handsFreeEnabled && wakeModelReady}
                onValueChange={(enabled) => {
                  if (enabled && !wakeModelReady) {
                    setHandsFreeEnabled(false);
                    Alert.alert("Wake model needed", "Train your wake phrase to turn this on.");
                    return;
                  }
                  setHandsFreeEnabled(enabled);
                  if (enabled && !wakePhrase.trim()) {
                    setWakePhrase(`Hey ${displayName}`);
                  }
                }}
                testID="customise-hands-free-switch"
                accessibilityLabel="customise-hands-free-switch"
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
                thumbColor="#eaf4ff"
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
                <Text style={styles.secondaryBtnText}>Train wake phrase</Text>
              </Pressable>
            </View>

            <View style={styles.switchCard}>
              <Text style={styles.inputLabel}>Cloud fallback</Text>
              <Switch
                value={allowCloudFallback}
                onValueChange={setAllowCloudFallback}
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
                thumbColor="#eaf4ff"
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
    </Screen>
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
          placeholderTextColor="rgba(226, 238, 255, 0.46)"
          autoCapitalize="words"
          style={styles.input}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  topBar: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  iconBtnPlaceholder: { width: 42, height: 42 },
  topTitle: { ...Type.subheading, color: Brand.ink },
  card: { borderRadius: Radius.xxl, marginTop: Spacing.lg },
  sectionTitle: { ...Type.heading, color: Brand.ink },
  helperText: {
    ...Type.caption,
    fontWeight: "500",
    marginTop: Spacing.sm,
    color: Brand.cocoa,
  },
  inputLabel: { ...Type.caption, fontWeight: "700", color: Brand.cocoa, marginBottom: Spacing.sm },
  inputShell: {
    borderRadius: Radius.md,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  inputIconWrap: { width: 46, minHeight: 56, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: 56, paddingRight: Spacing.lg, color: Brand.ink, fontSize: Type.body.fontSize },
  switchCard: {
    marginTop: Spacing.lg,
    minHeight: 66,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },
  switchTextBlock: { flex: 1, minWidth: 0 },
  switchHint: {
    ...Type.caption,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "500",
    color: Brand.muted,
  },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, marginTop: Spacing.lg },
  optionCard: {
    flex: 1,
    minWidth: 140,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  optionCardActive: {
    backgroundColor: "rgba(87, 222, 255, 0.10)",
    borderColor: "rgba(87, 222, 255, 0.20)",
  },
  optionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  optionTitle: { ...Type.callout, fontWeight: "800", marginTop: Spacing.md, color: Brand.cocoa },
  optionTitleActive: { color: Brand.ink },
  statusRow: {
    marginTop: Spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },
  statusChip: {
    minHeight: 38,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(87, 222, 255, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(87, 222, 255, 0.18)",
  },
  statusChipText: { ...Type.caption, fontWeight: "800", color: Brand.ink },
  secondaryBtn: {
    minHeight: 44,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  secondaryBtnText: { ...Type.callout, fontWeight: "700", color: Brand.ink },
  primaryShell: { borderRadius: Radius.md, overflow: "hidden", marginTop: Spacing.xl },
  primaryBtn: {
    minHeight: 54,
    borderRadius: Radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    ...Elevation.glow,
  },
  primaryBtnText: { ...Type.subheading, color: Brand.ink },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.94, transform: [{ scale: 0.995 }] },
});
