import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Audio } from "expo-av";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";
import { apiGet, apiPost, apiPostForm } from "@/lib/api";

type SampleKind = "positive" | "negative";
type WakeState = "ready_now" | "needs_training" | "training" | "active";

type EnrollmentStatus = {
  ok?: boolean;
  user_id?: number;
  wake_phrase?: string;
  phrase_key?: string;
  positive_count?: number;
  negative_count?: number;
  minimum_positive?: number;
  minimum_negative?: number;
  supported_base_model?: string | null;
  wake_state?: WakeState;
  wake_state_label?: string;
  can_run_instantly?: boolean;
  state_message?: string;
  message?: string;
  manifest?: {
    activation_mode?: string;
    wake_state?: WakeState;
    message?: string;
  } | null;
};

const EXAMPLES = [
  "Hey Elli, remind me to call mom at 7.",
  "Elli, help me plan tomorrow.",
  "Can you schedule a meeting for Friday?",
];

const NEGATIVE_SCRIPT_LINES = [
  "Tomorrow I need to buy groceries and pay the electricity bill.",
  "Please remind me to call my brother after lunch tomorrow.",
  "The weather looks hot today, so I will carry a water bottle.",
];

const STATE_ORDER: WakeState[] = ["ready_now", "needs_training", "training", "active"];
const STATE_LABELS: Record<WakeState, string> = {
  ready_now: "Ready now",
  needs_training: "Needs training",
  training: "Training",
  active: "Active",
};
const STATE_ICONS: Record<WakeState, keyof typeof Ionicons.glyphMap> = {
  ready_now: "flash-outline",
  needs_training: "construct-outline",
  training: "sync-outline",
  active: "checkmark-circle-outline",
};

function normalizeWakePhrase(value: string, fallbackName: string) {
  const trimmed = String(value || "").trim();
  return trimmed || `Hey ${fallbackName}`;
}

function resolveWakeState(status: EnrollmentStatus | null): WakeState {
  const state = status?.wake_state;
  if (state === "ready_now" || state === "needs_training" || state === "training" || state === "active") {
    return state;
  }
  return status?.supported_base_model ? "ready_now" : "needs_training";
}

function progressLabel(count: number, target: number) {
  return `${Math.min(count, target)}/${target}`;
}

function describeWakeState(state: WakeState, wakePhrase: string, supportedBaseModel?: string | null) {
  if (state === "ready_now") {
    return `${wakePhrase} maps to the supported base model ${supportedBaseModel}. It can work immediately, and setup recordings will personalize it for this user.`;
  }
  if (state === "needs_training") {
    return `${wakePhrase} is accepted, but it still needs a custom training job before it can wake the app.`;
  }
  if (state === "training") {
    return `${wakePhrase} is in Training. The setup recordings were saved, and the phrase stays pending until a custom model is activated.`;
  }
  return `${wakePhrase} is Active and is the live wake phrase for this account.`;
}

function actionHint(state: WakeState) {
  if (state === "ready_now") {
    return "Continue now, or record setup audio and make it Active for this user’s voice.";
  }
  if (state === "needs_training") {
    return "Record setup audio, then move the phrase into Training. It will not wake the app until a custom model is activated later.";
  }
  if (state === "training") {
    return "Training is pending. Keep the phrase saved, then activate it after the custom model is built.";
  }
  return "This phrase is fully active and ready to use.";
}

function finalizeButtonLabel(state: WakeState, supportedBaseModel?: string | null) {
  if (state === "active") return "Already active";
  if (state === "training") return "Training queued";
  if (supportedBaseModel) return "Make active";
  return "Move to training";
}

export default function Setup() {
  const { updateName, updateSettings, name, userId } = useAssistant();
  const insets = useSafeAreaInsets();

  const [input, setInput] = useState(name || "");
  const [wakePhrase, setWakePhrase] = useState(`Hey ${name || "Elli"}`);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<SampleKind | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [recordingKind, setRecordingKind] = useState<SampleKind | null>(null);
  const [message, setMessage] = useState(
    "Type any wake phrase. Supported phrases are Ready now. Arbitrary phrases are accepted but need training."
  );
  const [error, setError] = useState("");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const selectedName = input.trim() || name || "Elli";
  const normalizedWakePhrase = useMemo(
    () => normalizeWakePhrase(wakePhrase, selectedName),
    [selectedName, wakePhrase]
  );

  const wakeState = resolveWakeState(status);
  const wakeStateLabel = status?.wake_state_label || STATE_LABELS[wakeState];
  const positiveCount = Number(status?.positive_count || 0);
  const negativeCount = Number(status?.negative_count || 0);
  const minimumPositive = Number(status?.minimum_positive || 3);
  const minimumNegative = Number(status?.minimum_negative || 2);
  const statusMessage =
    message || status?.state_message || describeWakeState(wakeState, normalizedWakePhrase, status?.supported_base_model);

  const canFinalize =
    userId != null &&
    positiveCount >= minimumPositive &&
    negativeCount >= minimumNegative &&
    !recordingKind &&
    !uploadingKind &&
    !finalizing &&
    wakeState !== "active" &&
    wakeState !== "training";

  useEffect(() => {
    setInput(name || "");
    setWakePhrase(`Hey ${name || "Elli"}`);
  }, [name]);

  useEffect(() => {
    return () => {
      void stopActiveRecording(true);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    void refreshEnrollmentStatus();
  }, [userId, normalizedWakePhrase]);

  async function refreshEnrollmentStatus() {
    if (!userId) return;
    try {
      const next = await apiGet<EnrollmentStatus>(
        `/api/openwakeword/enrollment/status?user_id=${userId}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`
      );
      setStatus(next);
      setMessage(next.state_message || describeWakeState(resolveWakeState(next), normalizedWakePhrase, next.supported_base_model));
    } catch (nextError) {
      console.warn("[setup] Failed to refresh wake phrase status:", nextError);
    }
  }

  async function resetEnrollment() {
    if (!userId) {
      Alert.alert("Sign in first", "Create the user profile before recording wake phrase samples.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await stopActiveRecording(true);
      const payload = await apiPost<EnrollmentStatus>(
        `/api/openwakeword/enrollment/reset?user_id=${userId}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`
      );
      setStatus(payload);
      setMessage(payload.message || payload.state_message || "Wake phrase setup reset.");
    } catch (nextError: unknown) {
      const nextMessage = nextError instanceof Error ? nextError.message : "Could not reset wake phrase setup.";
      setError(nextMessage);
      Alert.alert("Reset failed", nextMessage);
    } finally {
      setBusy(false);
    }
  }

  async function ensureRecordingPermissions() {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Microphone permission is required to record wake phrase samples.");
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
  }

  async function startRecording(kind: SampleKind) {
    if (!userId) {
      Alert.alert("Profile required", "Sign in and create the user profile before recording.");
      return;
    }

    if (recordingKind || uploadingKind || finalizing) return;

    try {
      setError("");
      setMessage(
        kind === "positive"
          ? `Recording positive sample. Say “${normalizedWakePhrase}”, then tap stop.`
          : "Recording negative sample. Read any normal sentence that does not contain the wake phrase, then tap stop."
      );
      await ensureRecordingPermissions();
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setRecordingKind(kind);
    } catch (nextError: unknown) {
      const nextMessage = nextError instanceof Error ? nextError.message : "Could not start recording.";
      setError(nextMessage);
      Alert.alert("Recording failed", nextMessage);
    }
  }

  async function stopActiveRecording(silent = false) {
    const active = recordingRef.current;
    if (!active) return null;

    recordingRef.current = null;

    try {
      await active.stopAndUnloadAsync();
    } catch (nextError) {
      if (!silent) {
        console.warn("[setup] stopAndUnloadAsync failed:", nextError);
      }
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
    } catch {
      // ignore cleanup errors
    }

    return active.getURI() || null;
  }

  async function stopAndUploadRecording() {
    const currentKind = recordingKind;
    if (!currentKind) return;

    setRecordingKind(null);

    try {
      const uri = await stopActiveRecording();
      if (!uri) {
        throw new Error("Recorded sample did not produce a file.");
      }

      setUploadingKind(currentKind);
      const form = new FormData();
      form.append("file", {
        uri,
        name: `${currentKind}-${Date.now()}.m4a`,
        type: "audio/m4a",
      } as any);

      const payload = await apiPostForm<EnrollmentStatus>(
        `/api/openwakeword/enrollment/sample?user_id=${userId}&sample_kind=${currentKind}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`,
        form
      );
      setStatus(payload);
      setMessage(
        currentKind === "positive"
          ? `Saved positive sample ${progressLabel(Number(payload?.positive_count || 0), minimumPositive)}.`
          : `Saved negative sample ${progressLabel(Number(payload?.negative_count || 0), minimumNegative)}.`
      );
    } catch (nextError: unknown) {
      const nextMessage = nextError instanceof Error ? nextError.message : "Could not upload the sample.";
      setError(nextMessage);
      Alert.alert("Sample upload failed", nextMessage);
    } finally {
      setUploadingKind(null);
    }
  }

  async function finalizeEnrollment() {
    if (!canFinalize || !userId) return;

    setFinalizing(true);
    setError("");
    try {
      const payload = await apiPost<EnrollmentStatus>(
        `/api/openwakeword/enrollment/finalize?user_id=${userId}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`
      );

      setStatus(payload);
      await updateSettings({
        wakePhrase: normalizedWakePhrase,
        wakeTrainingSamples: [normalizedWakePhrase],
      });
      setMessage(
        payload.message ||
          payload.state_message ||
          describeWakeState(resolveWakeState(payload), normalizedWakePhrase, payload.supported_base_model)
      );
    } catch (nextError: unknown) {
      const nextMessage = nextError instanceof Error ? nextError.message : "Could not finalize wake phrase setup.";
      setError(nextMessage);
      Alert.alert("Finalize failed", nextMessage);
    } finally {
      setFinalizing(false);
    }
  }

  async function onContinue() {
    const trimmed = input.trim();
    await updateName(trimmed.length ? trimmed : "Elli");
    await updateSettings({ wakePhrase: normalizedWakePhrase });
    router.replace("/");
  }

  async function onSkip() {
    await updateName("Elli");
    await updateSettings({ wakePhrase: "Hey Elli" });
    router.replace("/");
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            paddingTop: insets.top + 16,
            paddingBottom: Math.max(insets.bottom + 24, 24),
            paddingHorizontal: 18,
            gap: 16,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerRow}>
            <View style={styles.tag}>
              <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
              <Text style={styles.tagText}>Wake phrase setup</Text>
            </View>
            <Pressable onPress={onSkip} style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}>
              <Text style={styles.skipButtonText}>Skip</Text>
            </Pressable>
          </View>

          <GlassCard>
            <View style={styles.heroRow}>
              <Text style={styles.title}>Any text is accepted now.</Text>
              <View style={styles.stateChip}>
                <Ionicons name={STATE_ICONS[wakeState]} size={14} color={Brand.bronze} />
                <Text style={styles.stateChipText}>{wakeStateLabel}</Text>
              </View>
            </View>
            <Text style={styles.subtitle}>
              Supported base phrases become Ready now. Arbitrary phrases move through Needs training → Training → Active.
            </Text>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>{selectedName}</Text>
              <Text style={styles.summaryPhrase}>“{normalizedWakePhrase}”</Text>
              <Text style={styles.summaryBody}>{status?.state_message || describeWakeState(wakeState, normalizedWakePhrase, status?.supported_base_model)}</Text>
            </View>
          </GlassCard>

          <GlassCard>
            <Text style={styles.sectionTitle}>Assistant identity</Text>
            <Text style={styles.label}>Assistant name</Text>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={`Default: ${name || "Elli"}`}
              placeholderTextColor="rgba(124, 99, 80, 0.52)"
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <Text style={styles.label}>Wake phrase</Text>
            <TextInput
              value={wakePhrase}
              onChangeText={setWakePhrase}
              placeholder={`Example: Hey ${selectedName}`}
              placeholderTextColor="rgba(124, 99, 80, 0.52)"
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <View style={styles.stateRail}>
              {STATE_ORDER.map((item) => {
                const active = item === wakeState;
                return (
                  <View key={item} style={[styles.railPill, active && styles.railPillActive]}>
                    <Ionicons name={STATE_ICONS[item]} size={14} color={active ? Brand.ink : Brand.cocoa} />
                    <Text style={[styles.railPillText, active && styles.railPillTextActive]}>{STATE_LABELS[item]}</Text>
                  </View>
                );
              })}
            </View>

            <View style={styles.hintBox}>
              <Ionicons name={STATE_ICONS[wakeState]} size={16} color={Brand.cocoa} />
              <Text style={styles.hintText}>{actionHint(wakeState)}</Text>
            </View>
          </GlassCard>

          <GlassCard>
            <Text style={styles.sectionTitle}>Voice setup</Text>
            <Text style={styles.sectionBody}>Record 3 positive clips and 2 negative clips for this typed wake phrase.</Text>

            <View style={styles.metricsRow}>
              <MetricCard label="Positive" value={progressLabel(positiveCount, minimumPositive)} icon="checkmark-circle-outline" />
              <MetricCard label="Negative" value={progressLabel(negativeCount, minimumNegative)} icon="remove-circle-outline" />
            </View>

            <View style={styles.statusBox}>
              <Text style={styles.statusTitle}>Current status</Text>
              <Text style={styles.statusText}>{statusMessage}</Text>
              <Text style={styles.statusMeta}>State: {wakeStateLabel}</Text>
              {!!status?.supported_base_model && (
                <Text style={styles.statusMeta}>Base model match: {status.supported_base_model}</Text>
              )}
              {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <View style={styles.buttonRow}>
              <ActionButton
                icon={recordingKind === "positive" ? "stop-circle-outline" : "mic-outline"}
                label={recordingKind === "positive" ? "Stop positive" : "Positive sample"}
                onPress={recordingKind === "positive" ? stopAndUploadRecording : () => startRecording("positive")}
                disabled={busy || !!uploadingKind || finalizing || recordingKind === "negative"}
              />
              <ActionButton
                icon={recordingKind === "negative" ? "stop-circle-outline" : "mic-off-outline"}
                label={recordingKind === "negative" ? "Stop negative" : "Negative sample"}
                onPress={recordingKind === "negative" ? stopAndUploadRecording : () => startRecording("negative")}
                disabled={busy || !!uploadingKind || finalizing || recordingKind === "positive"}
              />
            </View>

            {!!uploadingKind && (
              <View style={styles.uploadRow}>
                <ActivityIndicator color={Brand.cocoa} />
                <Text style={styles.uploadText}>Uploading {uploadingKind} sample…</Text>
              </View>
            )}

            <View style={styles.scriptBox}>
              <Text style={styles.scriptTitle}>Suggested negative sentences</Text>
              {NEGATIVE_SCRIPT_LINES.map((line) => (
                <Text key={line} style={styles.scriptLine}>{line}</Text>
              ))}
            </View>

            <View style={styles.buttonRow}>
              <ActionButton
                icon="refresh-outline"
                label="Reset phrase"
                onPress={resetEnrollment}
                disabled={busy || finalizing}
                variant="secondary"
              />
              <ActionButton
                icon={STATE_ICONS[wakeState]}
                label={finalizeButtonLabel(wakeState, status?.supported_base_model)}
                onPress={finalizeEnrollment}
                disabled={!canFinalize}
                loading={finalizing}
              />
            </View>
          </GlassCard>

          <GlassCard>
            <Text style={styles.sectionTitle}>Examples</Text>
            {EXAMPLES.map((example) => (
              <Text key={example} style={styles.exampleText}>{example.replace(/Elli/g, selectedName)}</Text>
            ))}
          </GlassCard>

          <GlassCard>
            <Pressable onPress={onContinue} style={({ pressed }) => [styles.primaryButtonWrap, pressed && styles.pressed]}>
              <LinearGradient colors={Brand.gradients.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
              </LinearGradient>
            </Pressable>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.metricCard}>
      <Ionicons name={icon} size={18} color={Brand.cocoa} />
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled,
  loading,
  variant = "primary",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.actionButton,
        variant === "secondary" && styles.actionButtonSecondary,
        (disabled || loading) && styles.actionButtonDisabled,
        pressed && !disabled && !loading && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "secondary" ? Brand.cocoa : Brand.ink} />
      ) : (
        <>
          <Ionicons name={icon} size={18} color={variant === "secondary" ? Brand.cocoa : Brand.ink} />
          <Text style={[styles.actionButtonText, variant === "secondary" && styles.actionButtonTextSecondary]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  tagText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  skipButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  skipButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  heroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "800",
    color: Brand.ink,
  },
  subtitle: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    color: Brand.muted,
  },
  stateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(244,214,174,0.46)",
  },
  stateChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  summaryCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.75)",
  },
  summaryTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: Brand.ink,
  },
  summaryPhrase: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  summaryBody: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: Brand.muted,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: Brand.ink,
  },
  sectionBody: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    color: Brand.muted,
  },
  label: {
    marginTop: 16,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  input: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.78)",
    fontSize: 15,
    color: Brand.ink,
  },
  stateRail: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },
  railPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.7)",
  },
  railPillActive: {
    backgroundColor: "rgba(244,214,174,0.7)",
  },
  railPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  railPillTextActive: {
    color: Brand.ink,
  },
  hintBox: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  hintText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    color: Brand.muted,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  metricCard: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 10,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.74)",
  },
  metricValue: {
    marginTop: 10,
    fontSize: 22,
    fontWeight: "800",
    color: Brand.ink,
  },
  metricLabel: {
    marginTop: 6,
    fontSize: 13,
    color: Brand.muted,
  },
  statusBox: {
    marginTop: 16,
    padding: 16,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  statusTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  statusText: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    color: Brand.ink,
  },
  statusMeta: {
    marginTop: 8,
    fontSize: 13,
    color: Brand.muted,
  },
  errorText: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: "#9f2f1f",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  actionButton: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: Brand.bronze,
  },
  actionButtonSecondary: {
    backgroundColor: "rgba(255,255,255,0.78)",
  },
  actionButtonDisabled: {
    opacity: 0.55,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: Brand.ink,
  },
  actionButtonTextSecondary: {
    color: Brand.cocoa,
  },
  uploadRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  uploadText: {
    fontSize: 13,
    color: Brand.muted,
  },
  scriptBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  scriptTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  scriptLine: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 20,
    color: Brand.muted,
  },
  exampleText: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: Brand.muted,
  },
  primaryButtonWrap: {
    borderRadius: 20,
    overflow: "hidden",
  },
  primaryButton: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 20,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "800",
    color: Brand.ink,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.995 }],
  },
});
