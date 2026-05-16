import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";

type Tone = "pro" | "friendly";
type LanguageMode = "en" | "ta";
type TrainingPhase =
  | "idle"
  | "preparing"
  | "listening"
  | "hearing"
  | "processing"
  | "captured"
  | "error";

type AndroidTrainingDiagnostics = {
  checking: boolean;
  defaultService: string;
  availableServices: string[];
  supportsOnDevice: boolean;
  installedLocales: string[];
  canUseOnDeviceForLocale: boolean;
};

function uniqueSamples(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    )
  );
}

function normalizeRecognitionTranscript(value: string) {
  return String(value || "")
    .replace(/[.!?。،]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trainerTitle(phase: TrainingPhase) {
  switch (phase) {
    case "preparing":
      return "Preparing microphone";
    case "listening":
      return "Listening now";
    case "hearing":
      return "We can hear you";
    case "processing":
      return "Checking captured audio";
    case "captured":
      return "Wake phrase captured";
    case "error":
      return "Try again";
    default:
      return "Ready when you are";
  }
}

function trainerIcon(phase: TrainingPhase): keyof typeof Ionicons.glyphMap {
  switch (phase) {
    case "preparing":
      return "hourglass-outline";
    case "listening":
      return "mic-outline";
    case "hearing":
      return "pulse-outline";
    case "processing":
      return "sync-outline";
    case "captured":
      return "checkmark-circle-outline";
    case "error":
      return "alert-circle-outline";
    default:
      return "radio-outline";
  }
}

function normalizeLocaleCandidates(locale: string) {
  const source = String(locale || "").trim().toLowerCase();
  const parts = source.split(/[-_]/).filter(Boolean);
  const language = parts[0] || source;

  return Array.from(new Set([source, source.replace("-", "_"), language].filter(Boolean)));
}

function localeMatchesInstalled(locale: string, installedLocales: string[]) {
  const wanted = normalizeLocaleCandidates(locale);
  const installed = (installedLocales || []).map((item) =>
    String(item || "").trim().toLowerCase()
  );

  return wanted.some((candidate) =>
    installed.some(
      (installedLocale) =>
        installedLocale === candidate ||
        installedLocale.startsWith(`${candidate}-`) ||
        installedLocale.startsWith(`${candidate}_`)
    )
  );
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
  const [wakeTrainingSamples, setWakeTrainingSamples] = useState<string[]>(
    settings.wakeTrainingSamples || []
  );
  const [saving, setSaving] = useState(false);

  const [trainerVisible, setTrainerVisible] = useState(false);
  const [training, setTraining] = useState(false);
  const [trainingPhase, setTrainingPhase] = useState<TrainingPhase>("idle");
  const [trainingStatus, setTrainingStatus] = useState("");
  const [trainingTranscript, setTrainingTranscript] = useState("");
  const [trainingError, setTrainingError] = useState("");
  const [trainingLevel, setTrainingLevel] = useState(0);
  const [trainingAudioCaptured, setTrainingAudioCaptured] = useState(false);
  const [trainingAudioUri, setTrainingAudioUri] = useState("");
  const [trainingDiagnostics, setTrainingDiagnostics] =
    useState<AndroidTrainingDiagnostics>({
      checking: false,
      defaultService: "",
      availableServices: [],
      supportsOnDevice: false,
      installedLocales: [],
      canUseOnDeviceForLocale: false,
    });

  const trainerVisibleRef = useRef(false);
  const trainingRef = useRef(false);
  const trainingPhaseRef = useRef<TrainingPhase>("idle");
  const trainingBestTranscriptRef = useRef("");
  const trainingPendingRecordedAudioFallbackRef = useRef(false);
  const trainingCheckingRecordedAudioRef = useRef(false);
  const trainingAudioCapturedRef = useRef(false);
  const trainingAudioUriRef = useRef("");
  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
    setAllowCloudFallback(settings.allowCloudFallback);
    setHandsFreeEnabled(settings.handsFreeEnabled);
    setWakePhrase(settings.wakePhrase || `Hey ${name || "Elli"}`);
    setWakeTrainingSamples(settings.wakeTrainingSamples || []);
  }, [name, settings]);

  useEffect(() => {
    trainerVisibleRef.current = trainerVisible;
  }, [trainerVisible]);

  useEffect(() => {
    trainingRef.current = training;
  }, [training]);

  useEffect(() => {
    trainingPhaseRef.current = trainingPhase;
  }, [trainingPhase]);

  useEffect(() => {
    return () => {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // ignore cleanup errors
      }
    };
  }, []);

  const assistantLabel = useMemo(() => (name || "Elli").trim() || "Elli", [name]);
  const displayName = useMemo(
    () => assistantNameInput.trim() || assistantLabel,
    [assistantLabel, assistantNameInput]
  );
  const speechLocale = languageMode === "ta" ? "ta-IN" : "en-IN";
  const wakePrompt = useMemo(
    () => wakePhrase.trim() || `Hey ${displayName}`,
    [displayName, wakePhrase]
  );

  const isDirty =
    assistantNameInput.trim() !== assistantLabel ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode ||
    allowCloudFallback !== settings.allowCloudFallback ||
    handsFreeEnabled !== settings.handsFreeEnabled ||
    wakePrompt !== (settings.wakePhrase || `Hey ${name || "Elli"}`).trim() ||
    JSON.stringify(uniqueSamples(wakeTrainingSamples)) !==
      JSON.stringify(uniqueSamples(settings.wakeTrainingSamples || []));

  function acceptWakePhraseSample(
    transcript: string,
    source: "final" | "partial" | "recorded-audio"
  ) {
    const normalized = normalizeRecognitionTranscript(transcript);
    if (!normalized) return;
  
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingBestTranscriptRef.current = normalized;
    setTrainingTranscript(normalized);
    setWakePhrase(normalized);
    setWakeTrainingSamples((prev) => uniqueSamples([normalized, wakePrompt, ...prev]));
    setTraining(false);
    trainingRef.current = false;
    setTrainingPhase("captured");
    setTrainingError("");
    setTrainingLevel(0);
    setTrainingStatus(
      source === "recorded-audio"
        ? `Android recorded the mic audio, but no transcript came back. Keeping “${normalized}” from the wake phrase field so setup stays on-device. Tap Save on the customise screen to keep it.`
        : source === "partial"
          ? `Captured “${normalized}” from the best live result. Tap Save on the customise screen to keep it.`
          : `Captured “${normalized}”. It has been filled into the wake phrase field below. Tap Save on the customise screen to keep it.`
    );
  }

  const refreshTrainingDiagnostics = useCallback(async () => {
    if (Platform.OS !== "android") return;

    setTrainingDiagnostics((prev) => ({ ...prev, checking: true }));

    let defaultService = "";
    let availableServices: string[] = [];
    let supportsOnDevice = false;
    let installedLocales: string[] = [];

    try {
      defaultService = String(
        ExpoSpeechRecognitionModule.getDefaultRecognitionService?.()?.packageName || ""
      ).trim();
    } catch {
      defaultService = "";
    }

    try {
      const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices?.();
      availableServices = Array.isArray(services)
        ? services.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    } catch {
      availableServices = [];
    }

    try {
      supportsOnDevice = Boolean(
        ExpoSpeechRecognitionModule.supportsOnDeviceRecognition?.()
      );
    } catch {
      supportsOnDevice = false;
    }

    if (supportsOnDevice) {
      try {
        const payload: any = await ExpoSpeechRecognitionModule.getSupportedLocales?.({
          androidRecognitionServicePackage: "com.google.android.as",
        });
        installedLocales = Array.isArray(payload?.installedLocales)
          ? payload.installedLocales
              .map((item: any) => String(item || "").trim())
              .filter(Boolean)
          : [];
      } catch {
        installedLocales = [];
      }
    }

    setTrainingDiagnostics({
      checking: false,
      defaultService,
      availableServices,
      supportsOnDevice,
      installedLocales,
      canUseOnDeviceForLocale: localeMatchesInstalled(speechLocale, installedLocales),
    });
  }, [speechLocale]);

  useEffect(() => {
    if (trainerVisible) {
      setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
      void refreshTrainingDiagnostics();
    }
  }, [refreshTrainingDiagnostics, trainerVisible, wakePrompt]);

  async function downloadOnDeviceSpeechModel() {
    if (Platform.OS !== "android") return;

    try {
      setTrainingStatus(`Opening the Android speech model download for ${speechLocale}…`);
      const result: any = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload?.({
        locale: speechLocale,
      });

      const status = String(result?.status || "").trim();
      if (status === "opened_dialog") {
        setTrainingStatus(
          `Android opened the offline speech model dialog for ${speechLocale}. Finish that download, then come back here and try again.`
        );
      } else if (status === "download_success") {
        setTrainingStatus(
          `The on-device speech model for ${speechLocale} was downloaded. Try training again now.`
        );
      } else if (status === "download_canceled") {
        setTrainingStatus(
          `The offline speech model download was canceled. Training will keep using the default recognizer.`
        );
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not open the offline speech model download.";
      setTrainingError(message);
      setTrainingStatus(message);
    } finally {
      await refreshTrainingDiagnostics();
    }
  }

  async function transcribeRecordedWakePhrase(uri: string) {
    if (trainingCheckingRecordedAudioRef.current) return;
  
    const sourceUri = String(uri || "").trim();
    const fallbackPhrase = normalizeRecognitionTranscript(wakePrompt);
  
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = true;
    setTraining(false);
    trainingRef.current = false;
    setTrainingPhase("processing");
    setTrainingLevel(0);
    setTrainingError("");
    setTrainingStatus(
      "Android captured microphone audio but returned no text. Using the typed wake phrase instead so setup stays on-device."
    );
  
    try {
      if (!fallbackPhrase) {
        throw new Error("Type the wake phrase first, then try training again.");
      }
  
      acceptWakePhraseSample(fallbackPhrase, "recorded-audio");
  
      setTrainingStatus(
        sourceUri
          ? `Android saved the mic audio, but speech-to-text returned nothing. Keeping “${fallbackPhrase}” as the wake phrase and continuing fully on-device.`
          : `Android captured audio, but speech-to-text returned nothing. Keeping “${fallbackPhrase}” as the wake phrase and continuing fully on-device.`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not recover the wake phrase from the recorded-audio fallback.";
  
      setTrainingPhase("error");
      setTrainingError(message);
      setTrainingStatus(message);
    } finally {
      trainingCheckingRecordedAudioRef.current = false;
    }
  }

  useSpeechRecognitionEvent("start", () => {
    if (!trainerVisibleRef.current || !trainingRef.current) return;
    setTrainingPhase("listening");
    setTrainingError("");
    setTrainingLevel(0.08);
    setTrainingStatus(`Listening now. Say “${wakePrompt}”.`);
  });

  useSpeechRecognitionEvent("speechstart", () => {
    if (!trainerVisibleRef.current || !trainingRef.current) return;
    setTrainingPhase("hearing");
    setTrainingStatus("Sound detected. Finish saying the full wake phrase.");
  });

  useSpeechRecognitionEvent("volumechange", (event: { value?: number } | undefined) => {
    if (!trainerVisibleRef.current || !trainingRef.current) return;
    const raw = Number(event?.value ?? -2);
    const normalized = Math.max(0, Math.min(1, (raw + 2) / 12));
    setTrainingLevel(normalized);

    if (raw > 0 && trainingPhaseRef.current === "listening") {
      setTrainingPhase("hearing");
      setTrainingStatus("We can hear you. Finish saying the wake phrase.");
    }
  });

  useSpeechRecognitionEvent("audiostart", () => {
    if (!trainerVisibleRef.current || !trainingRef.current) return;

    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioCapturedRef.current = false;
    trainingAudioUriRef.current = "";
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingStatus(`Microphone is live. Say “${wakePrompt}” now.`);
  });

  useSpeechRecognitionEvent("audioend", (event: { uri: string | null }) => {
    if (!trainerVisibleRef.current) return;

    const uri = String(event?.uri || "").trim();
    if (!uri) return;

    trainingAudioUriRef.current = uri;
    trainingAudioCapturedRef.current = true;
    setTrainingAudioUri(uri);
    setTrainingAudioCaptured(true);

    if (trainingPendingRecordedAudioFallbackRef.current) {
      void transcribeRecordedWakePhrase(uri);
      return;
    }

    if (trainingPhaseRef.current !== "captured") {
      setTrainingPhase("processing");
      setTrainingStatus(
        "Microphone audio was captured. Waiting for Android speech recognition to return text…"
      );
    }
  });

  useSpeechRecognitionEvent(
    "result",
    (event: { results?: { transcript?: string }[]; isFinal?: boolean } | undefined) => {
      if (!trainerVisibleRef.current || !trainingRef.current) return;

      const transcript = normalizeRecognitionTranscript(
        String(event?.results?.[0]?.transcript || "")
      );
      if (!transcript) return;

      trainingBestTranscriptRef.current = transcript;
      setTrainingTranscript(transcript);

      if (event?.isFinal) {
        acceptWakePhraseSample(transcript, "final");
      }
    }
  );

  useSpeechRecognitionEvent(
    "error",
    (event: { error?: string; message?: string } | undefined) => {
      if (!trainerVisibleRef.current) return;

      if (event?.error === "aborted") {
        trainingPendingRecordedAudioFallbackRef.current = false;
        trainingCheckingRecordedAudioRef.current = false;
        setTraining(false);
        trainingRef.current = false;
        setTrainingLevel(0);

        if (trainingPhaseRef.current !== "captured" && trainingPhaseRef.current !== "error") {
          setTrainingPhase("idle");
          setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
        }
        return;
      }

      const isRecoverableTimeout =
        event?.error === "no-speech" || event?.error === "speech-timeout";

      if (isRecoverableTimeout && trainingBestTranscriptRef.current.trim()) {
        acceptWakePhraseSample(trainingBestTranscriptRef.current, "partial");
        return;
      }

      const canAttemptRecordedAudioFallback =
        Platform.OS === "android" &&
        Number(Platform.Version) >= 33 &&
        typeof ExpoSpeechRecognitionModule.supportsRecording === "function" &&
        Boolean(ExpoSpeechRecognitionModule.supportsRecording());

      if (isRecoverableTimeout && canAttemptRecordedAudioFallback) {
        setTraining(false);
        trainingRef.current = false;
        setTrainingLevel(0);
        setTrainingPhase("processing");
        setTrainingError("");
        trainingPendingRecordedAudioFallbackRef.current = true;

        if (trainingAudioUriRef.current.trim()) {
          void transcribeRecordedWakePhrase(trainingAudioUriRef.current);
        } else {
          setTrainingStatus(
            "Android ended the listening session without text. Waiting for the recorded microphone file so it can be transcribed…"
          );
        }
        return;
      }

      trainingPendingRecordedAudioFallbackRef.current = false;
      trainingCheckingRecordedAudioRef.current = false;
      setTraining(false);
      trainingRef.current = false;
      setTrainingPhase("error");
      setTrainingLevel(0);
      setTrainingError(
        isRecoverableTimeout
          ? trainingAudioCapturedRef.current
            ? "The microphone captured audio, but Android’s speech recognizer returned no transcript."
            : "No speech was detected."
          : String(event?.message || "Could not capture the wake phrase sample.")
      );
      setTrainingStatus(
        isRecoverableTimeout
          ? trainingAudioCapturedRef.current
            ? `The mic is working, but the Android recognizer still returned no text for “${wakePrompt}”.`
            : `We didn’t catch a full phrase. Hold the phone closer and say “${wakePrompt}” right after tapping Start listening.`
          : String(event?.message || "Could not capture the wake phrase sample.")
      );
    }
  );

  useSpeechRecognitionEvent("end", () => {
    setTraining(false);
    trainingRef.current = false;
    setTrainingLevel(0);

    if (!trainerVisibleRef.current) return;
    if (trainingPhaseRef.current === "captured" || trainingPhaseRef.current === "error") return;
    if (
      trainingPendingRecordedAudioFallbackRef.current ||
      trainingCheckingRecordedAudioRef.current
    ) {
      return;
    }

    if (trainingBestTranscriptRef.current.trim()) {
      acceptWakePhraseSample(trainingBestTranscriptRef.current, "partial");
      return;
    }

    setTrainingPhase("idle");
    setTrainingStatus(`Listening session ended. Tap Start listening to try “${wakePrompt}” again.`);
  });

  function openTrainer() {
    trainerVisibleRef.current = true;
    trainingBestTranscriptRef.current = "";
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioUriRef.current = "";
    trainingAudioCapturedRef.current = false;
    setTrainingTranscript("");
    setTrainingError("");
    setTrainingLevel(0);
    setTraining(false);
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingPhase("idle");
    setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
    setTrainerVisible(true);
    void refreshTrainingDiagnostics();
  }

  function closeTrainer() {
    trainerVisibleRef.current = false;
    trainingRef.current = false;
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioUriRef.current = "";
    trainingAudioCapturedRef.current = false;

    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // ignore cleanup errors
    }

    trainingBestTranscriptRef.current = "";
    setTraining(false);
    setTrainerVisible(false);
    setTrainingPhase("idle");
    setTrainingError("");
    setTrainingLevel(0);
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
  }

  async function startTraining() {
    try {
      trainingBestTranscriptRef.current = "";
      trainingPendingRecordedAudioFallbackRef.current = false;
      trainingCheckingRecordedAudioRef.current = false;
      trainingAudioUriRef.current = "";
      trainingAudioCapturedRef.current = false;
      setTrainingTranscript("");
      setTrainingError("");
      setTrainingLevel(0);
      setTrainingAudioCaptured(false);
      setTrainingAudioUri("");
      setTrainingPhase("preparing");
      setTrainingStatus(`Getting the microphone ready for “${wakePrompt}”…`);
  
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setTraining(false);
        trainingRef.current = false;
        setTrainingPhase("error");
        setTrainingError("Microphone permission is required.");
        setTrainingStatus(
          "Please allow microphone and speech recognition access, then try again."
        );
        return;
      }
  
      const canPersistAudio =
        Platform.OS === "android" &&
        Number(Platform.Version) >= 33 &&
        typeof ExpoSpeechRecognitionModule.supportsRecording === "function" &&
        Boolean(ExpoSpeechRecognitionModule.supportsRecording());
  
      const shouldUseOnDevice =
        Platform.OS === "ios" ||
        (Platform.OS === "android" && trainingDiagnostics.canUseOnDeviceForLocale);
  
      setTraining(true);
      trainingRef.current = true;
  
      ExpoSpeechRecognitionModule.start({
        lang: speechLocale,
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: shouldUseOnDevice,
        androidRecognitionServicePackage:
          Platform.OS === "android" && shouldUseOnDevice
            ? "com.google.android.as"
            : undefined,
        addsPunctuation: false,
        contextualStrings: uniqueSamples([wakePrompt, displayName, ...wakeTrainingSamples]),
        iosTaskHint: "confirmation",
        volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
        recordingOptions: canPersistAudio
          ? {
              persist: true,
            }
          : undefined,
        androidIntentOptions:
          Platform.OS === "android"
            ? {
                EXTRA_LANGUAGE_MODEL: "free_form",
                EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4500,
                EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2500,
                EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1000,
              }
            : undefined,
      });
    } catch (error: unknown) {
      setTraining(false);
      trainingRef.current = false;
      setTrainingPhase("error");
      setTrainingLevel(0);
      const message =
        error instanceof Error ? error.message : "Could not start wake phrase training.";
      setTrainingError(message);
      setTrainingStatus(message);
    }
  }

  function stopTraining() {
    if (!trainingRef.current) return;
    setTrainingStatus("Finishing this listening session…");

    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // ignore nested stop failures
      }
    }
  }

  async function handleSave() {
    const trimmedName = assistantNameInput.trim();
    const cloudFallbackChanged = allowCloudFallback !== settings.allowCloudFallback;

    if (!trimmedName) {
      Alert.alert("Assistant name required", "Please enter an assistant name.");
      return;
    }

    try {
      setSaving(true);

      if (trimmedName !== assistantLabel) {
        await updateName(trimmedName);
      }

      if (
        tone !== settings.tone ||
        languageMode !== settings.languageMode ||
        cloudFallbackChanged ||
        handsFreeEnabled !== settings.handsFreeEnabled ||
        wakePrompt !== (settings.wakePhrase || `Hey ${name || "Elli"}`).trim() ||
        JSON.stringify(uniqueSamples(wakeTrainingSamples)) !==
          JSON.stringify(uniqueSamples(settings.wakeTrainingSamples || []))
      ) {
        await updateSettings({
          tone,
          languageMode,
          ...(cloudFallbackChanged
            ? { allowCloudFallback, cloudFallbackUserChoice: true }
            : {}),
          handsFreeEnabled,
          wakePhrase: wakePrompt,
          wakeTrainingSamples: uniqueSamples(wakeTrainingSamples),
        });
      }

      await refresh();
      Alert.alert("Preferences saved", "Your assistant preferences have been updated.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not save assistant preferences.";
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

      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
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
            <Text style={styles.topTitle}>{`Customise (${displayName})`}</Text>
            <View style={styles.iconBtnPlaceholder} />
          </View>

          <GlassCard style={styles.heroCard}>
            <View style={styles.badge}>
              <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
            </View>
            <Text style={styles.heroTitle}>{displayName}</Text>

            <View style={styles.statsRow}>
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
              <MetricCard
                icon="radio-outline"
                label="Hands-free"
                value={handsFreeEnabled ? "On" : "Off"}
              />
              <MetricCard
                icon="cloud-outline"
                label="Cloud fallback"
                value={allowCloudFallback ? "On" : "Off"}
              />
            </View>
          </GlassCard>

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
            <Text style={styles.sectionTitle}>Hands free</Text>

            <View style={styles.switchCard}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.inputLabel}>Hands free</Text>
              </View>
              <Switch
                value={handsFreeEnabled}
                onValueChange={setHandsFreeEnabled}
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
            />

            <Pressable onPress={openTrainer} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
              <Ionicons name="radio-outline" size={16} color={Brand.ink} />
              <Text style={styles.secondaryBtnText}>Open dedicated wake phrase trainer</Text>
            </Pressable>
            {trainingTranscript ? (
              <View style={styles.captureCard}>
                <Text style={styles.captureLabel}>Latest captured phrase</Text>
                <Text style={styles.captureValue}>{trainingTranscript}</Text>
              </View>
            ) : null}

            {wakeTrainingSamples.length ? (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.inputLabel}>Saved wake phrase samples</Text>
                <View style={styles.pills}>
                  {wakeTrainingSamples.map((sample) => (
                    <View key={sample} style={styles.pill}>
                      <Text style={styles.pillText}>{sample}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.switchCard}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.inputLabel}>Cloud fallback</Text>
                <Text style={styles.helperText}>
                  Use backend/cloud only when phone-local answer is not ready. Turn off for strict phone-only mode.
                </Text>
              </View>
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
              style={({ pressed }) => [styles.primaryShell, (saving || !isDirty) && styles.disabled, pressed && styles.pressed]}
            >
              <LinearGradient colors={Brand.gradients.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryBtn}>
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

      <Modal visible={trainerVisible} animationType="slide" onRequestClose={closeTrainer}>
        <LinearGradient colors={Brand.gradients.page} style={styles.page}>
          <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
            <View style={styles.topGlow} />
            <View style={styles.leftGlow} />
            <View style={styles.bottomGlow} />
          </View>

          <View style={[styles.topBar, { paddingTop: insets.top + 10, paddingHorizontal: 18 }]}>
            <Pressable style={styles.iconBtn} onPress={closeTrainer}>
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
            </Pressable>
            <Text style={styles.topTitle}>Wake phrase trainer</Text>
            <View style={styles.iconBtnPlaceholder} />
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: Math.max(insets.bottom + 28, 28), paddingTop: 12 }} showsVerticalScrollIndicator={false}>
            <GlassCard style={styles.heroCard}>
              <Text style={styles.trainerEyebrow}>Dedicated training screen</Text>
              <Text style={styles.heroTitle}>{`Train “${wakePrompt}”`}</Text>
              <Text style={styles.heroSubtitle}>
                This screen stays open while the microphone listens, so you can see when the app is ready, hearing sound, or has captured your phrase.
              </Text>

              <View style={styles.trainerStatusCard}>
                <View style={styles.trainerStatusPill}>
                  <Ionicons name={trainerIcon(trainingPhase)} size={14} color={Brand.ink} />
                  <Text style={styles.trainerStatusPillText}>{trainerTitle(trainingPhase)}</Text>
                </View>

                <View style={styles.micOuter}>
                  <View style={styles.micInner}>
                    <Ionicons
                      name={trainingPhase === "captured" ? "checkmark" : trainingPhase === "error" ? "refresh-outline" : "mic"}
                      size={28}
                      color={Brand.ink}
                    />
                  </View>
                </View>

                <Text style={styles.trainerHeadline}>{trainerTitle(trainingPhase)}</Text>
                <Text style={styles.trainerStatusText}>{trainingStatus}</Text>

                <View style={styles.meterTrack}>
                  <View
                    style={[
                      styles.meterFill,
                      {
                        width: `${training ? Math.max(10, Math.round(trainingLevel * 100)) : trainingPhase === "captured" ? 100 : 10}%`,
                      },
                    ]}
                  />
                </View>

                <Text style={styles.meterCaption}>
                  {training
                    ? trainingLevel > 0.04
                      ? "Voice activity detected"
                      : "Waiting for your voice"
                    : trainingPhase === "processing"
                      ? "Checking the captured audio"
                      : trainingPhase === "captured"
                        ? "Phrase saved locally"
                        : "Not listening right now"}
                </Text>
              </View>

              <View style={styles.trainerActions}>
                <Pressable onPress={training ? stopTraining : startTraining} style={({ pressed }) => [styles.primaryShell, { flex: 1, marginTop: 0 }, pressed && styles.pressed]}>
                  <LinearGradient colors={Brand.gradients.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryBtn}>
                    {training ? (
                      <>
                        <Ionicons name="stop-circle-outline" size={18} color={Brand.ink} />
                        <Text style={styles.primaryBtnText}>Stop listening</Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="mic-outline" size={18} color={Brand.ink} />
                        <Text style={styles.primaryBtnText}>{trainingPhase === "error" ? "Try again" : "Start listening"}</Text>
                      </>
                    )}
                  </LinearGradient>
                </Pressable>

                <Pressable onPress={closeTrainer} style={({ pressed }) => [styles.secondaryBtn, { flex: 0.42, marginTop: 0 }, pressed && styles.pressed]}>
                  <Text style={styles.secondaryBtnText}>{trainingPhase === "captured" ? "Done" : "Close"}</Text>
                </Pressable>
              </View>
            </GlassCard>

            <GlassCard style={styles.card}>
              <Text style={styles.sectionTitle}>Live transcript</Text>
              <Text style={[styles.transcriptText, !trainingTranscript && styles.transcriptPlaceholder]}>
                {trainingTranscript || "Your captured phrase will appear here while training."}
              </Text>
              {trainingError ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={Brand.danger} />
                  <Text style={styles.errorBannerText}>{trainingError}</Text>
                </View>
              ) : null}
            </GlassCard>

            {Platform.OS === "android" ? (
              <GlassCard style={styles.card}>
                <Text style={styles.sectionTitle}>Android speech diagnostics</Text>
                <Text style={styles.noteText}>
                  Default recognizer:{" "}
                  <Text style={styles.strong}>
                    {trainingDiagnostics.defaultService || "Unknown"}
                  </Text>
                </Text>
                <Text style={styles.noteText}>
                  On-device model for {speechLocale}:{" "}
                  <Text style={styles.strong}>
                    {trainingDiagnostics.canUseOnDeviceForLocale
                      ? "Installed"
                      : trainingDiagnostics.supportsOnDevice
                        ? "Not installed"
                        : "Not supported"}
                  </Text>
                </Text>
                {trainingAudioCaptured ? (
                  <Text style={styles.noteText}>
                    Mic recording captured successfully for this attempt.
                  </Text>
                ) : null}
                {trainingDiagnostics.supportsOnDevice &&
                !trainingDiagnostics.canUseOnDeviceForLocale &&
                !training ? (
                  <Pressable
                    onPress={() => {
                      void downloadOnDeviceSpeechModel();
                    }}
                    style={({ pressed }) => [
                      styles.secondaryBtn,
                      { marginTop: 16 },
                      pressed && styles.pressed,
                    ]}
                  >
                    <Ionicons name="download-outline" size={16} color={Brand.ink} />
                    <Text style={styles.secondaryBtnText}>Install on-device speech model</Text>
                  </Pressable>
                ) : null}
                {trainingAudioUri ? (
                  <Text numberOfLines={1} style={styles.trainingAudioUriText}>
                    Last captured audio file: {trainingAudioUri}
                  </Text>
                ) : null}
              </GlassCard>
            ) : null}

            <GlassCard style={styles.card}>
              <Text style={styles.sectionTitle}>Best way to record it</Text>
              <Text style={styles.listItem}>1. Tap <Text style={styles.strong}>Start listening</Text>.</Text>
              <Text style={styles.listItem}>2. Say the full phrase once, for example <Text style={styles.strong}>“{wakePrompt}”</Text>.</Text>
              <Text style={styles.listItem}>3. Speak slightly slower and clearer for the first training pass.</Text>
              <Text style={styles.listItem}>4. On Android, if the mic is heard but text does not appear, install the on-device speech model and try again.</Text>
              <Text style={styles.listItem}>5. After closing this screen, tap <Text style={styles.strong}>Save</Text> on the customise page.</Text>
            </GlassCard>
          </ScrollView>
        </LinearGradient>
      </Modal>
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
      <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function OptionCard({
  icon,
  title,
  helper,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  helper?: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.optionCard, active && styles.optionCardActive, pressed && styles.pressed]}>
      <View style={styles.optionIconWrap}>
        <Ionicons name={icon} size={16} color={active ? Brand.ink : Brand.bronze} />
      </View>
      <Text style={[styles.optionTitle, active && styles.optionTitleActive]}>{title}</Text>
      {helper ? <Text style={styles.optionHelper}>{helper}</Text> : null}
    </Pressable>
  );
}

function LabeledInput({
  label,
  icon,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
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
  heroCard: { borderRadius: 32, marginTop: 14 },
  card: { borderRadius: 28, marginTop: 16 },
  badge: {
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
  badgeText: { color: Brand.cocoa, fontSize: 11, fontWeight: "900", letterSpacing: 0.3 },
  trainerEyebrow: { color: Brand.cocoa, fontSize: 12, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0.4 },
  heroTitle: { marginTop: 14, color: Brand.ink, fontSize: 28, fontWeight: "900" },
  heroSubtitle: { marginTop: 10, color: Brand.muted, fontSize: 14, lineHeight: 22 },
  statsRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 18 },
  metricCard: {
    flex: 1,
    minWidth: 96,
    borderRadius: 22,
    padding: 14,
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
  metricLabel: { marginTop: 12, color: Brand.muted, fontSize: 12, fontWeight: "700" },
  metricValue: { marginTop: 8, color: Brand.ink, fontSize: 17, fontWeight: "900" },
  sectionTitle: { color: Brand.ink, fontSize: 19, fontWeight: "900" },
  sectionSubtitle: { marginTop: 6, color: Brand.muted, fontSize: 13, lineHeight: 20 },
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
  helperText: { color: Brand.muted, fontSize: 12, lineHeight: 18 },
  switchCard: {
    marginTop: 16,
    minHeight: 72,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  optionCardActive: { backgroundColor: "rgba(255,229,180,0.78)", borderColor: "rgba(185,120,54,0.22)" },
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
  optionHelper: { marginTop: 5, color: Brand.muted, fontSize: 12, lineHeight: 18 },
  secondaryBtn: {
    minHeight: 48,
    marginTop: 14,
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
  noteText: { marginTop: 10, color: Brand.muted, fontSize: 12, lineHeight: 18 },
  captureCard: {
    marginTop: 14,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  captureLabel: { color: Brand.muted, fontSize: 12, fontWeight: "800" },
  captureValue: { marginTop: 8, color: Brand.ink, fontSize: 16, fontWeight: "900" },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  pillText: { color: Brand.cocoa, fontSize: 12, fontWeight: "800" },
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
  trainerStatusCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 18,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  trainerStatusPill: {
    alignSelf: "flex-start",
    minHeight: 32,
    borderRadius: 999,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,229,180,0.60)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.18)",
  },
  trainerStatusPillText: { color: Brand.ink, fontSize: 12, fontWeight: "900" },
  micOuter: {
    marginTop: 22,
    alignSelf: "center",
    width: 116,
    height: 116,
    borderRadius: 58,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.78)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  micInner: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,245,229,0.96)",
  },
  trainerHeadline: { marginTop: 18, color: Brand.ink, fontSize: 22, fontWeight: "900", textAlign: "center" },
  trainerStatusText: { marginTop: 10, color: Brand.muted, fontSize: 14, lineHeight: 22, textAlign: "center" },
  meterTrack: {
    marginTop: 18,
    height: 10,
    borderRadius: 999,
    backgroundColor: "rgba(124, 99, 80, 0.12)",
    overflow: "hidden",
  },
  meterFill: { height: "100%", borderRadius: 999, backgroundColor: Brand.caramel },
  meterCaption: { marginTop: 10, color: Brand.muted, fontSize: 12, fontWeight: "700", textAlign: "center" },
  trainerActions: { flexDirection: "row", gap: 10, marginTop: 18 },
  transcriptText: { marginTop: 14, color: Brand.ink, fontSize: 18, fontWeight: "800", lineHeight: 28 },
  transcriptPlaceholder: { color: Brand.muted, fontWeight: "600" },
  errorBanner: {
    marginTop: 14,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(244,214,207,0.62)",
    borderWidth: 1,
    borderColor: "rgba(185,98,72,0.18)",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  errorBannerText: { flex: 1, color: Brand.danger, fontSize: 13, lineHeight: 19, fontWeight: "700" },
  listItem: { marginTop: 12, color: Brand.muted, fontSize: 14, lineHeight: 22 },
  trainingAudioUriText: {
    marginTop: 14,
    color: Brand.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  strong: { color: Brand.ink, fontWeight: "900" },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.94, transform: [{ scale: 0.995 }] },
});
