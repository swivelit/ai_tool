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
  useWindowDimensions,
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

type EnrollmentStatus = {
  ok?: boolean;
  user_id?: number;
  wake_phrase?: string;
  positive_count?: number;
  negative_count?: number;
  minimum_positive?: number;
  minimum_negative?: number;
  supported_base_model?: string | null;
  custom_phrase_requires_colab?: boolean;
  verifier_ready?: boolean;
  manifest?: {
    mode?: string;
    message?: string;
  } | null;
};

type FinalizeResponse = {
  ok?: boolean;
  wake_phrase?: string;
  mode?: string;
  supported_base_model?: string | null;
  custom_phrase_requires_colab?: boolean;
  verifier_path?: string | null;
  message?: string;
};

const EXAMPLES = [
  "Hey Elli, remind me to call mom at 7.",
  "Elli, help me plan tomorrow.",
  "Can you schedule a meeting for Friday?",
];

function normalizeWakePhrase(value: string, fallbackName: string) {
  const trimmed = String(value || "").trim();
  return trimmed || `Hey ${fallbackName}`;
}

function progressLabel(count: number, target: number) {
  return `${Math.min(count, target)}/${target}`;
}

export default function Setup() {
  const { updateName, updateSettings, name, userId } = useAssistant();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [input, setInput] = useState(name || "");
  const [wakePhrase, setWakePhrase] = useState(`Hey ${name || "Elli"}`);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<SampleKind | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState(
    "Record three wake phrase samples, then two negative speech samples."
  );
  const [error, setError] = useState("");
  const [recordingKind, setRecordingKind] = useState<SampleKind | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 14);
  const bottomPadding = Math.max(insets.bottom + 24, 24);
  const heroTitleSize = isVerySmallPhone ? 28 : isSmallPhone ? 31 : 36;
  const heroTitleLineHeight = isVerySmallPhone ? 34 : isSmallPhone ? 37 : 42;
  const selectedName = input.trim() || name || "Elli";
  const normalizedWakePhrase = useMemo(
    () => normalizeWakePhrase(wakePhrase, selectedName),
    [selectedName, wakePhrase]
  );

  const positiveCount = Number(status?.positive_count || 0);
  const negativeCount = Number(status?.negative_count || 0);
  const minimumPositive = Number(status?.minimum_positive || 3);
  const minimumNegative = Number(status?.minimum_negative || 2);
  const canFinalize =
    userId != null &&
    positiveCount >= minimumPositive &&
    negativeCount >= minimumNegative &&
    !recordingKind &&
    !uploadingKind &&
    !finalizing;

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

  const nameQuality = useMemo(() => {
    const value = input.trim();
    if (!value) return "Using default";
    if (value.length < 3) return "Easy";
    if (value.length < 8) return "Balanced";
    return "Distinctive";
  }, [input]);

  async function refreshEnrollmentStatus() {
    if (!userId) return;
    try {
      const next = await apiGet<EnrollmentStatus>(
        `/api/openwakeword/enrollment/status?user_id=${userId}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`
      );
      setStatus(next);
    } catch (nextError) {
      console.warn("[setup] Failed to refresh openWakeWord enrollment status:", nextError);
    }
  }

  async function resetEnrollment() {
    if (!userId) {
      Alert.alert("Sign in first", "Create the user profile before recording wake-word samples.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await stopActiveRecording(true);
      const payload = await apiPost<{ ok?: boolean }>(
        `/api/openwakeword/enrollment/reset?user_id=${userId}`
      );
      if (!payload?.ok) {
        throw new Error("The backend did not confirm the enrollment reset.");
      }
      setStatus({
        ok: true,
        user_id: userId,
        wake_phrase: normalizedWakePhrase,
        positive_count: 0,
        negative_count: 0,
        minimum_positive: 3,
        minimum_negative: 2,
      });
      setMessage("Enrollment reset. Record the new wake phrase samples now.");
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not reset enrollment.";
      setError(nextMessage);
      Alert.alert("Reset failed", nextMessage);
    } finally {
      setBusy(false);
    }
  }

  async function ensureRecordingPermissions() {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Microphone permission is required to record wake-word samples.");
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
          : "Recording negative sample. Say any normal sentence that does not contain the wake phrase, then tap stop."
      );
      await ensureRecordingPermissions();
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setRecordingKind(kind);
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not start recording.";
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
          ? `Saved positive sample ${progressLabel(
              Number(payload?.positive_count || 0),
              Number(payload?.minimum_positive || 3)
            )}.`
          : `Saved negative sample ${progressLabel(
              Number(payload?.negative_count || 0),
              Number(payload?.minimum_negative || 2)
            )}.`
      );
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not upload the sample.";
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
      const payload = await apiPost<FinalizeResponse>(
        `/api/openwakeword/enrollment/finalize?user_id=${userId}&wake_phrase=${encodeURIComponent(
          normalizedWakePhrase
        )}`
      );

      await updateSettings({
        wakePhrase: normalizedWakePhrase,
        wakeTrainingSamples: [normalizedWakePhrase],
      });
      await refreshEnrollmentStatus();

      if (payload?.custom_phrase_requires_colab) {
        setMessage(
          "Samples saved. openWakeWord cannot build a brand-new custom phrase from only these few onboarding clips, so the backend stored a training bundle for the notebook/Colab path."
        );
      } else {
        setMessage(
          payload?.message ||
            `Enrollment finished for ${normalizedWakePhrase}.`
        );
      }
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not finalize enrollment.";
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

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
            paddingHorizontal: horizontalPadding,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: "100%", maxWidth: 560, alignSelf: "center" }}>
            <View style={styles.topBar}>
              <View style={styles.topBarPill}>
                <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
                <Text style={styles.topBarPillText}>Almost ready</Text>
              </View>

              <Pressable
                onPress={onSkip}
                style={({ pressed }) => [styles.topSkipBtn, pressed && styles.pressed]}
              >
                <Text style={styles.topSkipBtnText}>Skip</Text>
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.heroPill}>
                  <Ionicons name="chatbubble-ellipses-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroPillText}>Assistant identity</Text>
                </View>

                <View style={styles.heroStatusChip}>
                  <Ionicons name="flash-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroStatusText}>Optional step</Text>
                </View>
              </View>

              <Text
                style={[
                  styles.title,
                  {
                    fontSize: heroTitleSize,
                    lineHeight: heroTitleLineHeight,
                  },
                ]}
              >
                Give your assistant a name and a wake phrase.
              </Text>

              <Text style={styles.subtitle}>
                This setup records a few onboarding clips for openWakeWord enrollment.
              </Text>

              <View style={styles.metricRow}>
                <MetricCard label="Current name" value={selectedName} icon="sparkles-outline" />
                <MetricCard label="Style" value={nameQuality} icon="color-wand-outline" />
                <MetricCard label="Wake phrase" value={normalizedWakePhrase} icon="mic-outline" />
              </View>

              <LinearGradient
                colors={["rgba(255,255,255,0.88)", "rgba(255,239,210,0.72)"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.previewCard}
              >
                <View style={styles.previewBadge}>
                  <Ionicons name="radio-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.previewBadgeText}>Enrollment preview</Text>
                </View>

                <Text style={styles.previewTitle}>{selectedName}</Text>
                <Text style={styles.previewText}>“{normalizedWakePhrase}”</Text>
              </LinearGradient>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <Text style={styles.sectionTitle}>Choose assistant name</Text>
              <Text style={styles.sectionSubtitle}>Keep it simple for voice and chat.</Text>

              <Text style={styles.label}>Assistant name</Text>
              <View style={styles.inputShell}>
                <View style={styles.inputIconWrap}>
                  <Ionicons name="sparkles-outline" size={16} color={Brand.bronze} />
                </View>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder={`Default: ${name || "Elli"}`}
                  placeholderTextColor="rgba(124, 99, 80, 0.52)"
                  style={styles.input}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>

              <Text style={styles.label}>Wake phrase</Text>
              <View style={styles.inputShell}>
                <View style={styles.inputIconWrap}>
                  <Ionicons name="radio-outline" size={16} color={Brand.bronze} />
                </View>
                <TextInput
                  value={wakePhrase}
                  onChangeText={setWakePhrase}
                  placeholder={`Example: Hey ${selectedName}`}
                  placeholderTextColor="rgba(124, 99, 80, 0.52)"
                  style={styles.input}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>

              <View style={styles.examplePanel}>
                <View style={styles.examplePanelHeader}>
                  <Ionicons
                    name="chatbubble-ellipses-outline"
                    size={16}
                    color={Brand.bronze}
                  />
                  <Text style={styles.examplePanelTitle}>Usage examples</Text>
                </View>

                <View style={styles.exampleList}>
                  {EXAMPLES.map((example, index) => (
                    <Text key={index} style={styles.exampleText}>
                      {example.replace(/Elli/g, selectedName)}
                    </Text>
                  ))}
                </View>
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.voiceHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>openWakeWord voice setup</Text>
                  <Text style={styles.sectionSubtitle}>
                    Record 3 positive clips and 2 negative clips during initialization.
                  </Text>
                </View>
                {(busy || finalizing) && <ActivityIndicator color={Brand.cocoa} />}
              </View>

              <View style={styles.progressGrid}>
                <ProgressCard
                  label="Positive clips"
                  value={progressLabel(positiveCount, minimumPositive)}
                  icon="checkmark-circle-outline"
                />
                <ProgressCard
                  label="Negative clips"
                  value={progressLabel(negativeCount, minimumNegative)}
                  icon="remove-circle-outline"
                />
              </View>

              <View style={styles.statusPanel}>
                <Text style={styles.statusTitle}>Current status</Text>
                <Text style={styles.statusBody}>{message}</Text>
                {!!status?.supported_base_model && (
                  <Text style={styles.statusMeta}>
                    Supported base model: {status.supported_base_model}
                  </Text>
                )}
                {status?.custom_phrase_requires_colab ? (
                  <Text style={styles.warningText}>
                    This phrase is not one of openWakeWord’s built-in base models, so the backend will save an enrollment bundle but still needs the notebook/Colab training path for a real custom phrase model.
                  </Text>
                ) : null}
                {!!error && <Text style={styles.errorText}>{error}</Text>}
              </View>

              <View style={styles.recordButtonRow}>
                <RecordButton
                  icon={recordingKind === "positive" ? "stop-circle-outline" : "mic-outline"}
                  label={recordingKind === "positive" ? "Stop positive" : "Positive sample"}
                  onPress={
                    recordingKind === "positive"
                      ? stopAndUploadRecording
                      : () => startRecording("positive")
                  }
                  disabled={busy || !!uploadingKind || finalizing || recordingKind === "negative"}
                />
                <RecordButton
                  icon={recordingKind === "negative" ? "stop-circle-outline" : "mic-off-outline"}
                  label={recordingKind === "negative" ? "Stop negative" : "Negative sample"}
                  onPress={
                    recordingKind === "negative"
                      ? stopAndUploadRecording
                      : () => startRecording("negative")
                  }
                  disabled={busy || !!uploadingKind || finalizing || recordingKind === "positive"}
                />
              </View>

              {!!uploadingKind && (
                <View style={styles.uploadingRow}>
                  <ActivityIndicator color={Brand.cocoa} />
                  <Text style={styles.uploadingText}>Uploading {uploadingKind} sample…</Text>
                </View>
              )}

              <View style={styles.secondaryActionsRow}>
                <Pressable
                  onPress={resetEnrollment}
                  style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                >
                  <Ionicons name="refresh-outline" size={18} color={Brand.cocoa} />
                  <Text style={styles.secondaryActionText}>Reset enrollment</Text>
                </Pressable>

                <Pressable
                  onPress={finalizeEnrollment}
                  disabled={!canFinalize}
                  style={({ pressed }) => [
                    styles.finalizeButton,
                    !canFinalize && styles.finalizeButtonDisabled,
                    pressed && canFinalize && styles.pressed,
                  ]}
                >
                  {finalizing ? (
                    <ActivityIndicator color={Brand.ink} />
                  ) : (
                    <>
                      <Ionicons name="sparkles-outline" size={18} color={Brand.ink} />
                      <Text style={styles.finalizeButtonText}>Finalize voice setup</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <Pressable
                onPress={onContinue}
                style={({ pressed }) => [styles.buttonShell, pressed && styles.pressed]}
              >
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                </LinearGradient>
              </Pressable>

              <Pressable
                onPress={onSkip}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Ionicons name="play-skip-forward-outline" size={18} color={Brand.cocoa} />
                <Text style={styles.secondaryButtonText}>Skip and use Elli</Text>
              </Pressable>
            </GlassCard>
          </View>
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
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function ProgressCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.progressCard}>
      <Ionicons name={icon} size={18} color={Brand.cocoa} />
      <Text style={styles.progressValue}>{value}</Text>
      <Text style={styles.progressLabel}>{label}</Text>
    </View>
  );
}

function RecordButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.recordButton,
        disabled && styles.recordButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={18} color={disabled ? "rgba(124, 99, 80, 0.4)" : Brand.cocoa} />
      <Text style={[styles.recordButtonText, disabled && styles.recordButtonTextDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  topGlow: {
    position: "absolute",
    top: -80,
    right: -30,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(205, 144, 77, 0.14)",
  },
  leftGlow: {
    position: "absolute",
    left: -70,
    top: 160,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(139, 92, 47, 0.1)",
  },
  bottomGlow: {
    position: "absolute",
    bottom: -80,
    left: 40,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "rgba(244, 214, 174, 0.26)",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topBarPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.16)",
  },
  topBarPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  topSkipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.58)",
  },
  topSkipBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: Brand.cocoa,
  },
  heroHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 18,
  },
  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.7)",
  },
  heroPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  heroStatusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(244,214,174,0.46)",
  },
  heroStatusText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  title: {
    fontWeight: "800",
    color: Brand.ink,
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 23,
    color: Brand.muted,
  },
  metricRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 22,
  },
  metricCard: {
    flex: 1,
    padding: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.12)",
  },
  metricIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244,214,174,0.44)",
    marginBottom: 10,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: "700",
    color: Brand.ink,
  },
  metricLabel: {
    marginTop: 4,
    fontSize: 12,
    color: Brand.muted,
  },
  previewCard: {
    marginTop: 20,
    borderRadius: 24,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.1)",
  },
  previewBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  previewBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  previewTitle: {
    marginTop: 16,
    fontSize: 22,
    fontWeight: "800",
    color: Brand.ink,
  },
  previewText: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: Brand.muted,
  },
  sectionTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: Brand.ink,
  },
  sectionSubtitle: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 21,
    color: Brand.muted,
  },
  label: {
    marginTop: 18,
    marginBottom: 10,
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  inputShell: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.76)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.12)",
    paddingHorizontal: 14,
  },
  inputIconWrap: {
    width: 32,
    alignItems: "center",
  },
  input: {
    flex: 1,
    minHeight: 52,
    fontSize: 15,
    color: Brand.ink,
    paddingVertical: 14,
  },
  examplePanel: {
    marginTop: 18,
    borderRadius: 20,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.1)",
  },
  examplePanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  examplePanelTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  exampleList: {
    marginTop: 12,
    gap: 10,
  },
  exampleText: {
    fontSize: 14,
    lineHeight: 21,
    color: Brand.muted,
  },
  voiceHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  progressGrid: {
    flexDirection: "row",
    gap: 12,
    marginTop: 18,
  },
  progressCard: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 16,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.12)",
  },
  progressValue: {
    marginTop: 10,
    fontSize: 22,
    fontWeight: "800",
    color: Brand.ink,
  },
  progressLabel: {
    marginTop: 6,
    fontSize: 13,
    color: Brand.muted,
  },
  statusPanel: {
    marginTop: 16,
    borderRadius: 20,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.66)",
  },
  statusTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  statusBody: {
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
  warningText: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: "#8a4b16",
  },
  errorText: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: "#9f2f1f",
  },
  recordButtonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  recordButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 18,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.14)",
  },
  recordButtonDisabled: {
    opacity: 0.55,
  },
  recordButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  recordButtonTextDisabled: {
    color: "rgba(124, 99, 80, 0.5)",
  },
  uploadingRow: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  uploadingText: {
    fontSize: 13,
    color: Brand.muted,
  },
  secondaryActionsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  secondaryAction: {
    flex: 1,
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.76)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,92,47,0.12)",
  },
  secondaryActionText: {
    fontSize: 14,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  finalizeButton: {
    flex: 1,
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 18,
    backgroundColor: Brand.bronze,
  },
  finalizeButtonDisabled: {
    opacity: 0.5,
  },
  finalizeButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: Brand.ink,
  },
  buttonShell: {
    borderRadius: 20,
    overflow: "hidden",
  },
  primaryButton: {
    minHeight: 58,
    borderRadius: 20,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "800",
    color: Brand.ink,
  },
  secondaryButton: {
    marginTop: 12,
    minHeight: 52,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.76)",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: Brand.cocoa,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.995 }],
  },
});
