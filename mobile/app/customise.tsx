import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
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
import {
  getLifeContextPermissionState,
  getTodayLifeContextForAi,
  openLifeContextUsageSettings,
  requestLifeContextPermissions,
  type LifeContextAiSummary,
  type LifeContextPermissionSummary,
} from "@/lib/lifeContext";

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

const unavailableLifePermissions: LifeContextPermissionSummary = {
  activityRecognition: "unavailable",
  usageAccess: "unavailable",
};

function permissionLabel(value?: string) {
  if (value === "granted") return "Granted";
  if (value === "denied") return "Not granted";
  return "Unavailable";
}

export default function CustomiseScreen() {
  const insets = useSafeAreaInsets();
  const { name, settings, profile, refresh, updateName, updateSettings } = useAssistant();

  const [assistantNameInput, setAssistantNameInput] = useState(name || "Elli");
  const [tone, setTone] = useState<Tone>(settings.tone);
  const [languageMode, setLanguageMode] = useState<LanguageMode>(settings.languageMode);
  const [allowCloudFallback, setAllowCloudFallback] = useState(settings.allowCloudFallback);
  const [lifeContextEnabled, setLifeContextEnabled] = useState(settings.lifeContextEnabled);
  const [shareLifeContextWithBackend, setShareLifeContextWithBackend] = useState(
    settings.shareLifeContextWithBackend,
  );
  const [shareAppNamesWithAi, setShareAppNamesWithAi] = useState(settings.shareAppNamesWithAi);
  const [lifePermissionState, setLifePermissionState] =
    useState<LifeContextPermissionSummary>(unavailableLifePermissions);
  const [lifeSummary, setLifeSummary] = useState<LifeContextAiSummary | null>(null);
  const [lifeLoading, setLifeLoading] = useState(false);
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(settings.handsFreeEnabled);
  const [wakePhrase, setWakePhrase] = useState(settings.wakePhrase || `Hey ${name || "Elli"}`);
  const [saving, setSaving] = useState(false);
  const refreshLifeContextOnActiveRef = useRef(false);

  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
    setAllowCloudFallback(settings.allowCloudFallback);
    setLifeContextEnabled(settings.lifeContextEnabled);
    setShareLifeContextWithBackend(settings.shareLifeContextWithBackend);
    setShareAppNamesWithAi(settings.shareAppNamesWithAi);
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
  const previewLifeSettings = useMemo(
    () => ({
      lifeContextEnabled,
      shareLifeContextWithBackend,
      shareAppNamesWithAi,
    }),
    [lifeContextEnabled, shareAppNamesWithAi, shareLifeContextWithBackend],
  );

  useEffect(() => {
    let alive = true;
    setLifeLoading(true);
    void Promise.all([
      getLifeContextPermissionState(),
      getTodayLifeContextForAi({
        settings: previewLifeSettings,
        profile,
      }),
    ])
      .then(([permissions, summary]) => {
        if (!alive) return;
        setLifePermissionState(permissions);
        setLifeSummary(summary);
      })
      .catch(() => {
        if (!alive) return;
        setLifePermissionState(unavailableLifePermissions);
        setLifeSummary(null);
      })
      .finally(() => {
        if (alive) {
          setLifeLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [previewLifeSettings, profile]);

  const isDirty =
    assistantNameInput.trim() !== assistantLabel ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode ||
    allowCloudFallback !== settings.allowCloudFallback ||
    lifeContextEnabled !== settings.lifeContextEnabled ||
    shareLifeContextWithBackend !== settings.shareLifeContextWithBackend ||
    shareAppNamesWithAi !== settings.shareAppNamesWithAi ||
    handsFreeEnabled !== settings.handsFreeEnabled ||
    wakePrompt !== savedWakePrompt;

  const refreshLifeContextPreview = useCallback(async (forceRefresh = false) => {
    try {
      setLifeLoading(true);
      const [permissions, summary] = await Promise.all([
        getLifeContextPermissionState(),
        getTodayLifeContextForAi({
          settings: previewLifeSettings,
          profile,
          forceRefresh,
        }),
      ]);
      setLifePermissionState(permissions);
      setLifeSummary(summary);
    } finally {
      setLifeLoading(false);
    }
  }, [previewLifeSettings, profile]);

  async function handleRequestActivityPermission() {
    try {
      setLifeLoading(true);
      const permissions = await requestLifeContextPermissions();
      setLifePermissionState(permissions);
      const summary = await getTodayLifeContextForAi({
        settings: previewLifeSettings,
        profile,
        forceRefresh: true,
      });
      setLifeSummary(summary);
    } finally {
      setLifeLoading(false);
    }
  }

  async function handleOpenUsageAccessSettings() {
    refreshLifeContextOnActiveRef.current = true;
    await openLifeContextUsageSettings();
  }

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && refreshLifeContextOnActiveRef.current) {
        refreshLifeContextOnActiveRef.current = false;
        void refreshLifeContextPreview(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [refreshLifeContextPreview]);

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
          lifeContextEnabled,
          shareLifeContextWithBackend: lifeContextEnabled && shareLifeContextWithBackend,
          shareAppNamesWithAi: lifeContextEnabled && shareAppNamesWithAi,
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
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="light" />

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

          <GlassCard
            style={styles.card}
            testID="life-context-card"
            accessibilityLabel="life-context-card"
          >
            <Text style={styles.sectionTitle}>Life Intelligence</Text>
            <Text style={styles.helperText}>
              Opt-in only: uses Android step counter and Usage Access foreground app time. No
              camera, gaze tracking, or hidden monitoring. App names stay hidden unless you share
              them.
            </Text>

            <View style={styles.switchCard}>
              <View style={styles.switchTextBlock}>
                <Text style={styles.inputLabel}>
                  {lifeContextEnabled ? "Life Intelligence enabled" : "Enable Life Intelligence"}
                </Text>
                <Text style={styles.switchHint}>
                  Lets the assistant adapt to steps, screen time, permissions, and age group.
                </Text>
              </View>
              <Switch
                value={lifeContextEnabled}
                onValueChange={(enabled) => {
                  setLifeContextEnabled(enabled);
                  if (!enabled) {
                    setShareLifeContextWithBackend(false);
                    setShareAppNamesWithAi(false);
                  }
                }}
                testID="life-context-enable-toggle"
                accessibilityLabel="life-context-enable-toggle"
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
                thumbColor="#fff7ef"
              />
            </View>

            <View
              style={styles.lifeSummaryBox}
              testID="life-context-daily-summary"
              accessibilityLabel="life-context-daily-summary"
            >
              {lifeLoading ? (
                <ActivityIndicator color={Brand.cocoa} />
              ) : (
                <>
                  <Text style={styles.lifeSummaryText}>
                    Activity permission: {permissionLabel(lifePermissionState.activityRecognition)}
                  </Text>
                  <Text style={styles.lifeSummaryText}>
                    Usage access: {permissionLabel(lifePermissionState.usageAccess)}
                  </Text>
                  <Text style={styles.lifeSummaryText}>
                    Today: {lifeSummary?.movementSummary || "Steps not available"}
                  </Text>
                  <Text style={styles.lifeSummaryText}>
                    Phone: {lifeSummary?.screenSummary || "Screen/app time not available"}
                  </Text>
                </>
              )}
            </View>

            <View style={styles.lifeButtonRow}>
              <Pressable
                onPress={handleRequestActivityPermission}
                testID="life-context-activity-permission-button"
                accessibilityLabel="life-context-activity-permission-button"
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondaryBtn, styles.lifeButton, pressed && styles.pressed]}
              >
                <Ionicons name="walk-outline" size={16} color={Brand.ink} />
                <Text style={styles.secondaryBtnText}>Request activity permission</Text>
              </Pressable>
              <Pressable
                onPress={handleOpenUsageAccessSettings}
                testID="life-context-usage-settings-button"
                accessibilityLabel="life-context-usage-settings-button"
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondaryBtn, styles.lifeButton, pressed && styles.pressed]}
              >
                <Ionicons name="phone-portrait-outline" size={16} color={Brand.ink} />
                <Text style={styles.secondaryBtnText}>Open Usage Access Settings</Text>
              </Pressable>
            </View>

            <View style={styles.switchCard}>
              <View style={styles.switchTextBlock}>
                <Text style={styles.inputLabel}>Share compact life context with AI</Text>
                <Text style={styles.switchHint}>
                  Sends steps, distance, screen time, app categories, confidence, and permission state.
                </Text>
              </View>
              <Switch
                value={lifeContextEnabled && shareLifeContextWithBackend}
                onValueChange={setShareLifeContextWithBackend}
                disabled={!lifeContextEnabled}
                testID="life-context-share-backend-toggle"
                accessibilityLabel="life-context-share-backend-toggle"
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
                thumbColor="#fff7ef"
              />
            </View>

            <View style={styles.switchCard}>
              <View style={styles.switchTextBlock}>
                <Text style={styles.inputLabel}>Share app names with AI</Text>
                <Text style={styles.switchHint}>
                  Off by default. When off, only high-level app categories are shared.
                </Text>
              </View>
              <Switch
                value={lifeContextEnabled && shareAppNamesWithAi}
                onValueChange={setShareAppNamesWithAi}
                disabled={!lifeContextEnabled}
                testID="life-context-share-app-names-toggle"
                accessibilityLabel="life-context-share-app-names-toggle"
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
                thumbColor="#fff7ef"
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
                    Alert.alert("Needs model", "Needs model");
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
                <Text style={styles.secondaryBtnText}>Train wake phrase</Text>
              </Pressable>
            </View>

            <View style={styles.switchCard}>
              <Text style={styles.inputLabel}>Cloud fallback</Text>
              <Switch
                value={allowCloudFallback}
                onValueChange={setAllowCloudFallback}
                trackColor={{ false: "rgba(255, 255, 255, 0.14)", true: "rgba(87,222,255,0.44)" }}
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
  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },
  leftGlow: {
    position: "absolute",
    top: 240,
    left: -80,
    width: 210,
    height: 210,
    borderRadius: 999,
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },
  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 270,
    height: 270,
    borderRadius: 999,
    backgroundColor: "rgba(87,222,255,0.10)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  iconBtnPlaceholder: { width: 42, height: 42 },
  topTitle: { color: Brand.ink, fontSize: 18, fontWeight: "900" },
  card: { borderRadius: 28, marginTop: 16 },
  sectionTitle: { color: Brand.ink, fontSize: 19, fontWeight: "900" },
  helperText: {
    marginTop: 8,
    color: Brand.cocoa,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  inputLabel: { color: Brand.cocoa, fontSize: 13, fontWeight: "800", marginBottom: 8 },
  inputShell: {
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  switchTextBlock: { flex: 1, minWidth: 0 },
  switchHint: {
    color: "rgba(67, 50, 38, 0.68)",
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  lifeSummaryBox: {
    marginTop: 16,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
    gap: 6,
  },
  lifeSummaryText: { color: Brand.ink, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  lifeButtonRow: { marginTop: 14, gap: 10 },
  lifeButton: { justifyContent: "flex-start" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  optionCard: {
    flex: 1,
    minWidth: 140,
    borderRadius: 22,
    padding: 14,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  optionCardActive: {
    backgroundColor: "rgba(87, 222, 255, 0.10)",
    borderColor: "rgba(87,222,255,0.18)",
  },
  optionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(87, 222, 255, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(87,222,255,0.16)",
  },
  statusChipText: { color: Brand.ink, fontSize: 12, fontWeight: "900" },
  secondaryBtn: {
    minHeight: 44,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    shadowColor: "#57deff",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  primaryBtnText: { color: Brand.ink, fontSize: 15, fontWeight: "900" },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.94, transform: [{ scale: 0.995 }] },
});
