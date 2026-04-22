import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Switch,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import { API_BASE, apiGet, apiPostForm } from "@/lib/api";
import { getProfileForFirebaseUid } from "@/lib/account";

type Routine = {
  wake_time: string;
  sleep_time: string;
  work_start?: string | null;
  work_end?: string | null;
  daily_habits?: string | null;
};

type NoticeState = {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimaryPress?: () => void;
} | null;

type TrainingPhase =
  | "idle"
  | "preparing"
  | "listening"
  | "heard-sound"
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

function formatClock(value?: string | null) {
  const source = (value || "").trim();
  if (!source || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(source)) return "Not set";

  const [h, m] = source.split(":").map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function validateHHMM(v: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test((v || "").trim());
}

function countHabits(value?: string | null) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function computeSleepHours(wake?: string | null, sleep?: string | null) {
  if (!wake || !sleep || !validateHHMM(wake) || !validateHHMM(sleep)) return null;

  const [wakeH, wakeM] = wake.split(":").map(Number);
  const [sleepH, sleepM] = sleep.split(":").map(Number);

  const wakeMinutes = wakeH * 60 + wakeM;
  const sleepMinutes = sleepH * 60 + sleepM;

  let diff = wakeMinutes - sleepMinutes;
  if (diff <= 0) diff += 24 * 60;

  return (diff / 60).toFixed(1);
}

function getDayMode(wake?: string | null) {
  if (!wake || !validateHHMM(wake)) return "Flexible";
  const hour = Number(wake.split(":")[0]);
  if (hour < 6) return "Early riser";
  if (hour < 9) return "Morning start";
  if (hour < 12) return "Late starter";
  return "Custom rhythm";
}


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

function getTrainingPhaseLabel(phase: TrainingPhase) {
  switch (phase) {
    case "preparing":
      return "Preparing";
    case "listening":
      return "Listening";
    case "heard-sound":
      return "Hearing you";
    case "processing":
      return "Checking audio";
    case "captured":
      return "Captured";
    case "error":
      return "Try again";
    default:
      return "Ready";
  }
}

function getTrainingPhaseIcon(phase: TrainingPhase): keyof typeof Ionicons.glyphMap {
  switch (phase) {
    case "preparing":
      return "hourglass-outline";
    case "listening":
      return "mic-outline";
    case "heard-sound":
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
  const installed = (installedLocales || []).map((item) => String(item || "").trim().toLowerCase());

  return wanted.some((candidate) =>
    installed.some((installedLocale) => installedLocale === candidate || installedLocale.startsWith(`${candidate}-`) || installedLocale.startsWith(`${candidate}_`))
  );
}

export default function SettingsModal() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const {
    user,
    signOutUser,
    deleteCurrentAccount,
    linkPasswordForCurrentUser,
    passwordLinked,
    googleLinked,
  } = useAuth();

  const {
    userId,
    name,
    settings,
    profile,
    refresh,
    updateName,
    updateSettings,
  } = useAssistant();

  const [resolvedUserId, setResolvedUserId] = useState<number | null>(
    userId || profile?.userId || null
  );
  const [resolvedProfile, setResolvedProfile] = useState(profile || null);

  const [routine, setRoutine] = useState<Routine>({
    wake_time: "07:30",
    sleep_time: "23:30",
    work_start: "09:30",
    work_end: "18:30",
    daily_habits: "Gym, Water, Reading",
  });

  const [assistantNameInput, setAssistantNameInput] = useState(name || "Elli");
  const [tone, setTone] = useState<"pro" | "friendly">(settings.tone);
  const [languageMode, setLanguageMode] = useState<"en" | "ta">(
    settings.languageMode
  );
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(settings.handsFreeEnabled);
  const [wakePhrase, setWakePhrase] = useState(settings.wakePhrase || `Hey ${name || "Elli"}`);
  const [wakeTrainingSamples, setWakeTrainingSamples] = useState<string[]>(
    settings.wakeTrainingSamples || []
  );
  const [trainingWakePhrase, setTrainingWakePhrase] = useState(false);
  const [trainingTranscript, setTrainingTranscript] = useState("");
  const [trainingScreenVisible, setTrainingScreenVisible] = useState(false);
  const [trainingPhase, setTrainingPhase] = useState<TrainingPhase>("idle");
  const [trainingStatus, setTrainingStatus] = useState("");
  const [trainingError, setTrainingError] = useState("");
  const [trainingLevel, setTrainingLevel] = useState(0);
  const [trainingAudioUri, setTrainingAudioUri] = useState("");
  const [trainingAudioCaptured, setTrainingAudioCaptured] = useState(false);
  const [trainingDiagnostics, setTrainingDiagnostics] = useState<AndroidTrainingDiagnostics>({
    checking: false,
    defaultService: "",
    availableServices: [],
    supportsOnDevice: false,
    installedLocales: [],
    canUseOnDeviceForLocale: false,
  });

  const trainingWakePhraseRef = useRef(false);
  const trainingScreenVisibleRef = useRef(false);
  const trainingPhaseRef = useRef<TrainingPhase>("idle");
  const trainingBestTranscriptRef = useRef("");
  const trainingAudioUriRef = useRef("");
  const trainingAudioCapturedRef = useRef(false);
  const trainingPendingRecordedAudioFallbackRef = useRef(false);
  const trainingCheckingRecordedAudioRef = useRef(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [linkingPassword, setLinkingPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const bottomPadding = Math.max(insets.bottom + 28, 28);
  const heroTitleSize = isVerySmallPhone ? 24 : isSmallPhone ? 28 : 33;
  const heroTitleLineHeight = heroTitleSize + 6;

  useEffect(() => {
    trainingWakePhraseRef.current = trainingWakePhrase;
  }, [trainingWakePhrase]);

  useEffect(() => {
    trainingScreenVisibleRef.current = trainingScreenVisible;
  }, [trainingScreenVisible]);

  useEffect(() => {
    trainingPhaseRef.current = trainingPhase;
  }, [trainingPhase]);

  useEffect(() => {
    return () => {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // Ignore cleanup errors.
      }
    };
  }, []);

  useEffect(() => {
    trainingAudioUriRef.current = trainingAudioUri;
  }, [trainingAudioUri]);

  useEffect(() => {
    trainingAudioCapturedRef.current = trainingAudioCaptured;
  }, [trainingAudioCaptured]);

  useEffect(() => {
    return () => {
      trainingPendingRecordedAudioFallbackRef.current = false;
      trainingCheckingRecordedAudioRef.current = false;
    };
  }, []);

  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
    setHandsFreeEnabled(settings.handsFreeEnabled);
    setWakePhrase(settings.wakePhrase || `Hey ${name || "Elli"}`);
    setWakeTrainingSamples(settings.wakeTrainingSamples || []);
  }, [name, settings]);

  const accountName = useMemo(
    () => resolvedProfile?.name || profile?.name || "Not set",
    [resolvedProfile, profile?.name]
  );

  const accountPlace = useMemo(
    () => resolvedProfile?.place || profile?.place || "Not set",
    [resolvedProfile, profile?.place]
  );

  const accountTimezone = useMemo(
    () => resolvedProfile?.timezone || profile?.timezone || "Asia/Kolkata",
    [resolvedProfile, profile?.timezone]
  );

  const signInMethods = useMemo(() => {
    const methods: string[] = [];
    if (googleLinked) methods.push("Google");
    if (passwordLinked) methods.push("Email/password");
    return methods.length ? methods.join(", ") : "Not linked";
  }, [googleLinked, passwordLinked]);

  const targetUserId =
    resolvedUserId || userId || profile?.userId || resolvedProfile?.userId || null;

  const wakePrompt = useMemo(
    () => wakePhrase.trim() || `Hey ${assistantNameInput.trim() || "Elli"}`,
    [assistantNameInput, wakePhrase]
  );

  const speechLocale = languageMode === "ta" ? "ta-IN" : "en-IN";

  useEffect(() => {
    if (!trainingScreenVisible) return;
    setTrainingStatus(
      `When you’re ready, tap Start listening and say “${wakePrompt}”.`
    );
  }, [trainingScreenVisible, wakePrompt]);

  const preferencesDirty =
    assistantNameInput.trim() !== (name || "Elli").trim() ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode ||
    handsFreeEnabled !== settings.handsFreeEnabled ||
    wakePrompt !== (settings.wakePhrase || `Hey ${name || "Elli"}`).trim() ||
    JSON.stringify(uniqueSamples(wakeTrainingSamples)) !==
      JSON.stringify(uniqueSamples(settings.wakeTrainingSamples || []));

  const sleepHours = useMemo(
    () => computeSleepHours(routine.wake_time, routine.sleep_time),
    [routine.sleep_time, routine.wake_time]
  );

  const stats = useMemo(
    () => ({
      habits: countHabits(routine.daily_habits),
      sleep: sleepHours ? `${sleepHours}h` : "--",
      mode: getDayMode(routine.wake_time),
    }),
    [routine.daily_habits, routine.wake_time, sleepHours]
  );

  function acceptWakePhraseSample(transcript: string, source: "final" | "partial" | "recorded-audio") {
    const normalized = normalizeRecognitionTranscript(transcript);
    if (!normalized) return;

    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingBestTranscriptRef.current = normalized;
    setTrainingTranscript(normalized);
    setWakePhrase(normalized);
    setWakeTrainingSamples((prev) => uniqueSamples([normalized, wakePrompt, ...prev]));
    setTrainingWakePhrase(false);
    trainingWakePhraseRef.current = false;
    setTrainingLevel(0);
    setTrainingPhase("captured");
    setTrainingError("");
    setTrainingStatus(
      source === "recorded-audio"
        ? `Captured “${normalized}” after verifying the recorded microphone audio. Tap Save in Settings to keep it.`
        : source === "partial"
          ? `Captured “${normalized}” from the best live result. Tap Save in Settings to keep it.`
          : `Captured “${normalized}”. It has been filled into the wake phrase field below. Tap Save in Settings to keep it.`
    );
  }

  async function refreshTrainingDiagnostics() {
    if (Platform.OS !== "android") return;

    setTrainingDiagnostics((prev) => ({ ...prev, checking: true }));

    let defaultService = "";
    let availableServices: string[] = [];
    let supportsOnDevice = false;
    let installedLocales: string[] = [];

    try {
      defaultService =
        String(ExpoSpeechRecognitionModule.getDefaultRecognitionService?.()?.packageName || "").trim();
    } catch {
      defaultService = "";
    }

    try {
      const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices?.();
      availableServices = Array.isArray(services) ? services.map((item) => String(item || "").trim()).filter(Boolean) : [];
    } catch {
      availableServices = [];
    }

    try {
      supportsOnDevice = Boolean(ExpoSpeechRecognitionModule.supportsOnDeviceRecognition?.());
    } catch {
      supportsOnDevice = false;
    }

    if (supportsOnDevice) {
      try {
        const payload: any = await ExpoSpeechRecognitionModule.getSupportedLocales?.({
          androidRecognitionServicePackage: "com.google.android.as",
        });
        installedLocales = Array.isArray(payload?.installedLocales)
          ? payload.installedLocales.map((item: any) => String(item || "").trim()).filter(Boolean)
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
  }

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
        setTrainingStatus(`The on-device speech model for ${speechLocale} was downloaded. Try training again now.`);
      } else if (status === "download_canceled") {
        setTrainingStatus(`The offline speech model download was canceled. Training will keep using the default recognizer.`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not open the offline speech model download.";
      setTrainingError(message);
      setTrainingStatus(message);
    } finally {
      await refreshTrainingDiagnostics();
    }
  }

  async function transcribeRecordedWakePhrase(uri: string) {
    const sourceUri = String(uri || "").trim();
    if (!sourceUri || trainingCheckingRecordedAudioRef.current) return;

    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = true;
    setTrainingWakePhrase(false);
    trainingWakePhraseRef.current = false;
    setTrainingPhase("processing");
    setTrainingLevel(0);
    setTrainingError("");
    setTrainingStatus(
      "Android captured microphone audio but returned no text. Checking the recorded audio with server speech-to-text…"
    );

    try {
      const extension = sourceUri.toLowerCase().endsWith(".wav") ? "wav" : "m4a";
      const mimeType = extension === "wav" ? "audio/wav" : "audio/m4a";
      const form = new FormData();
      form.append("file", {
        uri: sourceUri,
        name: `wake-phrase.${extension}`,
        type: mimeType,
      } as any);

      const response = await apiPostForm<{
        ok?: boolean;
        transcript?: string | null;
        text?: string | null;
        language?: string | null;
      }>(
        `/api/wake-phrase/transcribe?language=${encodeURIComponent(
          languageMode === "ta" ? "ta" : "en"
        )}`,
        form
      );

      const transcript = normalizeRecognitionTranscript(
        String(response?.transcript || response?.text || "")
      );

      if (!transcript) {
        throw new Error("Recorded audio was captured, but transcription came back empty.");
      }

      acceptWakePhraseSample(transcript, "recorded-audio");
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Recorded audio was captured, but transcription still failed.";

      setTrainingPhase("error");
      setTrainingError(message);
      setTrainingStatus(message);
    } finally {
      trainingCheckingRecordedAudioRef.current = false;
    }
  }

  useSpeechRecognitionEvent("start", () => {
    if (!trainingScreenVisibleRef.current || !trainingWakePhraseRef.current) return;

    setTrainingPhase("listening");
    setTrainingStatus(`Listening now. Say “${wakePrompt}”.`);
    setTrainingError("");
    setTrainingLevel(0.08);
  });

  useSpeechRecognitionEvent("speechstart", () => {
    if (!trainingScreenVisibleRef.current || !trainingWakePhraseRef.current) return;

    setTrainingPhase("heard-sound");
    setTrainingStatus("Sound detected. Keep speaking until the phrase is complete.");
  });

  useSpeechRecognitionEvent("volumechange", (event: any) => {
    if (!trainingScreenVisibleRef.current || !trainingWakePhraseRef.current) return;

    const nextValue = Number(event?.value ?? -2);
    const normalized = Math.max(0, Math.min(1, (nextValue + 2) / 12));
    setTrainingLevel(normalized);

    if (nextValue > 0 && trainingPhaseRef.current === "listening") {
      setTrainingPhase("heard-sound");
      setTrainingStatus("We can hear you. Finish saying the wake phrase.");
    }
  });

  useSpeechRecognitionEvent("audiostart", () => {
    if (!trainingScreenVisibleRef.current || !trainingWakePhraseRef.current) return;

    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioCapturedRef.current = false;
    trainingAudioUriRef.current = "";
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingStatus(`Microphone is live. Say “${wakePrompt}” now.`);
  });

  useSpeechRecognitionEvent("audioend", (event: any) => {
    if (!trainingScreenVisibleRef.current) return;

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

  useSpeechRecognitionEvent("result", (event: any) => {
    if (!trainingScreenVisibleRef.current || !trainingWakePhraseRef.current) return;

    const transcript = normalizeRecognitionTranscript(
      String(event?.results?.[0]?.transcript || "")
    );
    if (!transcript) return;

    trainingBestTranscriptRef.current = transcript;
    setTrainingTranscript(transcript);

    if (event?.isFinal) {
      acceptWakePhraseSample(transcript, "final");
    }
  });

  useSpeechRecognitionEvent("error", (event: any) => {
    if (!trainingScreenVisibleRef.current) return;

    if (event?.error === "aborted") {
      trainingPendingRecordedAudioFallbackRef.current = false;
      trainingCheckingRecordedAudioRef.current = false;
      setTrainingWakePhrase(false);
      trainingWakePhraseRef.current = false;
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
      setTrainingWakePhrase(false);
      trainingWakePhraseRef.current = false;
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
    setTrainingWakePhrase(false);
    trainingWakePhraseRef.current = false;
    setTrainingLevel(0);
    setTrainingPhase("error");
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
          : `We didn’t catch a full phrase. Hold the phone close and say “${wakePrompt}” right after tapping Start listening.`
        : String(event?.message || "Could not capture the wake phrase sample.")
    );
  });

  useSpeechRecognitionEvent("end", () => {
    setTrainingWakePhrase(false);
    trainingWakePhraseRef.current = false;
    setTrainingLevel(0);

    if (!trainingScreenVisibleRef.current) return;
    if (trainingPhaseRef.current === "captured" || trainingPhaseRef.current === "error") return;
    if (trainingPendingRecordedAudioFallbackRef.current || trainingCheckingRecordedAudioRef.current) return;

    if (trainingBestTranscriptRef.current.trim()) {
      acceptWakePhraseSample(trainingBestTranscriptRef.current, "partial");
      return;
    }

    setTrainingPhase("idle");
    setTrainingStatus(`Listening session ended. Tap Start listening to try “${wakePrompt}” again.`);
  });

  function showNotice(
    title: string,
    message: string,
    primaryLabel?: string,
    onPrimaryPress?: () => void
  ) {
    setNotice({
      title,
      message,
      primaryLabel,
      onPrimaryPress,
    });
  }

  function closeNotice() {
    setNotice(null);
  }

  useEffect(() => {
    let alive = true;

    async function hydrateIdentity() {
      try {
        const localProfile = await getProfileForFirebaseUid(user?.uid, user?.email);
        if (!alive) return;

        const nextUserId = userId || profile?.userId || localProfile?.userId || null;
        const nextProfile =
          profile?.firebaseUid && user?.uid && profile.firebaseUid === user.uid
            ? profile
            : localProfile || profile || null;

        setResolvedUserId(nextUserId);
        setResolvedProfile(nextProfile);
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    void hydrateIdentity();

    return () => {
      alive = false;
    };
  }, [profile, user?.email, user?.uid, userId]);

  useEffect(() => {
    let mounted = true;

    async function loadRoutine() {
      if (!resolvedUserId) {
        if (mounted) {
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        const data = await apiGet<Routine>(`/users/${resolvedUserId}/daily-routine`);

        if (mounted && data) {
          setRoutine({
            wake_time: data.wake_time || "07:30",
            sleep_time: data.sleep_time || "23:30",
            work_start: data.work_start || "09:30",
            work_end: data.work_end || "18:30",
            daily_habits: data.daily_habits || "",
          });
        }
      } catch {
        // Keep defaults if backend routine is unavailable.
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void loadRoutine();

    return () => {
      mounted = false;
    };
  }, [resolvedUserId]);

  async function handleSignOut() {
    if (signingOut) return;

    Alert.alert("Sign out", "Do you want to sign out from this account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        onPress: async () => {
          try {
            setSigningOut(true);
            await signOutUser();
            // Do not call refresh() here.
            // Do not call router.replace("/") here.
            // Root app/_layout.tsx RouteGate should handle the redirect.
          } catch (error: any) {
            showNotice("Sign out failed", error?.message || "Failed to sign out.");
          } finally {
            setSigningOut(false);
          }
        },
      },
    ]);
  }

  async function confirmDeleteAccount() {
    if (deleting) return;

    Alert.alert(
      "Delete account",
      "This will permanently delete your login and all app data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              setDeleting(true);
              await deleteCurrentAccount(targetUserId || undefined);
              // Do not call refresh() here.
              // Do not call router.replace("/") here.
              // Root app/_layout.tsx RouteGate should handle the redirect.
            } catch (error: any) {
              showNotice("Delete failed", error?.message || "Failed to delete account.");
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  async function handleAddPasswordLogin() {
    if (linkingPassword) return;

    if (!user?.email) {
      showNotice(
        "Email missing",
        "This account does not have an email address to attach a password to."
      );
      return;
    }

    if (passwordLinked) {
      showNotice("Already linked", "This account already supports email/password login.");
      return;
    }

    if (password.trim().length < 6) {
      showNotice("Invalid password", "Password should be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      showNotice("Password mismatch", "Password and confirm password must match.");
      return;
    }

    try {
      setLinkingPassword(true);
      await linkPasswordForCurrentUser(
        password.trim(),
        accountName !== "Not set" ? accountName : undefined
      );
      setPassword("");
      setConfirmPassword("");
      await refresh();
      showNotice(
        "Password login added",
        "You can now log in with this email and password without using Google."
      );
    } catch (error: any) {
      showNotice(
        "Couldn’t add password login",
        error?.message || "Failed to link password login."
      );
    } finally {
      setLinkingPassword(false);
    }
  }

  function openWakePhraseTrainer() {
    setTrainingScreenVisible(true);
    trainingScreenVisibleRef.current = true;
    trainingBestTranscriptRef.current = "";
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioUriRef.current = "";
    trainingAudioCapturedRef.current = false;
    setTrainingPhase("idle");
    setTrainingError("");
    setTrainingLevel(0);
    setTrainingTranscript("");
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
    void refreshTrainingDiagnostics();
  }

  function closeWakePhraseTrainer() {
    trainingScreenVisibleRef.current = false;
    trainingWakePhraseRef.current = false;
    trainingPhaseRef.current = "idle";
    trainingPendingRecordedAudioFallbackRef.current = false;
    trainingCheckingRecordedAudioRef.current = false;
    trainingAudioUriRef.current = "";
    trainingAudioCapturedRef.current = false;

    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // Ignore cleanup errors.
    }

    trainingBestTranscriptRef.current = "";
    setTrainingWakePhrase(false);
    setTrainingScreenVisible(false);
    setTrainingPhase("idle");
    setTrainingError("");
    setTrainingLevel(0);
    setTrainingAudioCaptured(false);
    setTrainingAudioUri("");
    setTrainingStatus(`When you’re ready, tap Start listening and say “${wakePrompt}”.`);
  }

  function stopWakePhraseTraining() {
    if (!trainingWakePhraseRef.current) return;

    setTrainingStatus("Finishing this listening session…");

    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // Ignore nested stop failures.
      }
    }
  }

  async function startWakePhraseTraining() {
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
        setTrainingWakePhrase(false);
        trainingWakePhraseRef.current = false;
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

      setTrainingWakePhrase(true);
      trainingWakePhraseRef.current = true;

      ExpoSpeechRecognitionModule.start({
        lang: speechLocale,
        interimResults: true,
        maxAlternatives: 1,
        continuous: Platform.OS === "android" && Number(Platform.Version) >= 33,
        requiresOnDeviceRecognition: shouldUseOnDevice,
        androidRecognitionServicePackage:
          Platform.OS === "android"
            ? shouldUseOnDevice
              ? "com.google.android.as"
              : trainingDiagnostics.defaultService || "com.google.android.tts"
            : undefined,
        addsPunctuation: false,
        contextualStrings: uniqueSamples([
          wakePrompt,
          assistantNameInput,
          ...(wakeTrainingSamples || []),
        ]),
        iosTaskHint: "confirmation",
        volumeChangeEventOptions: {
          enabled: true,
          intervalMillis: 120,
        },
        recordingOptions: canPersistAudio
          ? {
              persist: true,
            }
          : undefined,
        androidIntentOptions:
          Platform.OS === "android"
            ? {
                EXTRA_LANGUAGE_MODEL: "web_search",
                EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 3200,
                EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 1800,
                EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1500,
              }
            : undefined,
      });
    } catch (error: unknown) {
      setTrainingWakePhrase(false);
      trainingWakePhraseRef.current = false;
      setTrainingPhase("error");
      setTrainingLevel(0);

      const message =
        error instanceof Error ? error.message : "Could not start wake phrase training.";

      setTrainingError(message);
      setTrainingStatus(message);
    }
  }

  async function savePreferences() {
    const trimmedName = assistantNameInput.trim();

    if (savingPreferences) return;

    if (trimmedName.length < 2) {
      showNotice("Invalid name", "Assistant name should be at least 2 characters.");
      return;
    }

    try {
      setSavingPreferences(true);

      if (trimmedName !== (name || "Elli").trim()) {
        await updateName(trimmedName);
      }

      if (
        tone !== settings.tone ||
        languageMode !== settings.languageMode ||
        handsFreeEnabled !== settings.handsFreeEnabled ||
        wakePrompt !== (settings.wakePhrase || `Hey ${name || "Elli"}`).trim() ||
        JSON.stringify(uniqueSamples(wakeTrainingSamples)) !==
          JSON.stringify(uniqueSamples(settings.wakeTrainingSamples || []))
      ) {
        await updateSettings({
          tone,
          languageMode,
          handsFreeEnabled,
          wakePhrase: wakePrompt,
          wakeTrainingSamples: uniqueSamples(wakeTrainingSamples),
        });
      }

      await refresh();
      showNotice(
        "Preferences saved",
        "Your assistant preferences have been updated successfully."
      );
    } catch (error: any) {
      showNotice(
        "Save failed",
        error?.message || "Could not save assistant preferences."
      );
    } finally {
      setSavingPreferences(false);
    }
  }

  async function saveRoutine() {
    if (!resolvedUserId) {
      showNotice(
        "Profile missing",
        "Your profile is not complete yet. Please finish setup first.",
        "Go to profile",
        () => {
          closeNotice();
          router.replace("/onboarding/profile");
        }
      );
      return;
    }

    if (!validateHHMM(routine.wake_time) || !validateHHMM(routine.sleep_time)) {
      showNotice("Invalid time", "Wake time and sleep time must be in HH:MM format.");
      return;
    }

    if (routine.work_start?.trim() && !validateHHMM(routine.work_start)) {
      showNotice("Invalid time", "Work start must be in HH:MM format.");
      return;
    }

    if (routine.work_end?.trim() && !validateHHMM(routine.work_end)) {
      showNotice("Invalid time", "Work end must be in HH:MM format.");
      return;
    }

    try {
      setSavingRoutine(true);

      const payload = {
        wake_time: routine.wake_time.trim(),
        sleep_time: routine.sleep_time.trim(),
        work_start: routine.work_start?.trim() || null,
        work_end: routine.work_end?.trim() || null,
        daily_habits: routine.daily_habits?.trim() || null,
      };

      const res = await fetch(`${API_BASE}/users/${resolvedUserId}/daily-routine`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Could not save routine");
      }

      await refresh();
      showNotice("Routine saved", "Your daily routine was updated successfully.");
    } catch (error: any) {
      showNotice("Save failed", error?.message || "Could not save routine.");
    } finally {
      setSavingRoutine(false);
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
            paddingTop: topPadding,
            paddingHorizontal: horizontalPadding,
            paddingBottom: bottomPadding,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.topBar}>
            <Pressable style={styles.topIconBtn} onPress={() => router.back()}>
              <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
            </Pressable>

            <View style={styles.topCenter}>
              <Text style={styles.topTitle}>Settings</Text>
            </View>
          </View>

          <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
            <View style={styles.heroHeaderRow}>
            </View>

            <View style={styles.metricRow}>
              <OverviewMetric
                icon="sparkles-outline"
                label="Assistant"
                value={name || "Elli"}
              />
              <OverviewMetric
                icon="time-outline"
                label="Sleep"
                value={stats.sleep}
              />
              <OverviewMetric
                icon="leaf-outline"
                label="Habits"
                value={String(stats.habits)}
              />
            </View>

            <LinearGradient
              colors={["rgba(255,255,255,0.84)", "rgba(255,239,210,0.66)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.heroInsightCard}
            >

              <Text style={styles.heroInsightTitle}>{stats.mode}</Text>
              <Text style={styles.heroInsightText}>
                Wake at {formatClock(routine.wake_time)}, sleep at {formatClock(routine.sleep_time)}
                {routine.work_start?.trim() && routine.work_end?.trim()
                  ? `, with work hours from ${formatClock(routine.work_start)} to ${formatClock(routine.work_end)}.`
                  : "."}
              </Text>
            </LinearGradient>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <View style={styles.sectionHeaderRow}>
              <View>
                <Text style={styles.sectionTitle}>Customise</Text>
              </View>
            </View>

            <Pressable
              onPress={() => router.push("/customise")}
              style={({ pressed }) => [styles.accountHeroCard, pressed && styles.pressed]}
            >
              <View style={styles.accountAvatar}>
                <Ionicons name="color-palette-outline" size={22} color={Brand.ink} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.accountName}>{`Customise (${name || "Elli"})`}</Text>
                <Text style={styles.accountMeta}>
                  Assistant name, tone, and reply language
                </Text>
              </View>

              <Ionicons name="chevron-forward" size={18} color={Brand.cocoa} />
            </Pressable>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <View style={styles.sectionHeaderRow}>
              <View>
                <Text style={styles.sectionTitle}>Account & security</Text>
              </View>
              <SectionPill label="Secure" />
            </View>

            <View style={styles.accountHeroCard}>
              <View style={styles.accountAvatar}>
                <Text style={styles.accountAvatarText}>
                  {(accountName || "U").trim().charAt(0).toUpperCase()}
                </Text>
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.accountName}>{accountName}</Text>
                <Text style={styles.accountEmail} numberOfLines={1}>
                  {user?.email || "No email attached"}
                </Text>
                <Text style={styles.accountMeta} numberOfLines={1}>
                  {accountPlace} · {accountTimezone}
                </Text>
              </View>
            </View>

            <View style={styles.infoGrid}>
              <InfoCard label="Name" value={accountName} icon="person-outline" />
              <InfoCard label="Email" value={user?.email || "Not set"} icon="mail-outline" />
              <InfoCard label="Place" value={accountPlace} icon="location-outline" />
              <InfoCard label="Timezone" value={accountTimezone} icon="earth-outline" />
            </View>

            <View style={styles.inlineStatusRow}>
              <StatusChip
                icon="logo-google"
                label={googleLinked ? "Google linked" : "Google not linked"}
                positive={googleLinked}
              />
              <StatusChip
                icon="mail-outline"
                label={passwordLinked ? "Password linked" : "Password not linked"}
                positive={passwordLinked}
              />
            </View>

            <View style={styles.helperPanel}>
              <Text style={styles.helperPanelTitle}>Active sign-in methods</Text>
              <Text style={styles.helperPanelText}>{signInMethods}</Text>
            </View>

            {!passwordLinked ? (
              <>
                <Field
                  label="New password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Minimum 6 characters"
                  secureTextEntry
                  icon="shield-checkmark-outline"
                />

                <Field
                  label="Confirm password"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Repeat password"
                  secureTextEntry
                  icon="key-outline"
                />

                <Pressable
                  onPress={handleAddPasswordLogin}
                  disabled={linkingPassword}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    linkingPassword && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {linkingPassword ? (
                    <ActivityIndicator color={Brand.ink} />
                  ) : (
                    <>
                      <Ionicons
                        name="shield-checkmark-outline"
                        size={16}
                        color={Brand.ink}
                      />
                      <Text style={styles.secondaryButtonText}>
                        Add email/password login
                      </Text>
                    </>
                  )}
                </Pressable>
              </>
            ) : (
              <View style={styles.successBanner}>
                <Ionicons name="checkmark-circle" size={18} color={Brand.success} />
                <Text style={styles.successBannerText}>
                  This account already supports email/password login.
                </Text>
              </View>
            )}
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <View style={styles.sectionHeaderRow}>
              <View>
                <Text style={styles.sectionTitle}>Daily routine</Text>
              </View>
              <SectionPill label="Routine" />
            </View>

            <LinearGradient
              colors={["rgba(255,255,255,0.78)", "rgba(255,239,210,0.62)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.routinePreviewCard}
            >
              <View style={styles.timelineRow}>
                <TimelinePoint icon="sunny-outline" label="Wake" value={formatClock(routine.wake_time)} />
                <View style={styles.timelineDivider} />
                <TimelinePoint icon="briefcase-outline" label="Work" value={routine.work_start?.trim() ? formatClock(routine.work_start) : "Flexible"} />
                <View style={styles.timelineDivider} />
                <TimelinePoint icon="moon-outline" label="Sleep" value={formatClock(routine.sleep_time)} />
              </View>
            </LinearGradient>

            <View style={styles.twoColRow}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Wake time"
                  value={routine.wake_time}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, wake_time: v }))}
                  placeholder="07:30"
                  icon="sunny-outline"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Sleep time"
                  value={routine.sleep_time}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, sleep_time: v }))}
                  placeholder="23:30"
                  icon="moon-outline"
                />
              </View>
            </View>

            <View style={styles.twoColRow}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Work start"
                  value={routine.work_start || ""}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_start: v }))}
                  placeholder="09:30"
                  icon="briefcase-outline"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Work end"
                  value={routine.work_end || ""}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_end: v }))}
                  placeholder="18:30"
                  icon="flag-outline"
                />
              </View>
            </View>

            <Field
              label="Daily habits"
              value={routine.daily_habits || ""}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, daily_habits: v }))}
              placeholder="Gym, Water, Reading"
              multiline
              height={104}
              icon="leaf-outline"
            />

            <View style={styles.habitSummaryRow}>
              <MiniStatCard label="Habits tracked" value={String(stats.habits)} icon="leaf-outline" />
              <MiniStatCard label="Sleep target" value={stats.sleep} icon="moon-outline" />
              <MiniStatCard label="Start style" value={stats.mode} icon="sparkles-outline" />
            </View>

            <Pressable
              onPress={saveRoutine}
              disabled={savingRoutine || loading}
              style={({ pressed }) => [
                styles.primaryButtonShell,
                (savingRoutine || loading) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <LinearGradient
                colors={Brand.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {savingRoutine || loading ? (
                  <ActivityIndicator color={Brand.ink} />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>Save routine</Text>
                    <Ionicons name="checkmark" size={16} color={Brand.ink} />
                  </>
                )}
              </LinearGradient>
            </Pressable>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16, marginBottom: 10 }}>
            <View style={styles.sectionHeaderRow}>
              <View>
                <Text style={styles.sectionTitle}> Leave us </Text>
              </View>
            </View>

            <Pressable
              onPress={handleSignOut}
              disabled={signingOut}
              style={({ pressed }) => [
                styles.dangerGhostButton,
                signingOut && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {signingOut ? (
                <ActivityIndicator color={Brand.cocoa} />
              ) : (
                <>
                  <Ionicons name="log-out-outline" size={16} color={Brand.cocoa} />
                  <Text style={styles.dangerGhostButtonText}>Sign out</Text>
                </>
              )}
            </Pressable>

            <Pressable
              onPress={confirmDeleteAccount}
              disabled={deleting}
              style={({ pressed }) => [
                styles.dangerButton,
                deleting && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {deleting ? (
                <ActivityIndicator color="#fff8f5" />
              ) : (
                <>
                  <Ionicons name="trash-outline" size={16} color="#fff8f5" />
                  <Text style={styles.dangerButtonText}>Delete account permanently</Text>
                </>
              )}
            </Pressable>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={trainingScreenVisible}
        animationType="slide"
        onRequestClose={closeWakePhraseTrainer}
      >
        <LinearGradient colors={Brand.gradients.page} style={styles.trainingScreen}>
          <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
            <View style={styles.topGlow} />
            <View style={styles.leftGlow} />
            <View style={styles.bottomGlow} />
          </View>

          <View
            style={[
              styles.trainingHeaderBar,
              { paddingTop: insets.top + 8, paddingHorizontal: horizontalPadding },
            ]}
          >
            <Pressable onPress={closeWakePhraseTrainer} style={styles.trainingHeaderButton}>
              <Ionicons name="chevron-back" size={20} color={Brand.ink} />
            </Pressable>

            <Text style={styles.trainingHeaderTitle}>Wake phrase trainer</Text>

            <View style={styles.trainingHeaderButtonPlaceholder} />
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: horizontalPadding,
              paddingBottom: bottomPadding,
              paddingTop: 12,
            }}
            showsVerticalScrollIndicator={false}
          >
            <GlassCard style={styles.trainingHeroShell}>
              <Text style={styles.trainingHeroEyebrow}>Dedicated training screen</Text>
              <Text style={styles.trainingHeroTitle}>Train “{wakePrompt}”</Text>
              <Text style={styles.trainingHeroText}>
                This screen stays open while the microphone listens, so you can clearly see
                when the app is ready, hearing sound, or has captured your phrase.
              </Text>

              <View style={styles.trainingStatusCardLarge}>
                <View
                  style={[
                    styles.trainingStatusPill,
                    trainingPhase === "captured" && styles.trainingStatusPillSuccess,
                    trainingPhase === "error" && styles.trainingStatusPillError,
                    (trainingPhase === "listening" || trainingPhase === "heard-sound") &&
                      styles.trainingStatusPillActive,
                  ]}
                >
                  <Ionicons
                    name={getTrainingPhaseIcon(trainingPhase)}
                    size={14}
                    color={Brand.ink}
                  />
                  <Text style={styles.trainingStatusPillText}>
                    {getTrainingPhaseLabel(trainingPhase)}
                  </Text>
                </View>

                <View style={styles.trainingMicHero}>
                  <View
                    style={[
                      styles.trainingMicOuter,
                      (trainingPhase === "listening" || trainingPhase === "heard-sound") &&
                        styles.trainingMicOuterActive,
                      trainingPhase === "captured" && styles.trainingMicOuterSuccess,
                      trainingPhase === "error" && styles.trainingMicOuterError,
                    ]}
                  >
                    <View
                      style={[
                        styles.trainingMicInner,
                        (trainingPhase === "listening" || trainingPhase === "heard-sound") &&
                          styles.trainingMicInnerActive,
                        trainingPhase === "captured" && styles.trainingMicInnerSuccess,
                        trainingPhase === "error" && styles.trainingMicInnerError,
                      ]}
                    >
                      <Ionicons
                        name={
                          trainingPhase === "captured"
                            ? "checkmark"
                            : trainingPhase === "error"
                              ? "refresh-outline"
                              : "mic"
                        }
                        size={30}
                        color={Brand.ink}
                      />
                    </View>
                  </View>
                </View>

                <Text style={styles.trainingStatusTitleLarge}>
                  {trainingPhase === "captured"
                    ? "Wake phrase captured"
                    : trainingPhase === "error"
                      ? "We didn’t get a usable phrase"
                      : trainingPhase === "heard-sound"
                        ? "We can hear you"
                        : trainingPhase === "processing"
                          ? "Checking recorded audio"
                          : trainingPhase === "listening"
                            ? "Listening now"
                            : trainingPhase === "preparing"
                              ? "Preparing microphone"
                              : "Ready when you are"}
                </Text>

                <Text style={styles.trainingStatusTextLarge}>{trainingStatus}</Text>

                <View style={styles.trainingMeterTrack}>
                  <View
                    style={[
                      styles.trainingMeterFill,
                      {
                        width: `${
                          trainingWakePhrase
                            ? Math.max(10, Math.round(trainingLevel * 100))
                            : trainingPhase === "captured"
                              ? 100
                              : 10
                        }%`,
                      },
                    ]}
                  />
                </View>

                <Text style={styles.trainingMeterCaption}>
                  {trainingWakePhrase
                    ? trainingLevel > 0.04
                      ? "Voice activity detected"
                      : "Waiting for your voice"
                    : trainingPhase === "captured"
                      ? "Phrase saved locally"
                      : trainingAudioCaptured
                        ? "Microphone audio captured"
                        : "Not listening right now"}
                </Text>
              </View>

              <View style={styles.trainingActionRow}>
                <Pressable
                  onPress={trainingWakePhrase ? stopWakePhraseTraining : startWakePhraseTraining}
                  style={({ pressed }) => [
                    styles.trainingPrimaryButtonShell,
                    pressed && styles.pressed,
                  ]}
                >
                  <LinearGradient
                    colors={Brand.gradients.button}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.trainingPrimaryButton}
                  >
                    {trainingWakePhrase ? (
                      <>
                        <Ionicons name="stop-circle-outline" size={18} color={Brand.ink} />
                        <Text style={styles.primaryButtonText}>Stop listening</Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="mic-outline" size={18} color={Brand.ink} />
                        <Text style={styles.primaryButtonText}>
                          {trainingPhase === "error" ? "Try again" : "Start listening"}
                        </Text>
                      </>
                    )}
                  </LinearGradient>
                </Pressable>

                <Pressable
                  onPress={closeWakePhraseTrainer}
                  style={({ pressed }) => [
                    styles.trainingSecondaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    {trainingPhase === "captured" ? "Done" : "Close"}
                  </Text>
                </Pressable>
              </View>
            </GlassCard>

            <GlassCard style={styles.trainingInfoShell}>
              <Text style={styles.trainingInfoTitle}>Live transcript</Text>
              <Text
                style={[
                  styles.trainingTranscriptValueLarge,
                  !trainingTranscript && styles.trainingTranscriptPlaceholder,
                ]}
              >
                {trainingTranscript || "Your captured phrase will appear here while training."}
              </Text>

              {trainingError ? (
                <View style={styles.trainingErrorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={Brand.danger} />
                  <Text style={styles.trainingErrorBannerText}>{trainingError}</Text>
                </View>
              ) : null}
            </GlassCard>

            <GlassCard style={styles.trainingInfoShell}>
              <Text style={styles.trainingInfoTitle}>Android recognizer status</Text>
              <Text style={styles.trainingChecklistItem}>
                Default service: <Text style={styles.trainingChecklistStrong}>{trainingDiagnostics.defaultService || "Unknown"}</Text>
              </Text>
              <Text style={styles.trainingChecklistItem}>
                On-device model for {speechLocale}: <Text style={styles.trainingChecklistStrong}>{trainingDiagnostics.canUseOnDeviceForLocale ? "Installed" : trainingDiagnostics.supportsOnDevice ? "Not installed" : "Not supported"}</Text>
              </Text>
              <Text style={styles.trainingChecklistItem}>
                Mic audio captured: <Text style={styles.trainingChecklistStrong}>{trainingAudioCaptured ? "Yes" : "No"}</Text>
              </Text>
              {trainingAudioUri ? (
                <Text style={styles.trainingChecklistItem}>
                  Audio file: <Text style={styles.trainingChecklistStrong}>Ready</Text>
                </Text>
              ) : null}
              {Platform.OS === "android" && trainingDiagnostics.supportsOnDevice && !trainingDiagnostics.canUseOnDeviceForLocale ? (
                <View style={[styles.trainingActionRow, { marginTop: 14 }]}> 
                  <Pressable
                    onPress={downloadOnDeviceSpeechModel}
                    style={({ pressed }) => [
                      styles.trainingSecondaryButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>Download on-device speech model</Text>
                  </Pressable>
                </View>
              ) : null}
            </GlassCard>

            <GlassCard style={styles.trainingInfoShell}>
              <Text style={styles.trainingInfoTitle}>Best way to record it</Text>
              <View style={styles.trainingChecklist}>
                <Text style={styles.trainingChecklistItem}>
                  1. Tap <Text style={styles.trainingChecklistStrong}>Start listening</Text>.
                </Text>
                <Text style={styles.trainingChecklistItem}>
                  2. Say the full phrase once, for example <Text style={styles.trainingChecklistStrong}>“{wakePrompt}”</Text>.
                </Text>
                <Text style={styles.trainingChecklistItem}>
                  3. If Android still says no speech, download the on-device model above and try again.
                </Text>
                <Text style={styles.trainingChecklistItem}>
                  4. For the first test, speak a little longer and clearer than usual, like <Text style={styles.trainingChecklistStrong}>“Hello Elli wake up”</Text>.
                </Text>
                <Text style={styles.trainingChecklistItem}>
                  5. After closing this screen, tap <Text style={styles.trainingChecklistStrong}>Save</Text> in Settings.
                </Text>
              </View>
            </GlassCard>
          </ScrollView>
        </LinearGradient>
      </Modal>

      <Modal transparent visible={!!notice} animationType="fade" onRequestClose={closeNotice}>
        <View style={styles.noticeOverlay}>
          <GlassCard style={{ borderRadius: 28 }}>
            <View style={styles.noticeIconWrap}>
              <Ionicons name="information-circle" size={22} color={Brand.bronze} />
            </View>

            <Text style={styles.noticeTitle}>{notice?.title}</Text>
            <Text style={styles.noticeMessage}>{notice?.message}</Text>

            <View style={styles.noticeActions}>
              <Pressable onPress={closeNotice} style={styles.noticeSecondaryBtn}>
                <Text style={styles.noticeSecondaryText}>Close</Text>
              </Pressable>

              {notice?.primaryLabel ? (
                <Pressable
                  onPress={notice.onPrimaryPress || closeNotice}
                  style={styles.noticePrimaryBtn}
                >
                  <Text style={styles.noticePrimaryText}>{notice.primaryLabel}</Text>
                </Pressable>
              ) : null}
            </View>
          </GlassCard>
        </View>
      </Modal>
    </LinearGradient>
  );
}

function OverviewMetric({
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

function SectionPill({ label, danger = false }: { label: string; danger?: boolean }) {
  return (
    <View style={[styles.sectionBadge, danger && styles.dangerBadge]}>
      <Text style={[styles.sectionBadgeText, danger && styles.dangerBadgeText]}>{label}</Text>
    </View>
  );
}

function InfoCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.infoCard}>
      <View style={styles.infoCardIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.infoCardLabel}>{label}</Text>
      <Text style={styles.infoCardValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function StatusChip({
  icon,
  label,
  positive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  positive: boolean;
}) {
  return (
    <View
      style={[
        styles.statusChip,
        positive ? styles.statusChipPositive : styles.statusChipNeutral,
      ]}
    >
      <Ionicons name={icon} size={14} color={positive ? Brand.success : Brand.cocoa} />
      <Text
        style={[styles.statusChipText, { color: positive ? Brand.success : Brand.cocoa }]}
      >
        {label}
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

function TimelinePoint({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.timelinePoint}>
      <View style={styles.timelinePointIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.timelinePointLabel}>{label}</Text>
      <Text style={styles.timelinePointValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function MiniStatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.miniStatCard}>
      <View style={styles.miniStatIconWrap}>
        <Ionicons name={icon} size={14} color={Brand.bronze} />
      </View>
      <Text style={styles.miniStatValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.miniStatLabel}>{label}</Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  height = 56,
  secureTextEntry = false,
  icon,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
  height?: number;
  secureTextEntry?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldShell, { minHeight: height }]}>
        <View style={styles.fieldIconWrap}>
          <Ionicons name={icon} size={16} color={Brand.bronze} />
        </View>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="rgba(124, 99, 80, 0.52)"
          multiline={multiline}
          secureTextEntry={secureTextEntry}
          autoCapitalize="none"
          style={[
            styles.fieldInput,
            {
              minHeight: height,
              textAlignVertical: multiline ? "top" : "center",
              paddingTop: multiline ? 14 : 0,
            },
          ]}
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

  topCaption: {
    color: Brand.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },

  topTitle: {
    marginTop: 2,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroStatusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroTitle: {
    marginTop: 18,
    color: Brand.ink,
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

  heroInsightCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroInsightBadge: {
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

  heroInsightBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  heroInsightTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  heroInsightText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 19,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 260,
  },

  sectionBadge: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  dangerBadge: {
    backgroundColor: "rgba(185, 98, 72, 0.10)",
    borderColor: "rgba(185, 98, 72, 0.18)",
  },

  sectionBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },

  dangerBadgeText: {
    color: Brand.danger,
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
    alignItems: "flex-start",
    overflow: "hidden",
  },

  fieldIconWrap: {
    width: 46,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
  },

  fieldInput: {
    flex: 1,
    paddingRight: 14,
    color: Brand.ink,
    fontSize: 15,
  },

  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
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


  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  helperInlineText: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  trainingInlineHint: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  trainingScreen: {
    flex: 1,
  },

  trainingHeaderBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  trainingHeaderButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.8)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  trainingHeaderButtonPlaceholder: {
    width: 42,
    height: 42,
  },

  trainingHeaderTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  trainingHeroShell: {
    borderRadius: 30,
  },

  trainingHeroEyebrow: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },

  trainingHeroTitle: {
    marginTop: 10,
    color: Brand.ink,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "900",
  },

  trainingHeroText: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 21,
  },

  trainingStatusCardLarge: {
    marginTop: 18,
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.74)",
    alignItems: "center",
  },

  trainingStatusPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,245,232,0.96)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  trainingStatusPillActive: {
    backgroundColor: "rgba(255,229,180,0.92)",
    borderColor: "rgba(185,120,54,0.28)",
  },

  trainingStatusPillSuccess: {
    backgroundColor: "rgba(223,240,214,0.95)",
    borderColor: "rgba(111,140,94,0.28)",
  },

  trainingStatusPillError: {
    backgroundColor: "rgba(255,233,228,0.96)",
    borderColor: "rgba(185,98,72,0.26)",
  },

  trainingStatusPillText: {
    color: Brand.ink,
    fontSize: 12,
    fontWeight: "900",
  },

  trainingMicHero: {
    marginTop: 18,
    marginBottom: 8,
  },

  trainingMicOuter: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,244,224,0.78)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  trainingMicOuterActive: {
    backgroundColor: "rgba(255,229,180,0.86)",
    borderColor: "rgba(185,120,54,0.24)",
  },

  trainingMicOuterSuccess: {
    backgroundColor: "rgba(223,240,214,0.86)",
    borderColor: "rgba(111,140,94,0.24)",
  },

  trainingMicOuterError: {
    backgroundColor: "rgba(255,233,228,0.9)",
    borderColor: "rgba(185,98,72,0.22)",
  },

  trainingMicInner: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.9)",
  },

  trainingMicInnerActive: {
    backgroundColor: "rgba(255,247,239,0.98)",
  },

  trainingMicInnerSuccess: {
    backgroundColor: "rgba(244,255,239,0.98)",
  },

  trainingMicInnerError: {
    backgroundColor: "rgba(255,246,244,0.98)",
  },

  trainingStatusTitleLarge: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "900",
    textAlign: "center",
  },

  trainingStatusTextLarge: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },

  trainingMeterTrack: {
    width: "100%",
    height: 12,
    borderRadius: 999,
    backgroundColor: "rgba(124,99,80,0.10)",
    overflow: "hidden",
    marginTop: 18,
  },

  trainingMeterFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: Brand.caramel,
  },

  trainingMeterCaption: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  trainingActionRow: {
    marginTop: 18,
    width: "100%",
    gap: 12,
  },

  trainingPrimaryButtonShell: {
    borderRadius: 18,
    overflow: "hidden",
  },

  trainingPrimaryButton: {
    minHeight: 56,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  trainingSecondaryButton: {
    minHeight: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.82)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  trainingInfoShell: {
    borderRadius: 26,
    marginTop: 14,
  },

  trainingInfoTitle: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  trainingTranscriptValueLarge: {
    marginTop: 10,
    color: Brand.ink,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "800",
  },

  trainingTranscriptPlaceholder: {
    color: Brand.muted,
    fontWeight: "700",
  },

  trainingErrorBanner: {
    marginTop: 14,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,233,228,0.92)",
    borderWidth: 1,
    borderColor: "rgba(185,98,72,0.22)",
  },

  trainingErrorBannerText: {
    flex: 1,
    color: Brand.danger,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "700",
  },

  trainingChecklist: {
    marginTop: 10,
    gap: 10,
  },

  trainingChecklistItem: {
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 21,
  },

  trainingChecklistStrong: {
    color: Brand.ink,
    fontWeight: "900",
  },

  trainingResultCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.7)",
    padding: 12,
  },

  trainingResultLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  trainingResultValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "800",
  },

  trainingSamplesTitle: {
    color: Brand.ink,
    fontSize: 13,
    fontWeight: "900",
  },

  sampleWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },

  samplePill: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  samplePillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
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

  secondaryButton: {
    minHeight: 52,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.80)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  secondaryButtonText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  disabled: {
    opacity: 0.6,
  },

  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.995 }],
  },

  accountHeroCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  accountAvatar: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.70)",
  },

  accountAvatarText: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  accountName: {
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  accountEmail: {
    marginTop: 4,
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "700",
  },

  accountMeta: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 106,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoCardIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  infoCardLabel: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  infoCardValue: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
  },

  inlineStatusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  statusChip: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
  },

  statusChipPositive: {
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  statusChipNeutral: {
    backgroundColor: "rgba(255,255,255,0.58)",
    borderColor: Brand.line,
  },

  statusChipText: {
    fontSize: 12,
    fontWeight: "800",
  },

  helperPanel: {
    marginTop: 16,
    borderRadius: 18,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  helperPanelTitle: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "900",
  },

  helperPanelText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  successBanner: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  successBannerText: {
    flex: 1,
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },

  routinePreviewCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  timelineRow: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 10,
  },

  timelinePoint: {
    flex: 1,
    alignItems: "center",
  },

  timelinePointIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  timelinePointLabel: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  timelinePointValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
  },

  timelineDivider: {
    width: 1,
    marginVertical: 6,
    backgroundColor: "rgba(185,120,54,0.16)",
  },

  twoColRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  habitSummaryRow: {
    marginTop: 16,
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },

  miniStatCard: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 96,
    borderRadius: 20,
    padding: 12,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  miniStatIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  miniStatValue: {
    marginTop: 10,
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  miniStatLabel: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 11,
    fontWeight: "700",
  },

  dangerGhostButton: {
    minHeight: 50,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  dangerGhostButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  dangerButton: {
    minHeight: 52,
    marginTop: 12,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: Brand.danger,
  },

  dangerButtonText: {
    color: "#fff8f5",
    fontSize: 14,
    fontWeight: "900",
  },

  noticeOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
    backgroundColor: "rgba(72, 46, 18, 0.18)",
  },

  noticeIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  noticeTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 22,
    fontWeight: "900",
  },

  noticeMessage: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  noticeActions: {
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },

  noticeSecondaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  noticeSecondaryText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  noticePrimaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#efbf7c",
  },

  noticePrimaryText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },
});