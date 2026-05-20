import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import * as FileSystem from "expo-file-system/legacy";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";

type SampleKind = "positive" | "negative";
type WakeState = "ready_now" | "needs_training" | "training" | "active";

type EnrollmentStatus = {
  ok?: boolean;
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
  manifest_path?: string;
  storage_mode?: "local_device_only";
  sample_files?: {
    positive: string[];
    negative: string[];
  };
  trained_at?: string | null;
  active_at?: string | null;
};

type LocalEnrollmentManifest = {
  version: number;
  wake_phrase: string;
  phrase_key: string;
  positive_count: number;
  negative_count: number;
  minimum_positive: number;
  minimum_negative: number;
  supported_base_model: string | null;
  wake_state: WakeState;
  sample_files: {
    positive: string[];
    negative: string[];
  };
  trained_at?: string | null;
  active_at?: string | null;
  updated_at: string;
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

const MINIMUM_POSITIVE = 3;
const MINIMUM_NEGATIVE = 2;
const MANIFEST_VERSION = 1;
const LOCAL_ENROLLMENT_ROOT = `${FileSystem.documentDirectory || ""}wake_phrase_enrollment`;

const SUPPORTED_BASE_MODELS: Record<string, string> = {
  alexa: "alexa",
  "hey alexa": "alexa",
  mycroft: "hey_mycroft",
  "hey mycroft": "hey_mycroft",
  jarvis: "hey_jarvis",
  "hey jarvis": "hey_jarvis",
  rhasspy: "hey_rhasspy",
  "hey rhasspy": "hey_rhasspy",
  weather: "weather",
  "what's the weather": "weather",
  "whats the weather": "weather",
  timer: "timer",
  "set a 10 minute timer": "timer",
  "set ten minute timer": "timer",
};

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

function normalizePhraseLookup(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9஀-௿\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function supportedBaseModelFor(wakePhrase: string) {
  const normalized = normalizePhraseLookup(wakePhrase);
  return SUPPORTED_BASE_MODELS[normalized] || null;
}

function phraseKeyFor(wakePhrase: string) {
  const normalized = normalizePhraseLookup(wakePhrase);
  const slug = normalized.replace(/[^a-z0-9஀-௿]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "wake-phrase";
}

function progressLabel(count: number, target: number) {
  return `${Math.min(count, target)}/${target}`;
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function describeWakeState(
  state: WakeState,
  wakePhrase: string,
  supportedBaseModel?: string | null,
  positiveCount = 0,
  negativeCount = 0
) {
  if (state === "ready_now") {
    return supportedBaseModel
      ? `${wakePhrase} matches the built-in phrase template ${supportedBaseModel}. The phrase is saved for foreground speech recognition, and any extra recordings stay on this phone.`
      : `${wakePhrase} is accepted. You can record ${MINIMUM_POSITIVE} positive and ${MINIMUM_NEGATIVE} negative clips as local phrase variants on this phone.`;
  }
  if (state === "needs_training") {
    return `${wakePhrase} has ${positiveCount}/${MINIMUM_POSITIVE} positive and ${negativeCount}/${MINIMUM_NEGATIVE} negative local clips saved as phrase samples.`;
  }
  if (state === "training") {
    return `${wakePhrase} samples are being packaged locally on this phone. No audio is sent to the backend.`;
  }
  return `${wakePhrase} is saved. The phrase samples and enrollment audio stay on this device only.`;
}

function actionHint(state: WakeState) {
  if (state === "ready_now") {
    return "The phrase is accepted. You can continue now or record local samples as recognition variants.";
  }
  if (state === "needs_training") {
    return "Keep recording on the phone if you want saved phrase variants. Nothing is uploaded.";
  }
  if (state === "training") {
    return "The phone is packaging the saved wake phrase samples now.";
  }
  return "This wake phrase is saved on the phone and the samples stay local.";
}

function finalizeButtonLabel(state: WakeState) {
  if (state === "active") return "Already active";
  if (state === "training") return "Building locally";
  return "Build local profile";
}

function resolveWakeState(status: EnrollmentStatus | null): WakeState {
  const state = status?.wake_state;
  if (state === "ready_now" || state === "needs_training" || state === "training" || state === "active") {
    return state;
  }

  if (
    Number(status?.positive_count || 0) >= MINIMUM_POSITIVE &&
    Number(status?.negative_count || 0) >= MINIMUM_NEGATIVE
  ) {
    return "ready_now";
  }

  return status?.supported_base_model ? "ready_now" : "needs_training";
}

function buildDefaultStatus(wakePhrase: string): EnrollmentStatus {
  const supportedBaseModel = supportedBaseModelFor(wakePhrase);
  const wakeState: WakeState = supportedBaseModel ? "ready_now" : "needs_training";

  return {
    ok: true,
    wake_phrase: wakePhrase,
    phrase_key: phraseKeyFor(wakePhrase),
    positive_count: 0,
    negative_count: 0,
    minimum_positive: MINIMUM_POSITIVE,
    minimum_negative: MINIMUM_NEGATIVE,
    supported_base_model: supportedBaseModel,
    wake_state: wakeState,
    wake_state_label: STATE_LABELS[wakeState],
    can_run_instantly: Boolean(supportedBaseModel),
    state_message: describeWakeState(wakeState, wakePhrase, supportedBaseModel, 0, 0),
    storage_mode: "local_device_only",
    sample_files: {
      positive: [],
      negative: [],
    },
    trained_at: null,
    active_at: null,
  };
}

function buildPaths(wakePhrase: string) {
  const phraseKey = phraseKeyFor(wakePhrase);
  const rootDir = `${LOCAL_ENROLLMENT_ROOT}/${phraseKey}`;
  return {
    phraseKey,
    rootDir,
    positiveDir: `${rootDir}/positive`,
    negativeDir: `${rootDir}/negative`,
    manifestPath: `${rootDir}/manifest.json`,
  };
}

async function ensureDir(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function ensureEnrollmentDirs(wakePhrase: string) {
  if (!FileSystem.documentDirectory) {
    throw new Error("Device storage is unavailable in this build.");
  }

  const paths = buildPaths(wakePhrase);
  await ensureDir(LOCAL_ENROLLMENT_ROOT);
  await ensureDir(paths.rootDir);
  await ensureDir(paths.positiveDir);
  await ensureDir(paths.negativeDir);
  return paths;
}

function normalizeManifest(
  wakePhrase: string,
  value: Partial<LocalEnrollmentManifest> | null | undefined
): LocalEnrollmentManifest {
  const supportedBaseModel = supportedBaseModelFor(wakePhrase);
  const positiveFiles = Array.isArray(value?.sample_files?.positive)
    ? uniqueStrings(value?.sample_files?.positive || [])
    : [];
  const negativeFiles = Array.isArray(value?.sample_files?.negative)
    ? uniqueStrings(value?.sample_files?.negative || [])
    : [];

  const explicitState = value?.wake_state;
  const wakeState: WakeState =
    explicitState === "active" || explicitState === "training"
      ? explicitState
      : positiveFiles.length >= MINIMUM_POSITIVE && negativeFiles.length >= MINIMUM_NEGATIVE
        ? "ready_now"
        : supportedBaseModel
          ? "ready_now"
          : "needs_training";

  return {
    version: MANIFEST_VERSION,
    wake_phrase: wakePhrase,
    phrase_key: phraseKeyFor(wakePhrase),
    positive_count: positiveFiles.length,
    negative_count: negativeFiles.length,
    minimum_positive: MINIMUM_POSITIVE,
    minimum_negative: MINIMUM_NEGATIVE,
    supported_base_model: supportedBaseModel,
    wake_state: wakeState,
    sample_files: {
      positive: positiveFiles,
      negative: negativeFiles,
    },
    trained_at: value?.trained_at || null,
    active_at: value?.active_at || null,
    updated_at: new Date().toISOString(),
  };
}

function manifestToStatus(manifest: LocalEnrollmentManifest): EnrollmentStatus {
  const state = manifest.wake_state;
  const message = describeWakeState(
    state,
    manifest.wake_phrase,
    manifest.supported_base_model,
    manifest.positive_count,
    manifest.negative_count
  );

  return {
    ok: true,
    wake_phrase: manifest.wake_phrase,
    phrase_key: manifest.phrase_key,
    positive_count: manifest.positive_count,
    negative_count: manifest.negative_count,
    minimum_positive: manifest.minimum_positive,
    minimum_negative: manifest.minimum_negative,
    supported_base_model: manifest.supported_base_model,
    wake_state: state,
    wake_state_label: STATE_LABELS[state],
    can_run_instantly: state === "active" || Boolean(manifest.supported_base_model),
    state_message: message,
    message,
    manifest_path: buildPaths(manifest.wake_phrase).manifestPath,
    storage_mode: "local_device_only",
    sample_files: manifest.sample_files,
    trained_at: manifest.trained_at || null,
    active_at: manifest.active_at || null,
  };
}

async function readManifest(wakePhrase: string) {
  const { manifestPath } = buildPaths(wakePhrase);
  const info = await FileSystem.getInfoAsync(manifestPath);
  if (!info.exists) return null;

  try {
    const raw = await FileSystem.readAsStringAsync(manifestPath);
    const parsed = JSON.parse(raw) as Partial<LocalEnrollmentManifest>;
    return normalizeManifest(wakePhrase, parsed);
  } catch {
    return null;
  }
}

async function writeManifest(manifest: LocalEnrollmentManifest) {
  const paths = await ensureEnrollmentDirs(manifest.wake_phrase);
  await FileSystem.writeAsStringAsync(paths.manifestPath, JSON.stringify(manifest, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

async function loadEnrollmentStatus(wakePhrase: string) {
  const manifest = await readManifest(wakePhrase);
  if (manifest) {
    return manifestToStatus(manifest);
  }

  const fallback = buildDefaultStatus(wakePhrase);
  return {
    ...fallback,
    manifest_path: buildPaths(wakePhrase).manifestPath,
  };
}

export default function Setup() {
  const { updateName, updateSettings, name } = useAssistant();
  const insets = useSafeAreaInsets();

  const [input, setInput] = useState(name || "");
  const [wakePhrase, setWakePhrase] = useState(`Hey ${name || "Elli"}`);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<SampleKind | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [recordingKind, setRecordingKind] = useState<SampleKind | null>(null);
  const [message, setMessage] = useState(
    "Custom wake phrase samples stay on-device. Record optional variants here, then save the phrase for foreground hands-free recognition."
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
  const minimumPositive = Number(status?.minimum_positive || MINIMUM_POSITIVE);
  const minimumNegative = Number(status?.minimum_negative || MINIMUM_NEGATIVE);
  const statusMessage =
    message ||
    status?.state_message ||
    describeWakeState(
      wakeState,
      normalizedWakePhrase,
      status?.supported_base_model,
      positiveCount,
      negativeCount
    );

  const canFinalize =
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

  const refreshEnrollmentStatus = useCallback(async () => {
    try {
      const next = await loadEnrollmentStatus(normalizedWakePhrase);
      setStatus(next);
      setMessage(
        next.state_message ||
          describeWakeState(
            resolveWakeState(next),
            normalizedWakePhrase,
            next.supported_base_model,
            Number(next.positive_count || 0),
            Number(next.negative_count || 0)
          )
      );
    } catch (nextError) {
      console.warn("[setup] Failed to refresh local wake phrase status:", nextError);
    }
  }, [normalizedWakePhrase]);

  useEffect(() => {
    void refreshEnrollmentStatus();
  }, [refreshEnrollmentStatus]);

  async function resetEnrollment() {
    setBusy(true);
    setError("");
    try {
      await stopActiveRecording(true);
      const paths = buildPaths(normalizedWakePhrase);
      await FileSystem.deleteAsync(paths.rootDir, { idempotent: true });
      const next = await loadEnrollmentStatus(normalizedWakePhrase);
      setStatus(next);
      setMessage("Local wake phrase samples were removed from this phone.");
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not reset wake phrase setup.";
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
    if (recordingKind || uploadingKind || finalizing) return;

    try {
      setError("");
      setMessage(
        kind === "positive"
          ? `Recording positive sample on this phone. Say “${normalizedWakePhrase}”, then tap stop.`
          : "Recording negative sample on this phone. Read any normal sentence that does not contain the wake phrase, then tap stop."
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

      const paths = await ensureEnrollmentDirs(normalizedWakePhrase);
      const existing =
        (await readManifest(normalizedWakePhrase)) || normalizeManifest(normalizedWakePhrase, null);
      const extension = uri.toLowerCase().endsWith(".wav") ? "wav" : "m4a";
      const targetDir = currentKind === "positive" ? paths.positiveDir : paths.negativeDir;
      const targetUri = `${targetDir}/${currentKind}-${Date.now()}.${extension}`;

      await FileSystem.copyAsync({ from: uri, to: targetUri });
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);

      const nextSamples = {
        positive:
          currentKind === "positive"
            ? uniqueStrings([...existing.sample_files.positive, targetUri]).slice(-12)
            : existing.sample_files.positive,
        negative:
          currentKind === "negative"
            ? uniqueStrings([...existing.sample_files.negative, targetUri]).slice(-12)
            : existing.sample_files.negative,
      };

      const nextManifest = normalizeManifest(normalizedWakePhrase, {
        ...existing,
        sample_files: nextSamples,
      });

      await writeManifest(nextManifest);

      const payload = manifestToStatus(nextManifest);
      setStatus(payload);
      setMessage(
        currentKind === "positive"
          ? `Saved positive sample ${progressLabel(nextManifest.positive_count, minimumPositive)} on this device.`
          : `Saved negative sample ${progressLabel(nextManifest.negative_count, minimumNegative)} on this device.`
      );
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not save the local sample.";
      setError(nextMessage);
      Alert.alert("Sample save failed", nextMessage);
    } finally {
      setUploadingKind(null);
    }
  }

  async function finalizeEnrollment() {
    if (!canFinalize) return;

    setFinalizing(true);
    setError("");
    try {
      const existing =
        (await readManifest(normalizedWakePhrase)) || normalizeManifest(normalizedWakePhrase, null);

      const trainingManifest = normalizeManifest(normalizedWakePhrase, {
        ...existing,
        wake_state: "training",
      });
      setStatus(manifestToStatus(trainingManifest));
      setMessage(`Packaging the wake phrase samples for “${normalizedWakePhrase}” locally on this phone…`);

      const finishedAt = new Date().toISOString();
      const activeManifest = normalizeManifest(normalizedWakePhrase, {
        ...trainingManifest,
        wake_state: "active",
        trained_at: finishedAt,
        active_at: finishedAt,
      });

      await writeManifest(activeManifest);
      const payload = manifestToStatus(activeManifest);
      setStatus(payload);
      await updateSettings({
        wakePhrase: normalizedWakePhrase,
        wakeTrainingSamples: uniqueStrings([normalizedWakePhrase]),
      });
      setMessage(
        `Wake phrase samples saved. “${normalizedWakePhrase}” is ready for foreground hands-free recognition, and enrollment data stays on this phone.`
      );
    } catch (nextError: unknown) {
      const nextMessage =
        nextError instanceof Error ? nextError.message : "Could not finalize wake phrase setup.";
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
    router.replace("/(chat)" as any);
  }

  async function onSkip() {
    await updateName("Elli");
    await updateSettings({ wakePhrase: "Hey Elli" });
    router.replace("/(chat)" as any);
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
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
            <Pressable
              onPress={onSkip}
              style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
            >
              <Text style={styles.skipButtonText}>Skip</Text>
            </Pressable>
          </View>

          <GlassCard>
            <View style={styles.heroRow}>
              <Text style={styles.title}>Wake phrase samples stay on-device.</Text>
              <View style={styles.stateChip}>
                <Ionicons name={STATE_ICONS[wakeState]} size={14} color={Brand.bronze} />
                <Text style={styles.stateChipText}>{wakeStateLabel}</Text>
              </View>
            </View>
            <Text style={styles.subtitle}>
              Custom phrase recordings are stored in the phone sandbox as recognition variants.
              Runtime hands-free uses the saved phrase while the app is open.
            </Text>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>{selectedName}</Text>
              <Text style={styles.summaryPhrase}>“{normalizedWakePhrase}”</Text>
              <Text style={styles.summaryBody}>
                {status?.state_message ||
                  describeWakeState(
                    wakeState,
                    normalizedWakePhrase,
                    status?.supported_base_model,
                    positiveCount,
                    negativeCount
                  )}
              </Text>
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
                    <Ionicons
                      name={STATE_ICONS[item]}
                      size={14}
                      color={active ? Brand.ink : Brand.cocoa}
                    />
                    <Text style={[styles.railPillText, active && styles.railPillTextActive]}>
                      {STATE_LABELS[item]}
                    </Text>
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
            <Text style={styles.sectionBody}>
              Record {MINIMUM_POSITIVE} positive clips and {MINIMUM_NEGATIVE} negative clips. The
              audio files are saved locally on this device as wake phrase variants.
            </Text>

            <View style={styles.metricsRow}>
              <MetricCard
                label="Positive"
                value={progressLabel(positiveCount, minimumPositive)}
                icon="checkmark-circle-outline"
              />
              <MetricCard
                label="Negative"
                value={progressLabel(negativeCount, minimumNegative)}
                icon="remove-circle-outline"
              />
            </View>

            <View style={styles.statusBox}>
              <Text style={styles.statusTitle}>Current status</Text>
              <Text style={styles.statusText}>{statusMessage}</Text>
              <Text style={styles.statusMeta}>State: {wakeStateLabel}</Text>
              <Text style={styles.statusMeta}>Storage: on-device only</Text>
              {!!status?.manifest_path && (
                <Text style={styles.statusMeta}>Manifest: {status.manifest_path}</Text>
              )}
              {!!status?.supported_base_model && (
                <Text style={styles.statusMeta}>
                  Base phrase match: {status.supported_base_model}
                </Text>
              )}
              {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <View style={styles.buttonRow}>
              <ActionButton
                icon={recordingKind === "positive" ? "stop-circle-outline" : "mic-outline"}
                label={recordingKind === "positive" ? "Stop positive" : "Positive sample"}
                onPress={
                  recordingKind === "positive"
                    ? stopAndUploadRecording
                    : () => startRecording("positive")
                }
                disabled={busy || !!uploadingKind || finalizing || recordingKind === "negative"}
              />
              <ActionButton
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
              <View style={styles.uploadRow}>
                <ActivityIndicator color={Brand.cocoa} />
                <Text style={styles.uploadText}>Saving {uploadingKind} sample to the device…</Text>
              </View>
            )}

            <View style={styles.scriptBox}>
              <Text style={styles.scriptTitle}>Suggested negative sentences</Text>
              {NEGATIVE_SCRIPT_LINES.map((line) => (
                <Text key={line} style={styles.scriptLine}>
                  {line}
                </Text>
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
                label={finalizeButtonLabel(wakeState)}
                onPress={finalizeEnrollment}
                disabled={!canFinalize}
                loading={finalizing}
              />
            </View>
          </GlassCard>

          <GlassCard>
            <Text style={styles.sectionTitle}>Examples</Text>
            {EXAMPLES.map((example) => (
              <Text key={example} style={styles.exampleText}>
                {example.replace(/Elli/g, selectedName)}
              </Text>
            ))}
          </GlassCard>

          <GlassCard>
            <Pressable
              onPress={onContinue}
              style={({ pressed }) => [styles.primaryButtonWrap, pressed && styles.pressed]}
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
          <Ionicons
            name={icon}
            size={18}
            color={variant === "secondary" ? Brand.cocoa : Brand.ink}
          />
          <Text
            style={[
              styles.actionButtonText,
              variant === "secondary" && styles.actionButtonTextSecondary,
            ]}
          >
            {label}
          </Text>
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
