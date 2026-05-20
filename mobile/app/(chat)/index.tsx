import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Keyboard,
  LayoutChangeEvent,
  Linking,
  Modal,
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
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import {
  VoiceSessionTranscript,
  type VoiceSessionTurn,
} from "@/components/VoiceSessionTranscript";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import {
  BACKEND_CHAT_FALLBACK_TIMEOUT_MS,
  API_BASE,
  apiDelete,
  apiGet,
  apiPost,
  apiPostBackendOnly,
  apiPostForm,
  sendClientTurnLog,
} from "@/lib/api";
import {
  clearActiveWorkflow,
  markActiveWorkflow,
  updateActiveWorkflowStep,
} from "@/lib/chatTelemetry";
import { computeChatScreenLayout } from "@/lib/chatScreenLayout";
import {
  BackendChatResponse,
  ChatHistoryItem,
  normalizeChatTurnPayload,
} from "@/lib/chatResponse";
import {
  classifyChatHistoryItemsForDeletion,
  filterHistoryItemsByHiddenItemIds,
  filterLocalChatHistoryItems,
  localChatItemsStorageKey,
  markChatHistoryItemsOrigin,
  mergeChatHistoryItems,
  uniqueNumberList,
} from "@/lib/chatHistory";
import { parseDatetime } from "@/lib/datetime";
import { saveScheduledTask } from "@/lib/localTaskStore";
import { getMobileBuildInfo } from "@/lib/mobileBuildInfo";
import {
  getE2eHandsFreeCommand,
  getE2eHandsFreeWakePhrase,
  isE2eMockHandsFreeEnabled,
} from "@/lib/e2eMode";
import {
  buildWakePhraseCandidates,
  cleanHandsFreeCommand,
  isHandsFreeStopCommand,
  matchWakePhrase,
} from "@/lib/handsFreeWake";
import {
  friendlyLocalTimeoutMessage,
  getLocalToBackendFallbackMs,
  getLocalTurnSoftNoticeMs,
  getLocalTurnTimeoutMs,
  isLocalTurnTimeoutError,
  withLocalTimeout,
} from "@/lib/localTurnTimeouts";
import { loadCloudFallbackConsent } from "@/lib/localAssistantSettings";
import { shouldAutoSpeakReply } from "@/lib/replyPlaybackPolicy";
import { resolveVoiceLanguageParams, type VoiceLanguageParams } from "@/lib/replyLanguage";
import { ensureNotificationsReady, scheduleReminder } from "@/lib/reminders";
import {
  EMPTY_AUDIO_MESSAGE,
  MIN_VOICE_RECORDING_MS,
  MIC_START_TIMEOUT_MESSAGE,
  RecordingStartCancelledError,
  RecordingStartTimeoutError,
  TOO_SHORT_AUDIO_MESSAGE,
  VoiceRecordingTooShortError,
  assertMinimumVoiceRecordingDuration,
  assertUsableAudioFile,
  withRecordingStartTimeout,
} from "@/lib/voiceRecording";

type ChatSessionRecord = {
  id: string;
  itemIds: number[];
  createdAt: string;
  updatedAt: string;
  title?: string | null;
};

type ChatSessionListItem = ChatSessionRecord & {
  items: ChatHistoryItem[];
  title: string;
  preview: string;
  sortTime: string;
};

type PendingReminder = {
  title: string;
  details: string;
  datetimeText: string;
};

type RecorderSurface = "live";
type VoiceSessionMode = "live" | null;
type HandsFreeRecognizerMode = "off" | "wake" | "command" | "conversation";
type AgentReplyPlaybackContext = {
  requestId?: string;
  source?: ChatRequestSource;
  voiceSurface?: RecorderSurface | null;
  voiceLanguage?: VoiceLanguageParams | null;
  voiceSessionId?: string | null;
};

type ChatRequestSource = "text" | "handsfree" | "voice";

type PendingChatTurn = {
  requestId: string;
  sessionId: string | null;
  source: ChatRequestSource;
  userMessage: string;
  assistantText?: string;
  status: "thinking" | "error";
  createdAt: string;
};

const MIN_INPUT_HEIGHT = 24;
const MAX_INPUT_HEIGHT = 130;
const RECORDING_STARTUP_SETTLE_MS = Platform.OS === "android" ? 320 : 160;
const CHAT_SESSIONS_STORAGE_PREFIX = "chat_sessions_v2";
const HIDDEN_CHAT_SESSIONS_STORAGE_PREFIX = "hidden_chat_session_ids_v2";
const HIDDEN_CHAT_ITEM_IDS_STORAGE_PREFIX = "hidden_chat_item_ids_v1";
const MODEL_SETUP_ALERT_THROTTLE_MS = 5 * 60 * 1000;
const VOICE_UNAVAILABLE_MESSAGE =
  "Voice is unavailable right now. Please try again.";
const CHAT_LOCAL_SOFT_NOTICE_MESSAGE =
  "Still working...";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function getCachedDeviceCapabilitiesLazy() {
  const { getCachedDeviceCapabilities } = await import("@/lib/deviceCapabilities");
  return getCachedDeviceCapabilities();
}

async function cancelNativeRequestIfAvailable(requestId: string | null) {
  if (!requestId) return;
  try {
    const { getNativeOnDeviceModelBridge } = await import(
      "@/lib/nativeOnDeviceModelBridge"
    );
    const bridge = getNativeOnDeviceModelBridge();
    if (typeof bridge?.cancelRequest === "function") {
      await Promise.resolve(bridge.cancelRequest(requestId));
    }
  } catch {
    // Best-effort cancellation must not crash chat or unmount cleanup.
  }
}

function formatHistoryTime(value?: string | null) {
  if (!value) return "Just now";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getHistoryTitle(item: ChatHistoryItem) {
  const title = String(item.title || "").trim();
  if (title) return title;

  const raw = String(item.raw_text || "").trim();
  if (raw) return raw;

  return item.source === "text" ? "Chat" : "Voice note";
}

function getHistoryPreview(item: ChatHistoryItem) {
  const details = String(item.details || "").trim();
  if (details) return details;

  const raw = String(item.raw_text || "").trim();
  if (raw) return raw;

  return "Assistant response";
}

function absoluteDownloadUrl(url?: string | null) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${API_BASE.replace(/\/$/, "")}${value}`;
  return value;
}

function firstOpenableFile(item: ChatHistoryItem, source: "files" | "any" = "any") {
  const files = source === "files" ? item.files || [] : [...(item.files || []), ...(item.artifacts || [])];
  return files.find((file) => absoluteDownloadUrl(file.download_url || file.download?.download_url));
}

function openReturnedFile(file: ReturnType<typeof firstOpenableFile>) {
  const url = absoluteDownloadUrl(file?.download_url || file?.download?.download_url);
  if (!url) return;
  Linking.openURL(url).catch(() => {
    Alert.alert("File", "Could not open this file link.");
  });
}

function sessionTimeValue(value?: string | null) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortSessionsByRecent(a: ChatSessionRecord, b: ChatSessionRecord) {
  return (
    sessionTimeValue(b.updatedAt || b.createdAt) - sessionTimeValue(a.updatedAt || a.createdAt)
  );
}

function normalizeChatSessionRecord(value: unknown): ChatSessionRecord | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<ChatSessionRecord>;
  const id = String(raw.id || "").trim();
  if (!id) return null;

  const itemIds = uniqueNumberList(Array.isArray(raw.itemIds) ? raw.itemIds : []);
  const createdAt = String(raw.createdAt || raw.updatedAt || new Date().toISOString());
  const updatedAt = String(raw.updatedAt || raw.createdAt || createdAt);

  return {
    id,
    itemIds,
    createdAt,
    updatedAt,
    title: typeof raw.title === "string" ? raw.title : null,
  };
}

function createChatSessionFromItem(item: ChatHistoryItem): ChatSessionRecord {
  const timestamp = item.created_at || item.datetime || new Date().toISOString();
  return {
    id: `chat_${Number(item.id) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    itemIds: [Number(item.id)],
    createdAt: timestamp,
    updatedAt: timestamp,
    title: getHistoryTitle(item),
  };
}

function reconcileChatSessions(
  items: ChatHistoryItem[],
  sessions: ChatSessionRecord[]
): ChatSessionRecord[] {
  const itemMap = new Map<number, ChatHistoryItem>();
  items.forEach((item) => {
    const itemId = Number(item.id);
    if (Number.isFinite(itemId)) {
      itemMap.set(itemId, item);
    }
  });

  const claimedItemIds = new Set<number>();
  const normalizedSessions: ChatSessionRecord[] = [];

  sessions.forEach((value) => {
    const session = normalizeChatSessionRecord(value);
    if (!session) return;

    const itemIds = session.itemIds.filter((itemId) => {
      if (!itemMap.has(itemId) || claimedItemIds.has(itemId)) return false;
      claimedItemIds.add(itemId);
      return true;
    });

    if (!itemIds.length) return;

    const firstItem = itemMap.get(itemIds[0]);
    const lastItem = itemMap.get(itemIds[itemIds.length - 1]);
    normalizedSessions.push({
      ...session,
      itemIds,
      createdAt:
        session.createdAt || firstItem?.created_at || firstItem?.datetime || new Date().toISOString(),
      updatedAt:
        lastItem?.created_at ||
        lastItem?.datetime ||
        session.updatedAt ||
        session.createdAt ||
        new Date().toISOString(),
      title: session.title || (firstItem ? getHistoryTitle(firstItem) : "Chat"),
    });
  });

  const migratedSessions = items
    .filter((item) => {
      const itemId = Number(item.id);
      return Number.isFinite(itemId) && !claimedItemIds.has(itemId);
    })
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((item) => createChatSessionFromItem(item));

  return [...normalizedSessions, ...migratedSessions].sort(sortSessionsByRecent);
}

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name, settings, profile, updateSettings } = useAssistant();
  const { signOutUser } = useAuth();
  const voiceOnlyMode = useMemo(() => getMobileBuildInfo().voice_only_mode, []);
  const e2eHandsFreeEnabled = useMemo(() => isE2eMockHandsFreeEnabled(), []);
  const e2eHandsFreeWakePhrase = useMemo(() => getE2eHandsFreeWakePhrase(), []);
  const e2eHandsFreeCommand = useMemo(() => getE2eHandsFreeCommand(), []);

  const [text, setText] = useState("");
  const [composerInputHeight, setComposerInputHeight] =
    useState(MIN_INPUT_HEIGHT);
  const [composerHeight, setComposerHeight] = useState(0);
  const [keyboardState, setKeyboardState] = useState({
    visible: false,
    height: 0,
  });
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingPreparing, setRecordingPreparing] = useState(false);
  const [recordingStopping, setRecordingStopping] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingReminder, setPendingReminder] =
    useState<PendingReminder | null>(null);
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionRecord[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [activeSurface, setActiveSurface] = useState<RecorderSurface | null>(
    null
  );
  const [activeVoiceSessionId, setActiveVoiceSessionId] = useState<string | null>(null);
  const [voiceSessionTurns, setVoiceSessionTurns] = useState<VoiceSessionTurn[]>([]);
  const [voiceSessionMode, setVoiceSessionMode] = useState<VoiceSessionMode>(null);
  const [voiceLastReplyText, setVoiceLastReplyText] = useState("");
  const [voiceReplyStatus, setVoiceReplyStatus] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [hiddenChatSessionIds, setHiddenChatSessionIds] = useState<string[]>([]);
  const [hiddenChatItemIds, setHiddenChatItemIds] = useState<number[]>([]);
  const [chatActionsOpen, setChatActionsOpen] = useState(false);
  const [selectedHistoryItem, setSelectedHistoryItem] =
    useState<ChatSessionListItem | null>(null);
  const [handsFreeMode, setHandsFreeMode] = useState<HandsFreeRecognizerMode>("off");
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const [handsFreeConversationActive, setHandsFreeConversationActive] = useState(false);
  const [handsFreeTranscript, setHandsFreeTranscript] = useState("");
  const [handsFreeStatus, setHandsFreeStatus] = useState("");
  const [appState, setAppState] = useState(AppState.currentState);
  const [pendingChatTurn, setPendingChatTurn] = useState<PendingChatTurn | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const replySoundRef = useRef<Audio.Sound | null>(null);
  const replyAudioUriRef = useRef<string | null>(null);
  const replyPlaybackTokenRef = useRef(0);
  const activeSurfaceRef = useRef<RecorderSurface | null>(null);
  const activeVoiceSessionIdRef = useRef<string | null>(null);
  const voiceSessionItemsPendingHistoryRef = useRef<ChatHistoryItem[]>([]);
  const recordingPhaseRef = useRef<"idle" | "starting" | "recording" | "stopping">(
    "idle"
  );
  const stopWhenReadyRef = useRef(false);
  const recordingStartCancelledRef = useRef(false);
  const voicePrepareStartedAtRef = useRef<number | null>(null);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  const voiceBusyRequestIdRef = useRef<string | null>(null);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [drawerMounted, setDrawerMounted] = useState(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const activeChatSessionIdRef = useRef<string | null>(null);
  const historyLongPressTriggeredRef = useRef(false);
  const handsFreeDesiredModeRef = useRef<HandsFreeRecognizerMode>("off");
  const handsFreeConversationActiveRef = useRef(false);
  const handsFreeStartingRef = useRef(false);
  const handsFreeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handsFreePermissionAlertedRef = useRef(false);
  const handsFreeBlockedRef = useRef(false);
  const voiceSheetOpenRef = useRef(false);
  const e2eHandsFreeConfiguredRef = useRef(false);
  const e2eHandsFreeTriggeredRef = useRef(false);
  const activeChatRequestIdRef = useRef<string | null>(null);
  const modelSetupAlertLastShownAtRef = useRef(0);
  const voiceOnlyInitialOpenRef = useRef(false);
  const historyItemsRef = useRef<ChatHistoryItem[]>([]);
  const chatSessionsRef = useRef<ChatSessionRecord[]>([]);
  const handsFreeRuntimeRef = useRef({
    busy: false,
    listening: false,
    foreground: false,
    wakePhrase: "",
    locale: "en-IN",
  });

  const layout = computeChatScreenLayout({
    screenWidth: width,
    screenHeight: height,
    safeAreaTop: insets.top,
    safeAreaBottom: insets.bottom,
    composerHeight,
    keyboardVisible: keyboardState.visible,
    keyboardHeight: keyboardState.height,
    platform: Platform.OS,
  });
  const isSmallPhone = layout.isSmallPhone;
  const horizontalPadding = layout.horizontalPadding;
  const topPadding = layout.topPadding;
  const bottomPadding = layout.composerBottomPadding;
  const contentMaxWidth = layout.contentMaxWidth;
  const drawerWidth = Math.min(width * 0.84, 360);
  const orbSize = clamp(width * 0.38, 156, 208);

  const assistantLabel = useMemo(() => (name || "Elli").trim(), [name]);
  const handsFreeWakePhrase = useMemo(
    () => (settings.wakePhrase || `Hey ${assistantLabel}`).trim(),
    [assistantLabel, settings.wakePhrase]
  );
  const handsFreeWakeVariants = useMemo(
    () =>
      buildWakePhraseCandidates(
        assistantLabel,
        handsFreeWakePhrase,
        settings.wakeTrainingSamples || []
      ),
    [assistantLabel, handsFreeWakePhrase, settings.wakeTrainingSamples]
  );
  const handsFreeWakeVariantKey = useMemo(
    () => handsFreeWakeVariants.join("|"),
    [handsFreeWakeVariants]
  );
  const handsFreeLocale = useMemo(
    () => (settings.languageMode === "ta" ? "ta-IN" : "en-IN"),
    [settings.languageMode]
  );
  const handsFreeForegroundEnabled = settings.handsFreeEnabled && appState === "active";
  handsFreeRuntimeRef.current = {
    busy,
    listening,
    foreground: handsFreeForegroundEnabled,
    wakePhrase: handsFreeWakePhrase,
    locale: handsFreeLocale,
  };
  const chatSessionStorageKey = useMemo(
    () => `${CHAT_SESSIONS_STORAGE_PREFIX}:${profile?.userId || "guest"}`,
    [profile?.userId]
  );
  const hiddenChatStorageKey = useMemo(
    () => `${HIDDEN_CHAT_SESSIONS_STORAGE_PREFIX}:${profile?.userId || "guest"}`,
    [profile?.userId]
  );
  const hiddenChatItemStorageKey = useMemo(
    () => `${HIDDEN_CHAT_ITEM_IDS_STORAGE_PREFIX}:${profile?.userId || "guest"}`,
    [profile?.userId]
  );
  const localChatItemStorageKey = useMemo(
    () => localChatItemsStorageKey(profile?.userId),
    [profile?.userId]
  );
  const hiddenChatSessionIdSet = useMemo(
    () => new Set(hiddenChatSessionIds),
    [hiddenChatSessionIds]
  );
  const historyItemsById = useMemo(() => {
    const next = new Map<number, ChatHistoryItem>();
    historyItems.forEach((item) => {
      const itemId = Number(item.id);
      if (Number.isFinite(itemId)) {
        next.set(itemId, item);
      }
    });
    return next;
  }, [historyItems]);

  useEffect(() => {
    historyItemsRef.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    chatSessionsRef.current = chatSessions;
  }, [chatSessions]);

  useEffect(() => {
    activeChatSessionIdRef.current = activeChatSessionId;
  }, [activeChatSessionId]);

  useEffect(() => {
    activeVoiceSessionIdRef.current = activeVoiceSessionId;
  }, [activeVoiceSessionId]);

  useEffect(() => {
    voiceSheetOpenRef.current = voiceSheetOpen;
  }, [voiceSheetOpen]);

  const latestHistory = useMemo(() => {
    return chatSessions
      .filter((session) => !hiddenChatSessionIdSet.has(session.id))
      .map((session) => {
        const items = session.itemIds
          .map((itemId) => historyItemsById.get(itemId))
          .filter(Boolean) as ChatHistoryItem[];

        if (!items.length) return null;

        const sortedItems = [...items].sort((a, b) => Number(a.id) - Number(b.id));
        const firstItem = sortedItems[0];
        const lastItem = sortedItems[sortedItems.length - 1];

        return {
          ...session,
          items: sortedItems,
          title: session.title || getHistoryTitle(firstItem),
          preview: getHistoryPreview(lastItem),
          sortTime:
            lastItem.created_at ||
            lastItem.datetime ||
            session.updatedAt ||
            session.createdAt ||
            new Date().toISOString(),
        } satisfies ChatSessionListItem;
      })
      .filter((session): session is ChatSessionListItem => session !== null)
      .sort((a, b) => sessionTimeValue(b.sortTime) - sessionTimeValue(a.sortTime))
      .slice(0, 40);
  }, [chatSessions, hiddenChatSessionIdSet, historyItemsById]);

  const activeChatSession = useMemo(() => {
    if (!activeChatSessionId) return null;
    return latestHistory.find((session) => session.id === activeChatSessionId) || null;
  }, [activeChatSessionId, latestHistory]);

  const chatTimeline = useMemo(
    () => activeChatSession?.items || [],
    [activeChatSession]
  );
  const activePendingChatTurn = useMemo(() => {
    if (!pendingChatTurn) return null;
    return pendingChatTurn.sessionId === activeChatSessionId ? pendingChatTurn : null;
  }, [activeChatSessionId, pendingChatTurn]);

  const filteredHistory = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) return latestHistory;

    return latestHistory.filter((session) => {
      const haystack = [
        session.title,
        session.preview,
        ...session.items.map((item) => `${item.raw_text || ""} ${item.details || ""}`),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [historySearch, latestHistory]);

  const composerPlaceholder = `Ask ${assistantLabel}`;

  const handsFreeSummaryText = recordingPreparing && activeSurface === "live"
    ? "Preparing microphone..."
    : recordingStopping && activeSurface === "live"
    ? "Sending..."
    : listening && activeSurface === "live"
      ? "Listening..."
      : handsFreeMode === "conversation"
      ? "Listening for your next question..."
      : handsFreeMode === "command"
      ? "Listening for your request…"
      : settings.handsFreeEnabled
        ? `Say "${handsFreeWakePhrase}" or tap the orb.`
        : "Hold the orb to talk.";

  const drawerTranslateX = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 24, 0],
  });

  const drawerScrimOpacity = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const clearHandsFreeRestartTimer = useCallback(() => {
    if (handsFreeRestartTimerRef.current) {
      clearTimeout(handsFreeRestartTimerRef.current);
      handsFreeRestartTimerRef.current = null;
    }
  }, []);

  const setHandsFreeRecognizerMode = useCallback((nextMode: HandsFreeRecognizerMode) => {
    handsFreeDesiredModeRef.current = nextMode;
    setHandsFreeMode(nextMode);
  }, []);

  const activateHandsFreeConversation = useCallback(() => {
    const wasVoiceSheetOpen = voiceSheetOpenRef.current;
    handsFreeConversationActiveRef.current = true;
    voiceSheetOpenRef.current = true;
    setHandsFreeConversationActive(true);
    if (!wasVoiceSheetOpen) {
      openVoiceSession();
    } else {
      setVoiceSheetOpen(true);
    }
  }, []);

  const deactivateHandsFreeConversation = useCallback((options?: { closeVoiceSheet?: boolean }) => {
    handsFreeConversationActiveRef.current = false;
    setHandsFreeConversationActive(false);
    setHandsFreeTranscript("");
    if (options?.closeVoiceSheet) {
      voiceSheetOpenRef.current = false;
      setVoiceSheetOpen(false);
    }
    if (handsFreeRuntimeRef.current.foreground && !handsFreeBlockedRef.current) {
      setHandsFreeRecognizerMode("wake");
      setHandsFreeStatus(`Say "${handsFreeRuntimeRef.current.wakePhrase}"`);
    } else {
      setHandsFreeRecognizerMode("off");
      setHandsFreeStatus("");
    }
  }, [setHandsFreeRecognizerMode]);

  const startHandsFreeRecognizer = useCallback(async (nextMode: Exclude<HandsFreeRecognizerMode, "off">) => {
    const runtime = handsFreeRuntimeRef.current;
    if (!runtime.foreground || handsFreeBlockedRef.current) return;
    if (
      runtime.busy ||
      runtime.listening ||
      replySoundRef.current ||
      handsFreeStartingRef.current
    ) {
      return;
    }

    clearHandsFreeRestartTimer();

    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      handsFreeBlockedRef.current = true;
      setHandsFreeRecognizerMode("off");
      setHandsFreeStatus("Speech recognition is unavailable on this device.");
      if (!handsFreePermissionAlertedRef.current) {
        handsFreePermissionAlertedRef.current = true;
        Alert.alert(
          "Speech recognition unavailable",
          "Speech recognition is not available on this device. Check Siri/Dictation on iPhone or the Google voice service on Android."
        );
      }
      return;
    }

    try {
      handsFreeStartingRef.current = true;

      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        handsFreeBlockedRef.current = true;
        setHandsFreeRecognizerMode("off");
        setHandsFreeStatus("Grant microphone and speech permissions in Settings to enable wake phrase mode.");
        if (!handsFreePermissionAlertedRef.current) {
          handsFreePermissionAlertedRef.current = true;
          Alert.alert(
            "Hands-free permission needed",
            "Please allow microphone and speech recognition access to use wake phrase mode."
          );
        }
        return;
      }

      const latestRuntime = handsFreeRuntimeRef.current;
      setHandsFreeRecognizerMode(nextMode);
      setHandsFreeStatus(
        nextMode === "conversation"
          ? "Listening for your next question..."
          : nextMode === "command"
            ? "Listening for your request..."
            : `Say "${latestRuntime.wakePhrase}"`
      );
      setHandsFreeTranscript("");

      const commandLikeMode = nextMode === "command" || nextMode === "conversation";
      const contextualStrings = [
        latestRuntime.wakePhrase,
        assistantLabel,
        ...handsFreeWakeVariants,
        ...(settings.wakeTrainingSamples || []),
      ].filter(Boolean);

      ExpoSpeechRecognitionModule.start({
        lang: latestRuntime.locale,
        interimResults: true,
        maxAlternatives: 1,
        continuous:
          nextMode === "wake"
            ? Platform.OS !== "android" || Number(Platform.Version) >= 33
            : false,
        requiresOnDeviceRecognition: Platform.OS === "ios",
        addsPunctuation: false,
        contextualStrings,
        iosTaskHint: commandLikeMode ? "dictation" : "confirmation",
        androidIntentOptions:
          Platform.OS === "android"
            ? {
                EXTRA_LANGUAGE_MODEL: "free_form",
                EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS:
                  commandLikeMode ? 4200 : 2600,
                EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS:
                  commandLikeMode ? 2200 : 1400,
                EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS:
                  commandLikeMode ? 1000 : 600,
              }
            : undefined,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not start hands-free listening.";
      console.warn("[hands-free]", message);
      setHandsFreeStatus(message);
    } finally {
      handsFreeStartingRef.current = false;
    }
  }, [
    assistantLabel,
    clearHandsFreeRestartTimer,
    handsFreeWakeVariants,
    setHandsFreeRecognizerMode,
    settings.wakeTrainingSamples,
  ]);

  const queueHandsFreeRestart = useCallback((
    nextMode: Exclude<HandsFreeRecognizerMode, "off"> = "wake",
    delay = 350
  ) => {
    if (!handsFreeRuntimeRef.current.foreground || handsFreeBlockedRef.current) return;

    clearHandsFreeRestartTimer();
    setHandsFreeRecognizerMode(nextMode);

    handsFreeRestartTimerRef.current = setTimeout(() => {
      void startHandsFreeRecognizer(nextMode);
    }, delay);
  }, [clearHandsFreeRestartTimer, setHandsFreeRecognizerMode, startHandsFreeRecognizer]);

  const abortHandsFreeRecognizer = useCallback(async (clearDesiredMode = false) => {
    clearHandsFreeRestartTimer();

    if (clearDesiredMode) {
      setHandsFreeRecognizerMode("off");
    }
    setHandsFreeActive(false);

    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // ignore
    }
  }, [clearHandsFreeRestartTimer, setHandsFreeRecognizerMode]);

  const shutdownHandsFree = useCallback(async (clearStatus = false) => {
    clearHandsFreeRestartTimer();
    handsFreeBlockedRef.current = false;
    handsFreeConversationActiveRef.current = false;
    setHandsFreeConversationActive(false);
    setHandsFreeRecognizerMode("off");
    setHandsFreeActive(false);

    if (clearStatus) {
      setHandsFreeStatus("");
      setHandsFreeTranscript("");
    }

    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // ignore
    }
  }, [clearHandsFreeRestartTimer, setHandsFreeRecognizerMode]);

  const resumeHandsFreeAfterAssistantTurn = useCallback((
    source?: ChatRequestSource | null,
    delay = 420,
  ) => {
    if (!handsFreeRuntimeRef.current.foreground || handsFreeBlockedRef.current) return;
    if (busy || listening || replySoundRef.current) return;

    if (
      source === "handsfree" &&
      handsFreeConversationActiveRef.current &&
      voiceSheetOpenRef.current
    ) {
      setHandsFreeStatus("Listening for your next question...");
      queueHandsFreeRestart("conversation", delay);
      return;
    }

    if (!handsFreeConversationActiveRef.current) {
      setHandsFreeStatus(`Say "${handsFreeRuntimeRef.current.wakePhrase}"`);
      queueHandsFreeRestart("wake", delay);
    }
  }, [busy, listening, queueHandsFreeRestart]);

  async function handleHandsFreeFinalTranscript(rawTranscript: string) {
    const mode = handsFreeDesiredModeRef.current;
    if (mode === "off") return;

    const transcript = cleanHandsFreeCommand(rawTranscript);
    if (!transcript) {
      queueHandsFreeRestart(mode === "wake" ? "wake" : "conversation", 180);
      return;
    }

    setHandsFreeTranscript(transcript);

    if (mode === "command" || mode === "conversation") {
      if (isHandsFreeStopCommand(transcript)) {
        setHandsFreeStatus("Hands-free paused.");
        await abortHandsFreeRecognizer(false);
        deactivateHandsFreeConversation({ closeVoiceSheet: true });
        queueHandsFreeRestart("wake", 400);
        return;
      }

      activateHandsFreeConversation();
      setHandsFreeRecognizerMode("conversation");
      setHandsFreeStatus("Working on it...");
      await abortHandsFreeRecognizer(false);
      void submitChatMessage(transcript, "handsfree");
      return;
    }

    const matched = matchWakePhrase(transcript, handsFreeWakeVariants);
    if (!matched.matched) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    activateHandsFreeConversation();
    await abortHandsFreeRecognizer(false);

    if (matched.command) {
      setHandsFreeRecognizerMode("conversation");
      setHandsFreeStatus("Working on it...");
      void submitChatMessage(matched.command, "handsfree");
      return;
    }

    setHandsFreeRecognizerMode("command");
    setHandsFreeStatus("Listening for your request...");
    queueHandsFreeRestart("command", 220);
  }

  const deleteReplyAudioFile = useCallback(async (uri?: string | null) => {
    if (!uri) return;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // Cache cleanup should not affect the visible reply state.
    }
  }, []);

  const releaseReplySound = useCallback(async (soundToRelease?: Audio.Sound | null) => {
    const target = soundToRelease ?? replySoundRef.current;
    if (!target) return;
    const cachedUri =
      !soundToRelease || replySoundRef.current === target
        ? replyAudioUriRef.current
        : null;

    if (!soundToRelease || replySoundRef.current === target) {
      replySoundRef.current = null;
      replyAudioUriRef.current = null;
    }

    try {
      target.setOnPlaybackStatusUpdate(null);
    } catch {
      // ignore
    }

    try {
      await target.stopAsync();
    } catch {
      // ignore
    }

    try {
      await target.unloadAsync();
    } catch {
      // ignore
    }

    if (replySoundRef.current === target) {
      replySoundRef.current = null;
    }

    await deleteReplyAudioFile(cachedUri);
  }, [deleteReplyAudioFile]);

  useSpeechRecognitionEvent("start", () => {
    if (handsFreeDesiredModeRef.current === "off") return;
    setHandsFreeActive(true);
  });

  useSpeechRecognitionEvent("end", () => {
    setHandsFreeActive(false);

    const nextMode = handsFreeDesiredModeRef.current;
    if (nextMode === "off") return;

    if (!handsFreeForegroundEnabled || busy || listening || replySoundRef.current) {
      return;
    }

    if (nextMode === "command" || nextMode === "conversation" || nextMode === "wake") {
      queueHandsFreeRestart(nextMode, nextMode === "wake" ? 450 : 220);
    }
  });

  useSpeechRecognitionEvent("result", (event: any) => {
    if (handsFreeDesiredModeRef.current === "off") return;

    const transcript = cleanHandsFreeCommand(
      String(event?.results?.[0]?.transcript || "")
    );
    if (!transcript) return;

    setHandsFreeTranscript(transcript);

    if (!event?.isFinal) return;
    void handleHandsFreeFinalTranscript(transcript);
  });

  useSpeechRecognitionEvent("error", (event: any) => {
    if (handsFreeDesiredModeRef.current === "off") return;

    setHandsFreeActive(false);

    if (event?.error === "aborted") {
      return;
    }

    const errorCode = String(event?.error || "").toLowerCase();

    if (
      errorCode === "not-allowed" ||
      errorCode === "service-not-allowed" ||
      errorCode === "language-not-supported"
    ) {
      handsFreeBlockedRef.current = true;
      setHandsFreeRecognizerMode("off");

      if (errorCode === "not-allowed" && !handsFreePermissionAlertedRef.current) {
        handsFreePermissionAlertedRef.current = true;
        Alert.alert(
          "Hands-free permission needed",
          "Please allow microphone and speech recognition access to use wake phrase mode."
        );
      }

      setHandsFreeStatus(
        errorCode === "language-not-supported"
          ? `Wake phrase language ${handsFreeLocale} is not supported on this device.`
          : "Grant microphone and speech permissions in Settings to use wake phrase mode."
      );
      return;
    }

    if (handsFreeConversationActiveRef.current && voiceSheetOpenRef.current) {
      setHandsFreeRecognizerMode("conversation");
      setHandsFreeStatus("Listening for your next question...");
      queueHandsFreeRestart("conversation", 500);
      return;
    }

    setHandsFreeRecognizerMode("wake");
    setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);

    if (handsFreeForegroundEnabled && !busy && !listening && !replySoundRef.current) {
      queueHandsFreeRestart("wake", 500);
    }
  });

  useEffect(() => {
    if (voiceOnlyMode && !voiceOnlyInitialOpenRef.current && !voiceSheetOpen) {
      voiceOnlyInitialOpenRef.current = true;
      openVoiceSession();
    }
  }, [voiceOnlyMode, voiceSheetOpen]);

  useEffect(() => {
    if (handsFreeForegroundEnabled) {
      handsFreeBlockedRef.current = false;
      handsFreePermissionAlertedRef.current = false;
      setHandsFreeRecognizerMode("wake");
      setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
      queueHandsFreeRestart("wake", 120);
      return;
    }

    void shutdownHandsFree(true);
  }, [
    handsFreeForegroundEnabled,
    handsFreeLocale,
    handsFreeWakePhrase,
    handsFreeWakeVariantKey,
    profile?.userId,
    queueHandsFreeRestart,
    shutdownHandsFree,
  ]);

  useEffect(() => {
    if (!handsFreeForegroundEnabled) return;

    if (busy || listening || replySoundRef.current) {
      void abortHandsFreeRecognizer(false);
      return;
    }

    if (
      !handsFreeBlockedRef.current &&
      !handsFreeActive &&
      !handsFreeStartingRef.current &&
      handsFreeDesiredModeRef.current !== "off"
    ) {
      const nextMode = handsFreeDesiredModeRef.current;
      if (nextMode === "wake" || nextMode === "command" || nextMode === "conversation") {
        queueHandsFreeRestart(nextMode, 220);
      }
    }
  }, [
    abortHandsFreeRecognizer,
    busy,
    listening,
    handsFreeForegroundEnabled,
    handsFreeActive,
    queueHandsFreeRestart,
  ]);

  useEffect(() => {
    if (!handsFreeForegroundEnabled) return;
    setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
  }, [handsFreeWakePhrase, handsFreeForegroundEnabled]);

  useEffect(() => {
    if (!e2eHandsFreeEnabled || e2eHandsFreeConfiguredRef.current) return;
    e2eHandsFreeConfiguredRef.current = true;
    void updateSettings({
      handsFreeEnabled: true,
      wakePhrase: e2eHandsFreeWakePhrase,
      wakeTrainingSamples: [e2eHandsFreeWakePhrase],
    });
  }, [
    e2eHandsFreeEnabled,
    e2eHandsFreeWakePhrase,
    updateSettings,
  ]);

  useEffect(() => {
    if (!busy && !listening && handsFreeForegroundEnabled && !handsFreeBlockedRef.current) {
      resumeHandsFreeAfterAssistantTurn(
        handsFreeConversationActiveRef.current ? "handsfree" : null,
        450,
      );
    }
  }, [busy, listening, handsFreeForegroundEnabled, resumeHandsFreeAfterAssistantTurn]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active" && activeChatRequestIdRef.current) {
        void cancelNativeRequestIfAvailable(activeChatRequestIdRef.current);
      }
      setAppState(nextState);
    });

    return () => {
      subscription.remove();
    };
  }, [releaseReplySound, shutdownHandsFree]);

  useEffect(() => {
    const handleKeyboardShow = (event: any) => {
      const keyboardHeight = Math.max(
        0,
        Number(event?.endCoordinates?.height || 0),
      );
      setKeyboardState({ visible: true, height: keyboardHeight });
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, Platform.OS === "android" ? 180 : 80);
    };
    const handleKeyboardHide = () => {
      setKeyboardState({ visible: false, height: 0 });
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 80);
    };

    const showSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      handleKeyboardShow,
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      handleKeyboardHide,
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (handsFreeRestartTimerRef.current) {
        clearTimeout(handsFreeRestartTimerRef.current);
        handsFreeRestartTimerRef.current = null;
      }
    };
  }, [releaseReplySound, shutdownHandsFree]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 120);

    return () => clearTimeout(timeout);
  }, [chatTimeline.length, listening, recordingPreparing, busy]);

  useEffect(() => {
    return () => {
      void shutdownHandsFree(true);
      void releaseReplySound();
      if (activeChatRequestIdRef.current) {
        void cancelNativeRequestIfAvailable(activeChatRequestIdRef.current);
      }

      const activeRecording = recordingRef.current;
      if (activeRecording) {
        void activeRecording.stopAndUnloadAsync().catch(() => undefined);
      }

      void Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: false,
      }).catch(() => undefined);
    };
  }, [releaseReplySound, shutdownHandsFree]);

  useEffect(() => {
    if (drawerOpen) {
      setDrawerMounted(true);
      Animated.spring(drawerProgress, {
        toValue: 1,
        damping: 22,
        mass: 0.9,
        stiffness: 190,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (!drawerMounted) {
      drawerProgress.setValue(0);
      return;
    }

    Animated.timing(drawerProgress, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setDrawerMounted(false);
      }
    });
  }, [drawerMounted, drawerOpen, drawerProgress]);

  async function resetAudioMode() {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: false,
      });
    } catch {
      // ignore
    }
  }

  const readChatHistoryFromApi = useCallback(async (): Promise<ChatHistoryItem[]> => {
    try {
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<ChatHistoryItem[]>(`/items${suffix}`);
      return Array.isArray(data) ? markChatHistoryItemsOrigin(data, "backend") : [];
    } catch {
      return [];
    }
  }, [profile?.userId]);

  const readStoredLocalChatItems = useCallback(async (): Promise<ChatHistoryItem[]> => {
    try {
      const raw = await AsyncStorage.getItem(localChatItemStorageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return markChatHistoryItemsOrigin(parsed as ChatHistoryItem[], "local");
    } catch {
      return [];
    }
  }, [localChatItemStorageKey]);

  const readStoredChatSessions = useCallback(async (): Promise<ChatSessionRecord[]> => {
    try {
      const raw = await AsyncStorage.getItem(chatSessionStorageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .map((value) => normalizeChatSessionRecord(value))
        .filter(Boolean) as ChatSessionRecord[];
    } catch {
      return [];
    }
  }, [chatSessionStorageKey]);

  const readHiddenChatSessionIds = useCallback(async (): Promise<string[]> => {
    try {
      const raw = await AsyncStorage.getItem(hiddenChatStorageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return Array.from(
        new Set(
          parsed
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        )
      );
    } catch {
      return [];
    }
  }, [hiddenChatStorageKey]);

  const readHiddenChatItemIds = useCallback(async (): Promise<number[]> => {
    try {
      const raw = await AsyncStorage.getItem(hiddenChatItemStorageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return uniqueNumberList(parsed);
    } catch {
      return [];
    }
  }, [hiddenChatItemStorageKey]);

  async function persistHiddenChatSessionIds(nextIds: string[]) {
    const normalized = Array.from(
      new Set(nextIds.map((value) => String(value || "").trim()).filter(Boolean))
    );

    setHiddenChatSessionIds(normalized);

    try {
      await AsyncStorage.setItem(hiddenChatStorageKey, JSON.stringify(normalized));
    } catch {
      // ignore storage failures
    }
  }

  async function persistHiddenChatItemIds(nextIds: number[]) {
    const normalized = uniqueNumberList(nextIds);

    setHiddenChatItemIds(normalized);

    try {
      await AsyncStorage.setItem(hiddenChatItemStorageKey, JSON.stringify(normalized));
    } catch {
      // ignore storage failures
    }
  }

  async function persistLocalChatItems(nextItems: ChatHistoryItem[]) {
    const localItems = filterLocalChatHistoryItems(nextItems);

    try {
      await AsyncStorage.setItem(localChatItemStorageKey, JSON.stringify(localItems));
    } catch {
      // ignore storage failures
    }
  }

  async function removeStoredLocalChatItemsByIds(itemIds: number[]) {
    const itemIdSet = new Set(uniqueNumberList(itemIds));
    if (!itemIdSet.size) return;

    const storedItems = await readStoredLocalChatItems();
    const nextStoredItems = storedItems.filter((item) => !itemIdSet.has(Number(item.id)));
    await persistLocalChatItems(nextStoredItems);
  }

  const bootstrapChatState = useCallback(async () => {
    const [
      itemsFromApi,
      storedLocalItems,
      storedSessions,
      storedHiddenSessionIds,
      storedHiddenItemIds,
    ] =
      await Promise.all([
        readChatHistoryFromApi(),
        readStoredLocalChatItems(),
        readStoredChatSessions(),
        readHiddenChatSessionIds(),
        readHiddenChatItemIds(),
      ]);

    const migratedHiddenItemIds = uniqueNumberList([
      ...storedHiddenItemIds,
      ...storedSessions
        .filter((session) => storedHiddenSessionIds.includes(session.id))
        .flatMap((session) => session.itemIds),
    ]);
    const migratedHiddenItemIdSet = new Set(migratedHiddenItemIds);
    const visibleItemsFromApi = filterHistoryItemsByHiddenItemIds(
      mergeChatHistoryItems(storedLocalItems, itemsFromApi),
      migratedHiddenItemIdSet
    );

    setHistoryItems(visibleItemsFromApi);
    historyItemsRef.current = visibleItemsFromApi;
    setHiddenChatSessionIds(storedHiddenSessionIds);
    setHiddenChatItemIds(migratedHiddenItemIds);

    const reconciled = reconcileChatSessions(visibleItemsFromApi, storedSessions);
    setChatSessions(reconciled);
    chatSessionsRef.current = reconciled;
    if (!activeChatSessionIdRef.current && !activeChatRequestIdRef.current) {
      setActiveChatSessionId(null);
    }

    try {
      await Promise.all([
        AsyncStorage.setItem(chatSessionStorageKey, JSON.stringify(reconciled)),
        AsyncStorage.setItem(
          hiddenChatItemStorageKey,
          JSON.stringify(migratedHiddenItemIds)
        ),
        AsyncStorage.setItem(
          localChatItemStorageKey,
          JSON.stringify(filterLocalChatHistoryItems(visibleItemsFromApi))
        ),
      ]);
    } catch {
      // ignore storage failures
    }
  }, [
    chatSessionStorageKey,
    hiddenChatItemStorageKey,
    localChatItemStorageKey,
    readChatHistoryFromApi,
    readHiddenChatItemIds,
    readHiddenChatSessionIds,
    readStoredLocalChatItems,
    readStoredChatSessions,
  ]);

  useEffect(() => {
    void bootstrapChatState();
  }, [bootstrapChatState]);

  async function refreshHistoryAndSessions(
    extraItems: ChatHistoryItem[] = [],
    hiddenItemIdsOverride?: number[],
  ) {
    const [itemsFromApi, storedLocalItems] = await Promise.all([
      readChatHistoryFromApi(),
      readStoredLocalChatItems(),
    ]);
    const mergedItems = mergeChatHistoryItems(
      historyItemsRef.current,
      storedLocalItems,
      itemsFromApi,
      extraItems,
    );
    const effectiveHiddenItemIdSet = new Set(
      uniqueNumberList(hiddenItemIdsOverride ?? hiddenChatItemIds),
    );
    const visibleMergedItems = filterHistoryItemsByHiddenItemIds(
      mergedItems,
      effectiveHiddenItemIdSet
    );

    setHistoryItems(visibleMergedItems);
    historyItemsRef.current = visibleMergedItems;

    const reconciled = reconcileChatSessions(visibleMergedItems, chatSessionsRef.current);
    setChatSessions(reconciled);
    chatSessionsRef.current = reconciled;

    try {
      await Promise.all([
        AsyncStorage.setItem(chatSessionStorageKey, JSON.stringify(reconciled)),
        AsyncStorage.setItem(
          localChatItemStorageKey,
          JSON.stringify(filterLocalChatHistoryItems(visibleMergedItems))
        ),
      ]);
    } catch {
      // ignore storage failures
    }

    return visibleMergedItems;
  }

  async function attachItemToCurrentChat(
    item: ChatHistoryItem,
    latestItems: ChatHistoryItem[]
  ) {
    const itemId = Number(item.id);
    if (!Number.isFinite(itemId)) return;

    let workingSessions = reconcileChatSessions(latestItems, chatSessionsRef.current)
      .map((session) => ({
        ...session,
        itemIds: session.itemIds.filter((value) => value !== itemId),
      }))
      .filter((session) => session.itemIds.length > 0);

    const timestamp = item.created_at || item.datetime || new Date().toISOString();

    const currentSessionId = activeChatSessionIdRef.current;

    if (currentSessionId) {
      const targetIndex = workingSessions.findIndex(
        (session) => session.id === currentSessionId
      );

      if (targetIndex >= 0) {
        const targetSession = workingSessions[targetIndex];
        workingSessions[targetIndex] = {
          ...targetSession,
          itemIds: [...targetSession.itemIds, itemId],
          updatedAt: timestamp,
          title: targetSession.title || getHistoryTitle(item),
        };
      } else {
        const nextSession = createChatSessionFromItem(item);
        workingSessions = [nextSession, ...workingSessions];
        activeChatSessionIdRef.current = nextSession.id;
        setActiveChatSessionId(nextSession.id);
      }
    } else {
      const nextSession = createChatSessionFromItem(item);
      workingSessions = [nextSession, ...workingSessions];
      activeChatSessionIdRef.current = nextSession.id;
      setActiveChatSessionId(nextSession.id);
    }

    workingSessions = workingSessions.sort(sortSessionsByRecent);
    setChatSessions(workingSessions);
    chatSessionsRef.current = workingSessions;

    try {
      await AsyncStorage.setItem(chatSessionStorageKey, JSON.stringify(workingSessions));
    } catch {
      // ignore storage failures
    }
  }

  function stripAssistantTrigger(input: string) {
    const cleaned = input.trim();
    if (!cleaned) return cleaned;

    const trigger = assistantLabel.toLowerCase();
    const lower = cleaned.toLowerCase();

    if (lower.startsWith(trigger)) {
      let rest = cleaned.slice(assistantLabel.length).trim();
      rest = rest.replace(/^[:,\-–—]+/, "").trim();
      return rest || cleaned;
    }

    return cleaned;
  }

  function openDrawer() {
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  function openHistoryItemActions(item: ChatSessionListItem) {
    historyLongPressTriggeredRef.current = true;
    setSelectedHistoryItem(item);
    setChatActionsOpen(true);
    void Haptics.selectionAsync().catch(() => undefined);
  }

  function closeHistoryItemActions() {
    setChatActionsOpen(false);
    setSelectedHistoryItem(null);
  }

  function deleteSelectedHistoryItem() {
    if (!selectedHistoryItem) return;

    const targetItem = selectedHistoryItem;
    const deletionGroups = classifyChatHistoryItemsForDeletion(targetItem.items);
    const deletedItemIds = deletionGroups.allItemIds;
    const nextHiddenChatSessionIds = Array.from(
      new Set([...hiddenChatSessionIds, targetItem.id])
    );
    const nextHiddenChatItemIds = uniqueNumberList([
      ...hiddenChatItemIds,
      ...deletedItemIds,
    ]);

    Alert.alert(
      "Delete chat",
      `Remove "${targetItem.title}" permanently from chat history?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (activeChatSessionId === targetItem.id) {
              activeChatSessionIdRef.current = null;
              setActiveChatSessionId(null);
            }

            const optimisticHistoryItems = filterHistoryItemsByHiddenItemIds(
              historyItemsRef.current,
              new Set(nextHiddenChatItemIds)
            );
            setHistoryItems(optimisticHistoryItems);
            historyItemsRef.current = optimisticHistoryItems;
            const optimisticSessions = chatSessionsRef.current.filter(
              (session) => session.id !== targetItem.id
            );
            setChatSessions(optimisticSessions);
            chatSessionsRef.current = optimisticSessions;

            await Promise.all([
              persistHiddenChatSessionIds(nextHiddenChatSessionIds),
              persistHiddenChatItemIds(nextHiddenChatItemIds),
              removeStoredLocalChatItemsByIds(deletionGroups.localItemIds),
            ]);

            closeHistoryItemActions();

            if (deletionGroups.backendItemIds.length) {
              try {
                await Promise.all(
                  deletionGroups.backendItemIds.map((itemId) =>
                    apiDelete(
                      `/items/${itemId}${
                        profile?.userId ? `?user_id=${profile.userId}` : ""
                      }`
                    )
                  )
                );
              } catch (error: any) {
                Alert.alert(
                  "Delete sync failed",
                  error?.message ||
                    "The chat was hidden on this device, but the server copy could not be deleted."
                );
              }
            }

            await refreshHistoryAndSessions([], nextHiddenChatItemIds);
          },
        },
      ]
    );
  }

  function closeReminderConfirm() {
    setConfirmOpen(false);
    setPendingReminder(null);
  }

  function nextChatRequestId(source: ChatRequestSource) {
    return `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function nextVoiceSessionId() {
    return `voice_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensureVoiceSession(mode: Exclude<VoiceSessionMode, null> = "live") {
    const current = activeVoiceSessionIdRef.current;
    if (current) {
      setVoiceSessionMode(mode);
      return current;
    }
    const sessionId = nextVoiceSessionId();
    activeVoiceSessionIdRef.current = sessionId;
    setActiveVoiceSessionId(sessionId);
    setVoiceSessionMode(mode);
    return sessionId;
  }

  function openVoiceSession() {
    const sessionId = nextVoiceSessionId();
    activeVoiceSessionIdRef.current = sessionId;
    voiceSheetOpenRef.current = true;
    voiceSessionItemsPendingHistoryRef.current = [];
    setActiveVoiceSessionId(sessionId);
    setVoiceSessionMode("live");
    setVoiceSessionTurns([]);
    setVoiceLastReplyText("");
    setVoiceReplyStatus("");
    setVoiceSheetOpen(true);
  }

  function updateVoiceSessionTurn(turnId: string, patch: Partial<VoiceSessionTurn>) {
    setVoiceSessionTurns((current) => {
      const index = current.findIndex((turn) => turn.id === turnId);
      if (index < 0) {
        return [
          ...current,
          {
            id: turnId,
            userText: "",
            assistantText: "",
            status: "thinking",
            ...patch,
          },
        ];
      }
      const next = [...current];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function voiceTextHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0).toString(16);
  }

  function isActiveChatRequest(requestId: string) {
    return activeChatRequestIdRef.current === requestId;
  }

  function showPendingAssistantError(
    requestId: string,
    message: string,
    fallbackUserMessage: string,
    source: ChatRequestSource,
  ) {
    setPendingChatTurn((current) => {
      if (current?.requestId === requestId) {
        return {
          ...current,
          status: "error",
          assistantText: message,
        };
      }

      return {
        requestId,
        sessionId: activeChatSessionIdRef.current,
        source,
        userMessage: fallbackUserMessage,
        assistantText: message,
        status: "error",
        createdAt: new Date().toISOString(),
      };
    });
  }

  function assistantFailureMessage(
    error: unknown,
    options: { backendFallbackAttempted?: boolean } = {},
  ) {
    if (isLocalTurnTimeoutError(error)) {
      return options.backendFallbackAttempted
        ? "The answer took too long. Please try again."
        : "Something went wrong while generating the answer. Please try again.";
    }

    const raw = error instanceof Error ? error.message : String(error || "");
    if (
      /timeout|timed out|native|on-device|local model|network request failed/i.test(raw)
    ) {
      if (options.backendFallbackAttempted) {
        return "The answer took too long. Please try again.";
      }
      return "Something went wrong while generating the answer. Please try again.";
    }

    return "Something went wrong while generating the answer. Please try again.";
  }

  function chatResponseSetupRequired(response: BackendChatResponse) {
    return Boolean(
      (response as any)?.meta?.setupRequired ||
        (response as any)?.pipeline?.meta?.setupRequired,
    );
  }

  function maybePromptModelSetup(response: BackendChatResponse) {
    if (!chatResponseSetupRequired(response)) return;
    const now = Date.now();
    if (
      modelSetupAlertLastShownAtRef.current &&
      now - modelSetupAlertLastShownAtRef.current < MODEL_SETUP_ALERT_THROTTLE_MS
    ) {
      return;
    }
    modelSetupAlertLastShownAtRef.current = now;
    const assistantText = String(response?.assistant?.text || "").trim();
    Alert.alert(
      "Local AI setup",
      assistantText || friendlyLocalTimeoutMessage(),
      [
        { text: "Not now", style: "cancel" },
        {
          text: "Open setup",
          onPress: () => router.push("/model-setup" as any),
        },
      ],
    );
  }

  function warnChatFailure(error: unknown, requestId: string, source: ChatRequestSource) {
    if (!__DEV__) return;
    const message = error instanceof Error ? error.message : String(error || "");
    console.warn("[chat-turn]", {
      requestId,
      source,
      name: (error as any)?.name || "Error",
      code: (error as any)?.code || undefined,
      message: message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"),
    });
  }

  function logClientTurn(payload: Parameters<typeof sendClientTurnLog>[0]) {
    sendClientTurnLog(payload);
    if (payload.request_id && payload.event) {
      void updateActiveWorkflowStep(String(payload.request_id), payload.event).catch(() => undefined);
    }
  }

  function safeVoiceErrorType(error: unknown, fallback = "voice_error") {
    const code =
      typeof (error as any)?.code === "string"
        ? (error as any).code
        : typeof (error as any)?.name === "string"
          ? (error as any).name
          : "";
    if (code) {
      return code.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
    }
    return fallback;
  }

  function isTtsSpeakerMisconfiguredError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("speaker") &&
      normalizedMessage.includes("not compatible") &&
      normalizedMessage.includes("tts provider returned 400")
    );
  }

  function isTooShortAudioError(error: unknown) {
    if (error instanceof VoiceRecordingTooShortError) {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error || "");
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("no speech was detected") ||
      normalizedMessage.includes("empty_transcript") ||
      normalizedMessage.includes("failed to transcribe audio")
    );
  }

  function base64DecodedByteLength(value: string) {
    const normalized = value.replace(/\s/g, "");
    if (!normalized) return 0;
    const padding = normalized.endsWith("==")
      ? 2
      : normalized.endsWith("=")
        ? 1
        : 0;
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
  }

  function uriScheme(value?: string | null) {
    const match = String(value || "").match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    return match?.[1]?.toLowerCase() || null;
  }

  function logVoiceTelemetry(
    event: string,
    details: Partial<Parameters<typeof sendClientTurnLog>[0]> = {},
  ) {
    const payload: Parameters<typeof sendClientTurnLog>[0] = {
      user_id: profile?.userId,
      route_taken: "voice",
      voice_session_id: activeVoiceSessionIdRef.current || undefined,
      ...details,
      event,
      channel: "voice",
      agent_source: "mobile",
    };
    logClientTurn(payload);
    if (__DEV__) {
      console.info("[voice-telemetry]", payload);
    }
  }

  function clearPendingAssistant(requestId: string) {
    setPendingChatTurn((current) =>
      current?.requestId === requestId ? null : current,
    );
  }

  async function getChatTurnTimeoutMs(source: ChatRequestSource) {
    try {
      const deviceInfo = await getCachedDeviceCapabilitiesLazy();
      return getLocalTurnTimeoutMs({
        source,
        deviceInfo,
        selectedTier: deviceInfo.preferredTier,
        preferredTier: deviceInfo.preferredTier,
      });
    } catch {
      return getLocalTurnTimeoutMs({ source });
    }
  }

  async function getChatTurnSoftNoticeMs(source: ChatRequestSource) {
    try {
      const deviceInfo = await getCachedDeviceCapabilitiesLazy();
      return getLocalTurnSoftNoticeMs({
        source,
        deviceInfo,
        selectedTier: deviceInfo.preferredTier,
        preferredTier: deviceInfo.preferredTier,
      });
    } catch {
      return getLocalTurnSoftNoticeMs({ source });
    }
  }

  function handleComposerLayout(event: LayoutChangeEvent) {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height || 0);
    if (nextHeight > 0 && Math.abs(nextHeight - composerHeight) > 1) {
      setComposerHeight(nextHeight);
    }
  }

  function startNewChat() {
    activeChatSessionIdRef.current = null;
    setActiveChatSessionId(null);
    setText("");
    setComposerInputHeight(MIN_INPUT_HEIGHT);
    setPendingChatTurn(null);
    setHistorySearch("");
    closeHistoryItemActions();
    closeDrawer();
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }

  function openHistoryItem(item: ChatSessionListItem) {
    closeDrawer();
    closeHistoryItemActions();
    setHistorySearch("");
    activeChatSessionIdRef.current = item.id;
    setActiveChatSessionId(item.id);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }

  function openSettings() {
    closeDrawer();
    router.push("/modal");
  }

  async function playAgentReply(
    textValue: string,
    context: AgentReplyPlaybackContext = {},
  ) {
    if (!textValue) return;

    const playbackToken = replyPlaybackTokenRef.current + 1;
    replyPlaybackTokenRef.current = playbackToken;
    const isVoiceReply = context.source === "voice";
    const isHandsFreeReply = context.source === "handsfree";
    const isSpokenVoiceReply = isVoiceReply || isHandsFreeReply;
    let cachedUri: string | null = null;
    let sound: Audio.Sound | null = null;

    await abortHandsFreeRecognizer(false);
    await releaseReplySound();

    try {
      const voiceLanguage =
        context.voiceLanguage ||
        resolveVoiceLanguageParams({
          settingsLanguageMode: settings.languageMode,
          profileReplyLanguage: profile?.replyLanguage || null,
        });
      if (isVoiceReply) {
        setVoiceReplyStatus("Preparing reply...");
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "tts_started",
          });
        }
      } else if (isHandsFreeReply) {
        setHandsFreeStatus("Preparing reply...");
      }
      logVoiceTelemetry("client_voice_reply_tts_started", {
        request_id: context.requestId,
        route_taken: "voice_reply_tts",
        voice_phase: "tts_started",
        reply_playback_phase: "tts_request",
        voice_surface: context.voiceSurface || null,
        voice_session_id: context.voiceSessionId || undefined,
        requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
        requested_speech_language: isSpokenVoiceReply ? voiceLanguage.speechLanguage : undefined,
        tts_language_code: isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined,
        tts_locale_style: isSpokenVoiceReply
          ? voiceLanguage.replyLanguage === "ta"
            ? "local_tamil"
            : "indian_english"
          : undefined,
        settings_language_mode: isSpokenVoiceReply ? settings.languageMode : undefined,
      });

      const data = await apiPost<{
        audio_base64?: string;
        speaker?: string;
        target_language_code?: string;
        locale_style?: string;
        model?: string;
      }>("/api/tts", {
        text: textValue,
        target_language_code: isSpokenVoiceReply
          ? voiceLanguage.ttsLanguageCode
          : settings.languageMode === "ta" ? "ta-IN" : "en-IN",
      });

      if (!data.audio_base64) {
        throw new Error("TTS response did not include audio.");
      }

      if (replyPlaybackTokenRef.current !== playbackToken) {
        return;
      }

      if (!FileSystem.cacheDirectory) {
        throw new Error("Audio cache directory is unavailable.");
      }

      cachedUri = `${FileSystem.cacheDirectory}voice-reply-${Date.now()}-${playbackToken}.wav`;
      await FileSystem.writeAsStringAsync(cachedUri, data.audio_base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (replyPlaybackTokenRef.current !== playbackToken) {
        await deleteReplyAudioFile(cachedUri);
        return;
      }

      sound = new Audio.Sound();

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) {
          if (replySoundRef.current === sound) {
            replySoundRef.current = null;
          }
          return;
        }

        if (status.didJustFinish) {
          if (replySoundRef.current === sound && isVoiceReply) {
            setVoiceReplyStatus("Reply ready");
            if (context.voiceSessionId) {
              updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
                ttsStatus: "reply_ready",
              });
            }
          } else if (replySoundRef.current === sound && isHandsFreeReply) {
            setHandsFreeStatus("Listening for your next question...");
          }
          void releaseReplySound(sound).finally(() => {
            resumeHandsFreeAfterAssistantTurn(context.source, 320);
          });
        }
      });

      const status = await sound.loadAsync(
        { uri: cachedUri },
        {
          shouldPlay: true,
          progressUpdateIntervalMillis: 250,
        }
      );
      if (!status.isLoaded) {
        throw new Error("TTS audio could not be loaded.");
      }

      if (replyPlaybackTokenRef.current !== playbackToken) {
        await releaseReplySound(sound);
        await deleteReplyAudioFile(cachedUri);
        return;
      }

      replySoundRef.current = sound;
      replyAudioUriRef.current = cachedUri;
      if (isVoiceReply) {
        setVoiceReplyStatus("Speaking reply...");
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "speaking",
          });
        }
      } else if (isHandsFreeReply) {
        setHandsFreeStatus("Speaking reply...");
      }
      logVoiceTelemetry("client_voice_reply_tts_completed", {
        request_id: context.requestId,
        route_taken: "voice_reply_tts",
        voice_phase: "tts_completed",
        reply_playback_phase: "loaded",
        voice_surface: context.voiceSurface || null,
        voice_session_id: context.voiceSessionId || undefined,
        requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
        tts_language_code: data.target_language_code || (isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined),
        tts_speaker: data.speaker || undefined,
        tts_locale_style: data.locale_style || undefined,
        reply_audio_bytes: base64DecodedByteLength(data.audio_base64),
        playback_uri_scheme: uriScheme(cachedUri),
      });
    } catch (error: unknown) {
      if (sound) {
        await releaseReplySound(sound);
      }
      if (cachedUri && replyAudioUriRef.current !== cachedUri) {
        await deleteReplyAudioFile(cachedUri);
      }
      if (isVoiceReply) {
        setVoiceReplyStatus(
          isTtsSpeakerMisconfiguredError(error)
            ? "Reply received, but voice playback failed. TTS speaker is misconfigured."
            : "Reply received, but voice playback failed.",
        );
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "tts_failed",
          });
        }
      } else if (isHandsFreeReply) {
        setHandsFreeStatus("Reply received, but voice playback failed.");
      }
      logVoiceTelemetry("client_voice_reply_tts_failed", {
        request_id: context.requestId,
        route_taken: "voice_reply_tts",
        voice_phase: "tts_failed",
        reply_playback_phase: "failed",
        voice_surface: context.voiceSurface || null,
        voice_session_id: context.voiceSessionId || undefined,
        playback_uri_scheme: uriScheme(cachedUri),
        error_type: safeVoiceErrorType(error, "voice_reply_tts_failed"),
        error_message: error instanceof Error ? error.message : String(error || ""),
      });
      resumeHandsFreeAfterAssistantTurn(context.source, 650);
    }
  }

  async function submitChatMessage(rawMessage: string, source: "text" | "handsfree" = "text") {
    if (!rawMessage.trim() || busy) return;

    if (!profile?.userId) {
      if (source === "handsfree") {
        setHandsFreeStatus("Finish setup to use hands-free voice.");
      }
      return;
    }

    const cleaned = stripAssistantTrigger(rawMessage);
    if (!cleaned.trim()) return;

    const requestId = nextChatRequestId(source);
    const currentSessionId = activeChatSessionIdRef.current;
    const isHandsFreeTurn =
      source === "handsfree" &&
      handsFreeConversationActiveRef.current &&
      voiceSheetOpenRef.current;
    activeChatRequestIdRef.current = requestId;
    const turnStartedAt = Date.now();
    let softNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearProgressTimers = () => {
      if (softNoticeTimer) {
        clearTimeout(softNoticeTimer);
        softNoticeTimer = null;
      }
    };

    try {
      setBusy(true);
      await markActiveWorkflow({
        requestId,
        userId: profile.userId,
        question: cleaned,
        lastStep: "client_chat_turn_started",
      }).catch(() => undefined);
      logClientTurn({
        event: "client_chat_turn_started",
        user_id: profile.userId,
        request_id: requestId,
        channel: source,
        question: cleaned,
        question_length: cleaned.length,
        agent_source: "mobile",
        route_taken: "chat_turn",
        workflow_step: "chat_turn",
        workflow_phase: "started",
        screen: "chat",
        app_state: AppState.currentState,
      });
      if (isHandsFreeTurn) {
        updateVoiceSessionTurn(requestId, {
          userText: cleaned,
          assistantText: "",
          status: "thinking",
          replyLanguage: settings.languageMode,
        });
      } else {
        setPendingChatTurn({
          requestId,
          sessionId: currentSessionId,
          source,
          userMessage: cleaned,
          status: "thinking",
          createdAt: new Date().toISOString(),
        });
      }

      if (source === "text") {
        setText("");
        setComposerInputHeight(MIN_INPUT_HEIGHT);
      } else {
        setHandsFreeStatus("Working on it…");
      }

      const [timeoutMs, softNoticeMs] = await Promise.all([
        getChatTurnTimeoutMs(source),
        getChatTurnSoftNoticeMs(source),
      ]);
      const localToBackendFallbackMs = getLocalToBackendFallbackMs();
      const chatTurnTimeoutMs = Math.max(
        timeoutMs,
        localToBackendFallbackMs + BACKEND_CHAT_FALLBACK_TIMEOUT_MS + 5_000,
      );
      softNoticeTimer = setTimeout(() => {
        setPendingChatTurn((current) =>
          current?.requestId === requestId && current.status === "thinking"
            ? {
                ...current,
                assistantText: CHAT_LOCAL_SOFT_NOTICE_MESSAGE,
              }
            : current,
        );
        if (source === "handsfree") {
          setHandsFreeStatus(CHAT_LOCAL_SOFT_NOTICE_MESSAGE);
          if (isHandsFreeTurn) {
            updateVoiceSessionTurn(requestId, {
              assistantText: CHAT_LOCAL_SOFT_NOTICE_MESSAGE,
            });
          }
        }
      }, Math.min(Math.max(softNoticeMs, 5_000), 8_000));
      const response = await withLocalTimeout(
        apiPost<BackendChatResponse>("/api/chat", {
          user_id: profile.userId,
          message: cleaned,
          reply_language: settings.languageMode,
          request_id: requestId,
          client_source: source,
        }),
        chatTurnTimeoutMs,
        {
          source,
          message: friendlyLocalTimeoutMessage(),
        },
      );
      clearProgressTimers();

      if (!isActiveChatRequest(requestId)) {
        await clearActiveWorkflow(requestId).catch(() => undefined);
        return;
      }

      const nextItem = normalizeChatTurnPayload(response, cleaned);
      clearPendingAssistant(requestId);
      if (isHandsFreeTurn) {
        updateVoiceSessionTurn(requestId, {
          userText: cleaned,
          assistantText: nextItem.details || "",
          status: "done",
          replyLanguage: settings.languageMode,
        });
      }
      const mergedHistory = await refreshHistoryAndSessions([nextItem]);
      await attachItemToCurrentChat(nextItem, mergedHistory);
      openReturnedFile(firstOpenableFile(nextItem, "files"));
      maybePromptModelSetup(response);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      logClientTurn({
        event: "client_chat_turn_rendered",
        user_id: profile.userId,
        request_id: requestId,
        channel: source,
        question: cleaned,
        answer: nextItem.details || "",
        question_length: cleaned.length,
        answer_length: (nextItem.details || "").length,
        agent_source: String((response as any)?.meta?.source || (response as any)?.pipeline?.direct_answer_source || "mobile"),
        route_taken: String((response as any)?.pipeline?.route_taken || (response as any)?.meta?.route || nextItem.intent || "chat_turn"),
        workflow_step: "chat_turn_rendered",
        workflow_phase: "completed",
        duration_ms: Date.now() - turnStartedAt,
        stage_timings: ((response as any)?.meta?.stageTimings || (response as any)?.pipeline?.meta?.stageTimings || null),
        screen: "chat",
        app_state: AppState.currentState,
      });
      await clearActiveWorkflow(requestId).catch(() => undefined);

      if (
        nextItem.details &&
        shouldAutoSpeakReply({
          source,
          autoSpeakReplies: settings.autoSpeakReplies,
          handsFreeMode,
        })
      ) {
        void playAgentReply(nextItem.details, { requestId, source });
      } else if (source === "handsfree") {
        resumeHandsFreeAfterAssistantTurn(source, 420);
      }

      if (nextItem.intent === "reminder" && nextItem.datetime) {
        setPendingReminder({
          title: nextItem.title || "Reminder",
          details: nextItem.details || nextItem.raw_text,
          datetimeText: nextItem.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (error: unknown) {
      clearProgressTimers();
      if (isActiveChatRequest(requestId)) {
        if (isLocalTurnTimeoutError(error)) {
          let backendFallbackError: unknown = null;
          void cancelNativeRequestIfAvailable(requestId);
          logClientTurn({
            event: "client_local_turn_failed",
            user_id: profile.userId,
            request_id: requestId,
            channel: source,
            question: cleaned,
            question_length: cleaned.length,
            agent_source: "local_model",
            route_taken: "local_answer",
            workflow_step: "chat_turn",
            workflow_phase: "failed",
            fallback_reason: "local_timeout",
            error_type: "local_timeout",
            duration_ms: Date.now() - turnStartedAt,
            screen: "chat",
            app_state: AppState.currentState,
          });
          if (await loadCloudFallbackConsent().catch(() => false)) {
            try {
              logClientTurn({
                event: "client_backend_fallback_started",
                user_id: profile.userId,
                request_id: requestId,
                channel: source,
                question: cleaned,
                question_length: cleaned.length,
                agent_source: "backend_openai",
                route_taken: "fallback_openai",
                workflow_step: "backend_fallback",
                workflow_phase: "started",
                fallback_reason: "local_timeout",
                screen: "chat",
                app_state: AppState.currentState,
              });
              const backendResponse = await apiPostBackendOnly<BackendChatResponse>(
                "/api/chat",
                {
                  user_id: profile.userId,
                  message: cleaned,
                  reply_language: settings.languageMode,
                  request_id: requestId,
                  client_source: source,
                  client_fallback_reason: "local_timeout",
                  client_local_budget_ms: getLocalToBackendFallbackMs(),
                  client_original_route: "local_answer",
                },
                { timeoutMs: BACKEND_CHAT_FALLBACK_TIMEOUT_MS },
              );
              if (!isActiveChatRequest(requestId)) {
                await clearActiveWorkflow(requestId).catch(() => undefined);
                return;
              }
              const nextItem = normalizeChatTurnPayload(backendResponse, cleaned);
              clearPendingAssistant(requestId);
              if (isHandsFreeTurn) {
                updateVoiceSessionTurn(requestId, {
                  userText: cleaned,
                  assistantText: nextItem.details || "",
                  status: "done",
                  replyLanguage: settings.languageMode,
                });
              }
              const mergedHistory = await refreshHistoryAndSessions([nextItem]);
              await attachItemToCurrentChat(nextItem, mergedHistory);
              openReturnedFile(firstOpenableFile(nextItem, "files"));
              maybePromptModelSetup(backendResponse);
              logClientTurn({
                event: "client_backend_fallback_completed",
                user_id: profile.userId,
                request_id: requestId,
                channel: source,
                question: cleaned,
                answer: nextItem.details || "",
                question_length: cleaned.length,
                answer_length: (nextItem.details || "").length,
                agent_source: "backend_openai",
                route_taken: "fallback_openai",
                workflow_step: "backend_fallback",
                workflow_phase: "completed",
                fallback_reason: "local_timeout",
                duration_ms: Date.now() - turnStartedAt,
                screen: "chat",
                app_state: AppState.currentState,
              });
              logClientTurn({
                event: "client_chat_turn_rendered",
                user_id: profile.userId,
                request_id: requestId,
                channel: source,
                question: cleaned,
                answer: nextItem.details || "",
                question_length: cleaned.length,
                answer_length: (nextItem.details || "").length,
                agent_source: String((backendResponse as any)?.meta?.source || "backend_openai"),
                route_taken: String((backendResponse as any)?.pipeline?.route_taken || (backendResponse as any)?.meta?.route || "fallback_openai"),
                workflow_step: "chat_turn_rendered",
                workflow_phase: "completed",
                duration_ms: Date.now() - turnStartedAt,
                stage_timings: ((backendResponse as any)?.meta?.stageTimings || (backendResponse as any)?.pipeline?.meta?.stageTimings || null),
                screen: "chat",
                app_state: AppState.currentState,
              });
              await clearActiveWorkflow(requestId).catch(() => undefined);
              if (
                nextItem.details &&
                shouldAutoSpeakReply({
                  source,
                  autoSpeakReplies: settings.autoSpeakReplies,
                  handsFreeMode,
                })
              ) {
                void playAgentReply(nextItem.details, { requestId, source });
              } else if (source === "handsfree") {
                resumeHandsFreeAfterAssistantTurn(source, 420);
              }
              return;
            } catch (fallbackError) {
              backendFallbackError = fallbackError;
              warnChatFailure(fallbackError, requestId, source);
            }
          }
          showPendingAssistantError(
            requestId,
            backendFallbackError
              ? assistantFailureMessage(backendFallbackError, {
                  backendFallbackAttempted: true,
                })
              : friendlyLocalTimeoutMessage(),
            cleaned,
            source,
          );
          if (isHandsFreeTurn) {
            updateVoiceSessionTurn(requestId, {
              userText: cleaned,
              assistantText: backendFallbackError
                ? assistantFailureMessage(backendFallbackError, {
                    backendFallbackAttempted: true,
                  })
                : friendlyLocalTimeoutMessage(),
              status: "error",
            });
            setHandsFreeStatus("Something went wrong. Listening again...");
          }
          logClientTurn({
            event: "client_chat_turn_failed",
            user_id: profile.userId,
            request_id: requestId,
            channel: source,
            question: cleaned,
            question_length: cleaned.length,
            agent_source: "mobile",
            route_taken: "chat_turn",
            workflow_step: "chat_turn",
            workflow_phase: "failed",
            fallback_reason: "local_timeout",
            error_type: "local_timeout",
            duration_ms: Date.now() - turnStartedAt,
            screen: "chat",
            app_state: AppState.currentState,
          });
          await clearActiveWorkflow(requestId).catch(() => undefined);
          if (source === "handsfree") {
            resumeHandsFreeAfterAssistantTurn(source, 650);
          }
          return;
        }
        const message = assistantFailureMessage(error);
        showPendingAssistantError(requestId, message, cleaned, source);
        if (isHandsFreeTurn) {
          updateVoiceSessionTurn(requestId, {
            userText: cleaned,
            assistantText: message,
            status: "error",
          });
          setHandsFreeStatus("Something went wrong. Listening again...");
        }
        logClientTurn({
          event: "client_chat_turn_failed",
          user_id: profile.userId,
          request_id: requestId,
          channel: source,
          question: cleaned,
          question_length: cleaned.length,
          agent_source: "mobile",
          route_taken: "chat_turn",
          workflow_step: "chat_turn",
          workflow_phase: "failed",
          error_type: (error as any)?.name || "chat_turn_failed",
          error_name: (error as any)?.name || "Error",
          error_message: String((error as any)?.message || error || "Unknown error").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").slice(0, 240),
          duration_ms: Date.now() - turnStartedAt,
          screen: "chat",
          app_state: AppState.currentState,
        });
        await clearActiveWorkflow(requestId).catch(() => undefined);
        warnChatFailure(error, requestId, source);
        if (source === "handsfree") {
          resumeHandsFreeAfterAssistantTurn(source, 650);
        }
      }
    } finally {
      clearProgressTimers();
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
        setBusy(false);
      }

      if (handsFreeForegroundEnabled && source !== "handsfree") {
        resumeHandsFreeAfterAssistantTurn(null, 520);
      }
    }
  }

  async function handleChatSend() {
    await submitChatMessage(text, "text");
  }

  async function simulateE2eHandsFreeWakeCommand() {
    if (!e2eHandsFreeEnabled || busy) return;
    e2eHandsFreeTriggeredRef.current = true;
    const wakePhrase = e2eHandsFreeWakePhrase || handsFreeWakePhrase;
    const command = e2eHandsFreeCommand || "tell me about Spitzola";
    setHandsFreeTranscript(`${wakePhrase} ${command}`);
    activateHandsFreeConversation();
    setHandsFreeRecognizerMode("conversation");
    setHandsFreeStatus("Working on it...");
    await abortHandsFreeRecognizer(false);
    await submitChatMessage(command, "handsfree");
  }

  async function simulateE2eHandsFreeStop() {
    if (!e2eHandsFreeEnabled) return;
    e2eHandsFreeTriggeredRef.current = false;
    setHandsFreeTranscript("go to sleep");
    await handleHandsFreeFinalTranscript("go to sleep");
  }

  async function cleanupVoiceRecordingState(options?: { cancelStartup?: boolean }) {
    if (options?.cancelStartup) {
      recordingStartCancelledRef.current = true;
    }
    recordingPhaseRef.current = "idle";
    stopWhenReadyRef.current = false;
    recordingRef.current = null;
    voicePrepareStartedAtRef.current = null;
    voiceRecordingStartedAtRef.current = null;
    setRecording(null);
    setRecordingPreparing(false);
    setRecordingStopping(false);
    setListening(false);
    activeSurfaceRef.current = null;
    setActiveSurface(null);
    await resetAudioMode();
  }

  // Normal chat is intentionally text-only. Audio input belongs in the live orb
  // voice screen; do not reintroduce a composer mic without updating UX tests.
  async function startRecording(surface: RecorderSurface) {
    if (busy || recordingPhaseRef.current !== "idle") return;
    let nextRecording: Audio.Recording | null = null;

    async function cleanupLateRecording() {
      const target = nextRecording;
      nextRecording = null;
      if (!target) return;
      try {
        await target.stopAndUnloadAsync();
      } catch {
        try {
          await (target as any).unloadAsync?.();
        } catch {
          // ignore late startup cleanup failures
        }
      }
    }

    async function assertStartupActive() {
      if (!recordingStartCancelledRef.current) return;
      await cleanupLateRecording();
      throw new RecordingStartCancelledError();
    }

    try {
      await abortHandsFreeRecognizer(false);
      await releaseReplySound();
      const voiceSessionId = surface === "live" ? ensureVoiceSession("live") : null;
      recordingPhaseRef.current = "starting";
      voicePrepareStartedAtRef.current = Date.now();
      stopWhenReadyRef.current = false;
      recordingStartCancelledRef.current = false;
      activeSurfaceRef.current = surface;
      setActiveSurface(surface);
      setRecordingPreparing(true);
      setRecordingStopping(false);
      setListening(false);
      logVoiceTelemetry("client_voice_prepare_started", {
        route_taken: "voice_prepare",
        voice_phase: "preparing",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
      });

      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        logVoiceTelemetry("client_voice_prepare_failed", {
          route_taken: "voice_prepare",
          voice_phase: "permission_denied",
          voice_surface: surface,
          voice_session_id: voiceSessionId || undefined,
          duration_ms: voicePrepareStartedAtRef.current
            ? Date.now() - voicePrepareStartedAtRef.current
            : undefined,
          error_type: "microphone_permission_denied",
        });
        await cleanupVoiceRecordingState();
        Alert.alert("Mic permission needed", "Please allow microphone access.");
        return;
      }

      nextRecording = await withRecordingStartTimeout(
        (async () => {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
          });
          await assertStartupActive();

          const createdRecording = new Audio.Recording();
          nextRecording = createdRecording;
          await createdRecording.prepareToRecordAsync(
            Audio.RecordingOptionsPresets.HIGH_QUALITY
          );
          await assertStartupActive();

          await createdRecording.startAsync();
          await assertStartupActive();
          return createdRecording;
        })(),
      );
      await wait(RECORDING_STARTUP_SETTLE_MS);
      await assertStartupActive();

      recordingRef.current = nextRecording;
      setRecording(nextRecording);
      recordingPhaseRef.current = "recording";
      setRecordingPreparing(false);
      if (!stopWhenReadyRef.current) {
        setRecordingStopping(false);
      }
      setListening(true);
      const prepareDurationMs = voicePrepareStartedAtRef.current
        ? Date.now() - voicePrepareStartedAtRef.current
        : undefined;
      voiceRecordingStartedAtRef.current = Date.now();
      logVoiceTelemetry("client_voice_prepare_completed", {
        route_taken: "voice_prepare",
        voice_phase: "ready",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        duration_ms: prepareDurationMs,
      });
      logVoiceTelemetry("client_voice_recording_started", {
        route_taken: "voice_recording",
        voice_phase: "recording",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (stopWhenReadyRef.current) {
        stopWhenReadyRef.current = false;
        await stopAndAnalyze();
      }
    } catch (error: unknown) {
      recordingStartCancelledRef.current = true;
      await cleanupLateRecording();
      if (error instanceof RecordingStartCancelledError) {
        await cleanupVoiceRecordingState();
        return;
      }
      logVoiceTelemetry("client_voice_prepare_failed", {
        route_taken: "voice_prepare",
        voice_phase:
          error instanceof RecordingStartTimeoutError ? "startup_timeout" : "prepare_failed",
        voice_surface: surface,
        voice_session_id: surface === "live" ? activeVoiceSessionIdRef.current || undefined : undefined,
        duration_ms: voicePrepareStartedAtRef.current
          ? Date.now() - voicePrepareStartedAtRef.current
          : undefined,
        error_type:
          error instanceof RecordingStartTimeoutError
            ? "local_timeout"
            : safeVoiceErrorType(error, "voice_prepare_failed"),
      });
      await cleanupVoiceRecordingState();
      const message =
        error instanceof RecordingStartTimeoutError
          ? MIC_START_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Could not start recording.";
      Alert.alert("Error", message);
    }
  }

  async function stopAndAnalyze() {
    if (recordingPhaseRef.current === "starting") {
      if (!stopWhenReadyRef.current) {
        logVoiceTelemetry("client_voice_release_queued", {
          route_taken: "voice_prepare",
          voice_phase: "stop_when_ready",
          duration_ms: voicePrepareStartedAtRef.current
            ? Date.now() - voicePrepareStartedAtRef.current
            : undefined,
        });
      }
      stopWhenReadyRef.current = true;
      setRecordingPreparing(false);
      setRecordingStopping(true);
      return;
    }

    if (recordingPhaseRef.current === "stopping") {
      return;
    }

    if (stopWhenReadyRef.current && recordingPhaseRef.current !== "recording") {
      return;
    }

    const activeRecording = recordingRef.current;
    if (!activeRecording || recordingPhaseRef.current !== "recording") {
      if (recordingPhaseRef.current !== "idle") {
        await cleanupVoiceRecordingState();
      }
      return;
    }

    const requestId = nextChatRequestId("voice");
    activeChatRequestIdRef.current = requestId;
    voiceBusyRequestIdRef.current = requestId;
    let uploadStarted = false;
    let audioFileSize: number | undefined;
    const requestVoiceSurface = activeSurfaceRef.current ?? activeSurface ?? "live";
    const voiceSessionId = ensureVoiceSession("live");
    const recordingDurationMs = voiceRecordingStartedAtRef.current
      ? Date.now() - voiceRecordingStartedAtRef.current
      : undefined;

    try {
      recordingPhaseRef.current = "stopping";
      stopWhenReadyRef.current = false;
      setRecordingStopping(true);
      setBusy(true);
      updateVoiceSessionTurn(requestId, {
        userText: "Voice message",
        assistantText: "",
        status: "thinking",
        replyLanguage: settings.languageMode,
      });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      recordingRef.current = null;
      setRecording(null);
      setRecordingPreparing(false);
      setListening(false);

      await activeRecording.stopAndUnloadAsync();
      await resetAudioMode();

      const uri = activeRecording.getURI();
      if (!uri) throw new Error("No audio file URI");
      const audioInfo = await assertUsableAudioFile(uri);
      audioFileSize = Number((audioInfo as any).size || 0) || undefined;
      logVoiceTelemetry("client_voice_recording_stopped", {
        request_id: requestId,
        route_taken: "voice_recording",
        voice_phase: "stopped",
        voice_surface: requestVoiceSurface,
        voice_session_id: voiceSessionId || undefined,
        duration_ms: recordingDurationMs,
        file_size: audioFileSize,
        mime_type: "audio/m4a",
      });

      try {
        assertMinimumVoiceRecordingDuration(recordingDurationMs);
      } catch (error) {
        if (error instanceof VoiceRecordingTooShortError) {
          logVoiceTelemetry("client_voice_recording_too_short", {
            request_id: requestId,
            route_taken: "voice_file_validation",
            voice_phase: "too_short",
            voice_surface: requestVoiceSurface,
            voice_session_id: voiceSessionId || undefined,
            duration_ms: recordingDurationMs,
            min_duration_ms: MIN_VOICE_RECORDING_MS,
            file_size: audioFileSize,
            mime_type: "audio/m4a",
          });
        }
        throw error;
      }

      const form = new FormData();
      form.append(
        "file",
        {
          uri,
          name: "audio.m4a",
          type: "audio/m4a",
        } as any
      );

      const timeoutMs = await getChatTurnTimeoutMs("voice");
      const voiceLanguage = resolveVoiceLanguageParams({
        settingsLanguageMode: settings.languageMode,
        profileReplyLanguage: profile?.replyLanguage || null,
      });
      uploadStarted = true;
      logVoiceTelemetry("client_voice_upload_started", {
        request_id: requestId,
        route_taken: "voice_upload",
        voice_phase: "uploading",
        voice_surface: requestVoiceSurface,
        voice_session_id: voiceSessionId || undefined,
        file_size: audioFileSize,
        mime_type: "audio/m4a",
        requested_reply_language: voiceLanguage.replyLanguage,
        requested_speech_language: voiceLanguage.speechLanguage,
        tts_language_code: voiceLanguage.ttsLanguageCode,
        settings_language_mode: settings.languageMode,
      });
      const res = await withLocalTimeout(
        apiPostForm<BackendChatResponse | ChatHistoryItem>(
          `/api/transcribe-and-analyze?user_id=${profile?.userId ?? ""}&reply_language=${voiceLanguage.replyLanguage}&speech_language=${voiceLanguage.speechLanguage}`,
          form,
        ),
        timeoutMs,
        {
          source: "voice",
          message: friendlyLocalTimeoutMessage(),
        },
      );

      if (!isActiveChatRequest(requestId)) {
        return;
      }

      const nextItem = normalizeChatTurnPayload(res);
      const assistantReplyText = String(nextItem.details || "").trim();
      const userTranscript = String(nextItem.raw_text || nextItem.transcript || "Voice message").trim();
      if (assistantReplyText) {
        setVoiceLastReplyText(assistantReplyText);
      }
      updateVoiceSessionTurn(requestId, {
        userText: userTranscript,
        assistantText: assistantReplyText,
        status: "done",
        replyLanguage: voiceLanguage.replyLanguage,
      });
      voiceSessionItemsPendingHistoryRef.current = [
        ...voiceSessionItemsPendingHistoryRef.current,
        nextItem,
      ];
      openReturnedFile(firstOpenableFile(nextItem, "files"));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (
        assistantReplyText &&
        shouldAutoSpeakReply({
          source: "voice",
          autoSpeakReplies: settings.autoSpeakReplies,
          handsFreeMode,
          voiceSurface: requestVoiceSurface,
          voiceOnlyMode,
        })
      ) {
        void playAgentReply(assistantReplyText, {
          requestId,
          source: "voice",
          voiceSurface: requestVoiceSurface,
          voiceLanguage,
          voiceSessionId,
        });
      } else if (assistantReplyText) {
        setVoiceReplyStatus("Reply ready");
      }

      if (nextItem.intent === "reminder" && nextItem.datetime) {
        setPendingReminder({
          title: nextItem.title || "Reminder",
          details: nextItem.details || nextItem.raw_text,
          datetimeText: nextItem.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (error: unknown) {
      const tooShortAudio = isTooShortAudioError(error);
      const emptyAudio =
        error instanceof Error && error.message === EMPTY_AUDIO_MESSAGE;
      const errorType = emptyAudio
        ? "empty_audio"
        : tooShortAudio
          ? "too_short_audio"
          : safeVoiceErrorType(
              error,
              uploadStarted
                ? "voice_upload_failed"
                : "voice_file_validation_failed",
            );
      logVoiceTelemetry("client_voice_upload_failed", {
        request_id: requestId,
        route_taken: uploadStarted ? "voice_upload" : "voice_file_validation",
        voice_phase: uploadStarted ? "upload_failed" : "file_validation_failed",
        voice_surface: requestVoiceSurface,
        voice_session_id: voiceSessionId || undefined,
        file_size: audioFileSize,
        mime_type: "audio/m4a",
        error_type: errorType,
      });
      if (isActiveChatRequest(requestId)) {
        const message = emptyAudio
          ? EMPTY_AUDIO_MESSAGE
          : tooShortAudio
            ? TOO_SHORT_AUDIO_MESSAGE
            : VOICE_UNAVAILABLE_MESSAGE;
        updateVoiceSessionTurn(requestId, {
          userText: "Voice message",
          assistantText: message,
          status: "error",
        });
        setVoiceReplyStatus(message);
        warnChatFailure(error, requestId, "voice");
      }
    } finally {
      await cleanupVoiceRecordingState();
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
        if (voiceBusyRequestIdRef.current === requestId) {
          setBusy(false);
        }
      }
      if (voiceBusyRequestIdRef.current === requestId) {
        voiceBusyRequestIdRef.current = null;
      }
    }
  }

  async function closeVoiceSheetSafely() {
    if (handsFreeConversationActiveRef.current) {
      deactivateHandsFreeConversation();
      queueHandsFreeRestart("wake", 350);
    }
    const phase = recordingPhaseRef.current;
    if (phase === "starting" || phase === "recording") {
      await stopAndAnalyze();
    }
    voiceSheetOpenRef.current = false;
    setVoiceSheetOpen(false);
    const pendingItems = voiceSessionItemsPendingHistoryRef.current;
    voiceSessionItemsPendingHistoryRef.current = [];
    if (pendingItems.length) {
      await refreshHistoryAndSessions(pendingItems);
    }
    activeVoiceSessionIdRef.current = null;
    setActiveVoiceSessionId(null);
    setVoiceSessionMode(null);
    setVoiceSessionTurns([]);
  }

  async function handleLiveOrbPressIn() {
    if (busy && recordingPhaseRef.current === "idle") return;
    await startRecording("live");
  }

  async function handleLiveOrbPressOut() {
    if (activeSurface !== "live" && recordingPhaseRef.current === "idle") return;
    await stopAndAnalyze();
  }

  async function confirmScheduleReminder() {
    if (!pendingReminder || !profile?.userId) return;

    try {
      setBusy(true);
      const timezone = profile.timezone || "Asia/Kolkata";
      const parsed = await parseDatetime(pendingReminder.datetimeText, timezone);

      if (!parsed.iso || parsed.confidence < 0.35) {
        Alert.alert(
          "Confirm time",
          `I couldn’t confidently understand the time.\n\nDetected: "${pendingReminder.datetimeText}".\nPlease type a clearer time.`
        );
        closeReminderConfirm();
        return;
      }

      const when = new Date(parsed.iso);
      if (Number.isNaN(when.getTime())) {
        Alert.alert("Error", "Parsed datetime was invalid.");
        closeReminderConfirm();
        return;
      }

      if (when.getTime() < Date.now() + 30_000) {
        Alert.alert("Time is too soon", "Please choose a future time.");
        closeReminderConfirm();
        return;
      }

      const notificationsReady = await ensureNotificationsReady();
      if (!notificationsReady) {
        Alert.alert(
          "Notifications disabled",
          "Notifications are not enabled. Please enable them to receive reminders."
        );
        closeReminderConfirm();
        return;
      }

      const scheduledId = await scheduleReminder(pendingReminder.title, pendingReminder.details, when);
      if (!scheduledId) {
        Alert.alert("Error", "Could not schedule reminder. Please try again.");
        closeReminderConfirm();
        return;
      }

      await saveScheduledTask(profile.userId, {
        title: pendingReminder.title,
        details: pendingReminder.details,
        datetimeText: pendingReminder.datetimeText,
        isoDatetime: parsed.iso,
        status: "scheduled",
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Reminder set ✅", parsed.human || when.toString());
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to schedule reminder.";
      Alert.alert("Error", message);
    } finally {
      setBusy(false);
      closeReminderConfirm();
    }
  }

  async function signOut() {
    Alert.alert("Sign out", "Do you want to sign out from this account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOutUser();
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : "Failed to sign out.";
            Alert.alert("Error", message);
          }
        },
      },
    ]);
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.screen}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <View style={styles.screenColumn}>
        <View
          style={[
            styles.topBar,
            {
              width: contentMaxWidth,
              paddingTop: topPadding,
              alignSelf: "center",
            },
          ]}
        >
          <Pressable
            onPress={openDrawer}
            style={styles.iconButton}
            testID="chat-drawer-button"
            accessibilityLabel="chat-drawer-button"
            accessibilityRole="button"
          >
            <Ionicons name="menu" size={20} color={Brand.cocoa} />
          </Pressable>

          <View style={styles.topBarCenter}>
            <Text style={styles.topBarTitle}>{assistantLabel}</Text>
          </View>

          <Pressable
            onPress={openVoiceSession}
            style={styles.iconButton}
            testID="chat-voice-button"
            accessibilityLabel="chat-voice-button"
            accessibilityRole="button"
          >
            <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
          </Pressable>
        </View>

        {e2eHandsFreeEnabled ? (
          <View style={styles.e2eHandsFreeControls}>
            <Pressable
              onPress={() => {
                void simulateE2eHandsFreeWakeCommand();
              }}
              testID="e2e-hands-free-trigger-button"
              accessibilityLabel="e2e-hands-free-trigger-button"
              accessibilityRole="button"
              style={styles.e2eHandsFreeButton}
            >
              <Text style={styles.e2eHandsFreeButtonText}>E2E hands-free</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void simulateE2eHandsFreeStop();
              }}
              testID="e2e-hands-free-stop-button"
              accessibilityLabel="e2e-hands-free-stop-button"
              accessibilityRole="button"
              style={styles.e2eHandsFreeButton}
            >
              <Text style={styles.e2eHandsFreeButtonText}>E2E stop</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.chatBody}>
          <ScrollView
            ref={scrollViewRef}
            style={styles.scrollArea}
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: horizontalPadding,
              paddingTop: 8,
              paddingBottom: layout.scrollBottomPadding,
              alignItems: "center",
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              {chatTimeline.length > 0 || activePendingChatTurn ? (
                <View style={styles.chatThread}>
                  {chatTimeline.map((item) => {
                    const userMessage = String(item.raw_text || "").trim();
                    const assistantMessage = String(item.details || item.raw_text || "").trim();
                    const timeLabel = formatHistoryTime(item.created_at || item.datetime);

                    return (
                      <View key={item.id} style={styles.messagePair}>
                        {userMessage ? (
                          <View style={[styles.messageRow, styles.messageRowUser]}>
                            <View style={[styles.messageBubble, styles.userBubble]}>
                              <Text style={[styles.messageText, styles.userMessageText]}>
                                {userMessage}
                              </Text>
                            </View>
                          </View>
                        ) : null}

                        {assistantMessage ? (
                          <View style={[styles.messageRow, styles.messageRowAssistant]}>
                            <View style={styles.assistantAvatar}>
                              <Text style={styles.assistantAvatarText}>
                                {assistantLabel.slice(0, 1).toUpperCase()}
                              </Text>
                            </View>

                            <View style={styles.assistantMessageBlock}>
                              <Text style={styles.messageSender}>{assistantLabel}</Text>
                              <View style={[styles.messageBubble, styles.assistantBubble]}>
                                <Text
                                  style={[styles.messageText, styles.assistantMessageText]}
                                  testID="chat-assistant-response"
                                  accessibilityLabel="chat-assistant-response"
                                >
                                  {assistantMessage}
                                </Text>
                              </View>
                              {firstOpenableFile(item) ? (
                                <Pressable
                                  testID="chat-open-file-button"
                                  accessibilityLabel="chat-open-file-button"
                                  accessibilityRole="button"
                                  onPress={() => openReturnedFile(firstOpenableFile(item))}
                                  style={styles.fileActionButton}
                                >
                                  <Ionicons name="document-attach-outline" size={16} color={Brand.cocoa} />
                                  <Text style={styles.fileActionText}>Open file</Text>
                                </Pressable>
                              ) : null}
                              <Text style={styles.messageMeta}>{timeLabel}</Text>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}

                  {activePendingChatTurn ? (
                    <View key={activePendingChatTurn.requestId} style={styles.messagePair}>
                      <View style={[styles.messageRow, styles.messageRowUser]}>
                        <View style={[styles.messageBubble, styles.userBubble]}>
                          <Text style={[styles.messageText, styles.userMessageText]}>
                            {activePendingChatTurn.userMessage}
                          </Text>
                        </View>
                      </View>

                      <View style={[styles.messageRow, styles.messageRowAssistant]}>
                        <View style={styles.assistantAvatar}>
                          <Text style={styles.assistantAvatarText}>
                            {assistantLabel.slice(0, 1).toUpperCase()}
                          </Text>
                        </View>

                        <View style={styles.assistantMessageBlock}>
                          <Text style={styles.messageSender}>{assistantLabel}</Text>
                          <View
                            style={[
                              styles.messageBubble,
                              styles.assistantBubble,
                              activePendingChatTurn.status === "thinking" && styles.typingBubble,
                              activePendingChatTurn.status === "error" && styles.errorBubble,
                            ]}
                            testID={
                              activePendingChatTurn.status === "thinking"
                                ? "chat-thinking-indicator"
                                : "chat-assistant-response"
                            }
                            accessibilityLabel={
                              activePendingChatTurn.status === "thinking"
                                ? "chat-thinking-indicator"
                                : "chat-assistant-response"
                            }
                          >
                            {activePendingChatTurn.status === "thinking" ? (
                              <>
                                <ActivityIndicator size="small" color={Brand.cocoa} />
                                <Text style={styles.typingText}>
                                  {activePendingChatTurn.assistantText || "Thinking…"}
                                </Text>
                              </>
                            ) : (
                              <Text style={[styles.messageText, styles.assistantMessageText]}>
                                {activePendingChatTurn.assistantText ||
                                  friendlyLocalTimeoutMessage()}
                              </Text>
                            )}
                          </View>
                        </View>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}

            </View>
          </ScrollView>

          <View
            style={[
              styles.composerOverlay,
              {
                paddingHorizontal: horizontalPadding,
                paddingBottom: bottomPadding,
                bottom: layout.composerBottomOffset,
              },
            ]}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              <View style={styles.composerCard} onLayout={handleComposerLayout}>
                <View style={styles.composerMainRow}>
                  {!voiceOnlyMode ? (
                    <TextInput
                      value={text}
                      testID="chat-input"
                      accessibilityLabel="chat-input"
                      onChangeText={setText}
                      placeholder={composerPlaceholder}
                      placeholderTextColor="rgba(124, 99, 80, 0.58)"
                      multiline
                      scrollEnabled={composerInputHeight >= MAX_INPUT_HEIGHT}
                      textAlignVertical="center"
                      onContentSizeChange={(event) => {
                        const measuredHeight = Math.ceil(
                          event.nativeEvent.contentSize.height
                        );
                        const nextHeight = clamp(
                          measuredHeight,
                          MIN_INPUT_HEIGHT,
                          MAX_INPUT_HEIGHT
                        );
                        setComposerInputHeight(nextHeight);
                      }}
                      style={[
                        styles.composerInput,
                        { minHeight: Math.max(composerInputHeight, 36), height: Math.max(composerInputHeight, 36) },
                      ]}
                    />
                  ) : (
                    <Pressable
                      onPress={openVoiceSession}
                      testID="open-voice-mode-button"
                      accessibilityLabel="open-voice-mode-button"
                      accessibilityRole="button"
                      style={styles.openVoiceModeButton}
                    >
                      <Ionicons name="sparkles-outline" size={16} color={Brand.cocoa} />
                      <Text style={styles.openVoiceModeText}>Open voice mode</Text>
                    </Pressable>
                  )}

                  {!voiceOnlyMode ? (
                    <View style={styles.composerInlineActions}>
                      <Pressable
                        onPress={handleChatSend}
                        disabled={!text.trim() || busy || listening}
                        testID="chat-send-button"
                        accessibilityLabel="chat-send-button"
                        accessibilityRole="button"
                        style={[
                          styles.sendButton,
                          (!text.trim() || busy || listening) && styles.iconButtonDisabled,
                        ]}
                      >
                        {busy && !listening ? (
                          <ActivityIndicator size="small" color={Brand.cocoa} />
                        ) : (
                          <Ionicons name="arrow-up" size={18} color={Brand.cocoa} />
                        )}
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>

      <Modal
        transparent
        visible={drawerMounted}
        animationType="none"
        onRequestClose={closeDrawer}
      >
        <View style={styles.drawerRoot}>
          <Animated.View style={[styles.drawerScrim, { opacity: drawerScrimOpacity }]}>
            <Pressable style={StyleSheet.absoluteFillObject} onPress={closeDrawer} />
          </Animated.View>

          <View style={styles.drawerRow}>
            <Animated.View
              style={[
                styles.drawerPanel,
                {
                  width: drawerWidth,
                  transform: [{ translateX: drawerTranslateX }],
                },
              ]}
            >
              <LinearGradient colors={Brand.gradients.softCard} style={styles.drawerGradient}>
                <View style={styles.drawerSearchWrap}>
                  <Ionicons name="search-outline" size={18} color="rgba(124, 99, 80, 0.56)" />
                  <TextInput
                    value={historySearch}
                    onChangeText={setHistorySearch}
                    placeholder="Search chat history"
                    placeholderTextColor="rgba(124, 99, 80, 0.56)"
                    style={styles.drawerSearchInput}
                  />
                </View>

                <Pressable onPress={startNewChat} style={styles.newChatRow}>
                  <Text style={styles.newChatText}>New chat</Text>
                  <View style={styles.newChatIconWrap}>
                    <Ionicons name="create-outline" size={16} color={Brand.cocoa} />
                  </View>
                </Pressable>

                <View style={styles.drawerSectionHeader}>
                  <Text style={styles.drawerSectionTitle}>Chats</Text>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.drawerScrollContent}
                >
                  {filteredHistory.length === 0 ? (
                    <View style={styles.drawerEmptyState}>
                      <Text style={styles.drawerEmptyTitle}>
                        {historySearch.trim() ? "No matching chats" : "No history yet"}
                      </Text>
                      <Text style={styles.drawerEmptyText}>
                        {historySearch.trim()
                          ? "Try a different keyword."
                          : "Start with a text prompt or a voice recording."}
                      </Text>
                    </View>
                  ) : (
                    filteredHistory.map((item) => (
                      <Pressable
                        key={item.id}
                        onPress={() => {
                          if (historyLongPressTriggeredRef.current) {
                            historyLongPressTriggeredRef.current = false;
                            return;
                          }

                          openHistoryItem(item);
                        }}
                        onLongPress={() => openHistoryItemActions(item)}
                        delayLongPress={220}
                        style={[
                          styles.chatListItem,
                          item.id === activeChatSessionId && styles.chatListItemActive,
                        ]}
                      >
                        <View style={styles.chatListRow}>
                          <View style={styles.chatListTextWrap}>
                            <Text numberOfLines={1} style={styles.chatListTitle}>
                              {item.title}
                            </Text>
                            <Text numberOfLines={1} style={styles.chatListPreview}>
                              {item.preview}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    ))
                  )}
                </ScrollView>

                <Pressable onPress={openSettings} style={styles.settingsCard}>
                  <View style={styles.settingsIconWrap}>
                    <Ionicons name="settings-outline" size={16} color={Brand.cocoa} />
                  </View>
                  <Text style={styles.settingsText}>Settings</Text>
                </Pressable>

                <View style={styles.accountCard}>
                  <View style={styles.accountInfo}>
                    <Text style={styles.accountLabel}>ACCOUNT</Text>
                    <Text numberOfLines={1} style={styles.accountName}>
                      {profile?.name || "Your account"}
                    </Text>
                    <Text numberOfLines={1} style={styles.accountMeta}>
                      {assistantLabel} assistant
                    </Text>
                  </View>

                  <Pressable onPress={signOut} style={styles.accountSignOutButton}>
                    <Text style={styles.accountSignOutText}>Sign out</Text>
                  </Pressable>
                </View>
              </LinearGradient>
            </Animated.View>

            <Pressable style={styles.drawerDismissArea} onPress={closeDrawer} />
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={chatActionsOpen}
        animationType="slide"
        onRequestClose={closeHistoryItemActions}
      >
        <View style={styles.actionSheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeHistoryItemActions} />

          <View style={styles.actionSheetWrap}>
            <LinearGradient colors={Brand.gradients.softCard} style={styles.actionSheetCard}>
              <View style={styles.actionSheetHandle} />

              <Text numberOfLines={1} style={styles.actionSheetTitle}>
                {selectedHistoryItem ? selectedHistoryItem.title : "Chat"}
              </Text>
              <Pressable onPress={deleteSelectedHistoryItem} style={styles.actionSheetRow}>
                <View style={[styles.actionSheetIconWrap, styles.actionSheetDeleteIconWrap]}>
                  <Ionicons name="trash-outline" size={18} color="#fff5ef" />
                </View>
                <Text style={styles.actionSheetDeleteText}>Delete</Text>
              </Pressable>

              <Pressable onPress={closeHistoryItemActions} style={styles.actionSheetCancelButton}>
                <Text style={styles.actionSheetCancelText}>Cancel</Text>
              </Pressable>
            </LinearGradient>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={voiceSheetOpen}
        animationType="slide"
        onRequestClose={() => {
          void closeVoiceSheetSafely();
        }}
      >
        <LinearGradient colors={Brand.gradients.page} style={styles.voiceScreen}>
          <StatusBar style="dark" />

          <View
            style={[
              styles.voiceTopBar,
              {
                paddingTop: topPadding,
                paddingHorizontal: horizontalPadding,
              },
            ]}
          >
            <View style={styles.voiceLiveBadge}>
              <Ionicons name="radio-outline" size={12} color={Brand.cocoa} />
              <Text style={styles.voiceLiveBadgeText}>Live</Text>
            </View>

            <Pressable
              onPress={() => {
                void closeVoiceSheetSafely();
              }}
              style={styles.voiceCloseButton}
            >
              <Ionicons name="close" size={18} color={Brand.cream} />
            </Pressable>
          </View>

          <View style={styles.voiceCenter}>
            <View pointerEvents="none" style={styles.voiceOrbGlow} />
            <Orb
              listening={listening && activeSurface === "live"}
              onPressIn={() => {
                void handleLiveOrbPressIn();
              }}
              onPressOut={() => {
                void handleLiveOrbPressOut();
              }}
              size={orbSize}
            />

            <Text style={styles.voiceTitle}>
              {recordingStopping && activeSurface === "live"
                ? "Sending..."
                : recordingPreparing && activeSurface === "live"
                ? "Preparing microphone..."
                : listening && activeSurface === "live"
                  ? "Listening..."
                  : handsFreeConversationActive
                    ? "Hands-free conversation"
                  : handsFreeActive
                    ? "Hands-free ready"
                    : "Hold to Talk"}
            </Text>
            <Text style={styles.voiceSubtitle}>{handsFreeSummaryText}</Text>

            {settings.handsFreeEnabled ? (
              <View style={styles.handsFreeBadge}>
                <Ionicons
                  name={handsFreeActive ? "radio" : "radio-outline"}
                  size={14}
                  color={Brand.cocoa}
                />
                <Text style={styles.handsFreeBadgeText}>
                  {handsFreeStatus || `Say "${handsFreeWakePhrase}"`}
                </Text>
              </View>
            ) : null}

            {handsFreeTranscript ? (
              <Text numberOfLines={2} style={styles.handsFreeTranscript}>
                {handsFreeTranscript}
              </Text>
            ) : null}

            {e2eHandsFreeEnabled && handsFreeConversationActive ? (
              <Pressable
                onPress={() => {
                  void simulateE2eHandsFreeStop();
                }}
                testID="e2e-hands-free-stop-button"
                accessibilityLabel="e2e-hands-free-stop-button"
                accessibilityRole="button"
                style={styles.e2eHandsFreeButton}
              >
                <Text style={styles.e2eHandsFreeButtonText}>E2E stop</Text>
              </Pressable>
            ) : null}

            <VoiceSessionTranscript
              turns={voiceSessionMode === "live" ? voiceSessionTurns : []}
              status={voiceReplyStatus}
              replyLanguage={settings.languageMode}
            />

            {voiceReplyStatus || (voiceLastReplyText && voiceSessionTurns.length === 0) ? (
              <View style={styles.voiceReplyPanel}>
                {voiceReplyStatus ? (
                  <Text
                    testID="voice-reply-status"
                    accessibilityLabel="voice-reply-status"
                    style={styles.voiceReplyStatus}
                  >
                    {voiceReplyStatus}
                  </Text>
                ) : null}
                {voiceLastReplyText && voiceSessionTurns.length === 0 ? (
                  <Text
                    testID="voice-last-reply"
                    accessibilityLabel="voice-last-reply"
                    numberOfLines={4}
                    style={styles.voiceLastReply}
                  >
                    {voiceLastReplyText}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {(recordingPreparing || listening || recordingStopping) && activeSurface === "live" ? (
              <View style={styles.voiceWaveWrap}>
                <Waveform active={listening} />
              </View>
            ) : null}
          </View>

          <View
            style={[
              styles.voiceBottomDock,
              {
                paddingHorizontal: horizontalPadding,
                paddingBottom: bottomPadding,
              },
            ]}
          >
            <View style={styles.voiceBottomRow}>
              <Pressable
                onPress={() => {
                  void closeVoiceSheetSafely();
                }}
                style={styles.voiceDockButton}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={Brand.cocoa} />
              </Pressable>

              <View style={styles.voiceDockInput}>
                <Text numberOfLines={1} style={styles.voiceDockPlaceholder}>
                  {`Ask ${assistantLabel}`}
                </Text>
              </View>

              <Pressable
                onPress={() => {
                  void closeVoiceSheetSafely();
                }}
                style={styles.voiceDockButtonDanger}
              >
                <Ionicons
                  name={(recordingPreparing || listening || recordingStopping) && activeSurface === "live" ? "stop" : "close"}
                  size={16}
                  color={Brand.cream}
                />
              </Pressable>
            </View>
          </View>
        </LinearGradient>
      </Modal>

      <Modal
        transparent
        visible={confirmOpen}
        animationType="fade"
        onRequestClose={closeReminderConfirm}
      >
        <View style={styles.modalBackdrop}>
          <GlassCard style={styles.modalCard}>
            <View style={styles.modalIconWrap}>
              <Ionicons name="notifications-outline" size={20} color={Brand.bronze} />
            </View>

            <Text style={styles.modalTitle}>Confirm reminder</Text>
            <Text style={styles.modalSubtitle}>
              We detected a reminder request. Review the details below before
              scheduling it on the device.
            </Text>

            <View style={styles.modalInfoCard}>
              <Text style={styles.modalInfoLabel}>Title</Text>
              <Text style={styles.modalInfoValue}>
                {pendingReminder?.title || "Reminder"}
              </Text>

              <View style={{ height: 10 }} />

              <Text style={styles.modalInfoLabel}>When</Text>
              <Text style={styles.modalInfoValue}>
                {pendingReminder?.datetimeText || "No time detected"}
              </Text>
            </View>

            <View style={styles.modalActionsRow}>
              <Pressable onPress={closeReminderConfirm} style={styles.modalSecondaryButton}>
                <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
              </Pressable>

              <Pressable onPress={confirmScheduleReminder} style={styles.modalPrimaryButton}>
                <LinearGradient colors={Brand.gradients.button} style={styles.modalPrimaryGradient}>
                  <Text style={styles.modalPrimaryButtonText}>Schedule</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </GlassCard>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  screenColumn: {
    flex: 1,
    flexDirection: "column",
  },

  chatBody: {
    flex: 1,
    position: "relative",
  },

  scrollArea: {
    flex: 1,
  },

  topGlow: {
    position: "absolute",
    top: -40,
    right: -30,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255, 233, 189, 0.44)",
  },

  leftGlow: {
    position: "absolute",
    left: -80,
    top: 240,
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: "rgba(255, 217, 157, 0.28)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -40,
    alignSelf: "center",
    width: 320,
    height: 180,
    borderRadius: 999,
    backgroundColor: "rgba(215, 154, 89, 0.16)",
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
    gap: 12,
  },

  topBarCenter: {
    flex: 1,
    alignItems: "center",
  },

  topBarTitle: {
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  topBarSubtitle: {
    marginTop: 2,
    color: Brand.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },

  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  iconButtonDisabled: {
    opacity: 0.45,
  },

  e2eHandsFreeControls: {
    alignSelf: "center",
    flexDirection: "row",
    gap: 8,
    paddingBottom: 6,
  },

  e2eHandsFreeButton: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.84)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  e2eHandsFreeButtonText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
  },

  chatThread: {
    marginTop: 10,
    gap: 16,
  },

  messagePair: {
    gap: 8,
  },

  messageRow: {
    width: "100%",
    flexDirection: "row",
  },

  messageRowUser: {
    justifyContent: "flex-end",
  },

  messageRowAssistant: {
    justifyContent: "flex-start",
    alignItems: "flex-end",
    gap: 10,
  },

  assistantAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    marginBottom: 18,
  },

  assistantAvatarText: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "900",
  },

  assistantMessageBlock: {
    maxWidth: "82%",
  },

  messageSender: {
    marginLeft: 4,
    marginBottom: 6,
    color: Brand.textMuted,
    fontSize: 11,
    fontWeight: "800",
  },

  messageBubble: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  userBubble: {
    maxWidth: "82%",
    backgroundColor: Brand.cocoa,
    borderBottomRightRadius: 8,
    shadowColor: "#6f4928",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },

  assistantBubble: {
    backgroundColor: "rgba(255,255,255,0.82)",
    borderWidth: 1,
    borderColor: Brand.line,
    borderBottomLeftRadius: 8,
  },

  messageText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
  },

  userMessageText: {
    color: Brand.cream,
  },

  assistantMessageText: {
    color: Brand.ink,
  },

  messageMeta: {
    marginTop: 6,
    marginLeft: 4,
    color: Brand.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },

  fileActionButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: Brand.soft,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  fileActionText: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
  },

  typingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
  },

  typingText: {
    color: Brand.textMuted,
    fontSize: 14,
    fontWeight: "700",
  },

  errorBubble: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderColor: "rgba(180, 82, 52, 0.32)",
  },

  composerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },

  composerCard: {
    borderRadius: 26,
    backgroundColor: "rgba(255, 250, 242, 0.92)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    paddingHorizontal: 8,
    paddingVertical: 6,
    shadowColor: "#6f4928",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },

  composerMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 2,
    paddingVertical: 0,
  },

  composerInput: {
    flex: 1,
    maxHeight: MAX_INPUT_HEIGHT,
    color: Brand.ink,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 8,
  },

  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.soft,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },


  composerInlineActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  openVoiceModeButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: Brand.soft,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  openVoiceModeText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  drawerRoot: {
    flex: 1,
  },

  drawerScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(47, 33, 24, 0.18)",
  },

  drawerRow: {
    flex: 1,
    flexDirection: "row",
  },

  drawerPanel: {
    height: "100%",
  },

  drawerGradient: {
    flex: 1,
    paddingTop: 54,
    paddingHorizontal: 14,
    paddingBottom: 18,
  },

  drawerSearchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerSearchInput: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "700",
  },

  newChatRow: {
    marginTop: 14,
    minHeight: 54,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(124, 99, 80, 0.14)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
  },

  newChatText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  newChatIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(124, 99, 80, 0.32)",
    backgroundColor: "rgba(255,255,255,0.4)",
  },

  drawerSectionHeader: {
    marginTop: 18,
    marginBottom: 10,
    paddingHorizontal: 6,
  },

  drawerSectionTitle: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  drawerScrollContent: {
    gap: 6,
    paddingBottom: 14,
  },

  drawerEmptyState: {
    paddingHorizontal: 8,
    paddingVertical: 12,
  },

  drawerEmptyTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  drawerEmptyText: {
    marginTop: 6,
    color: Brand.textMuted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "600",
  },

  chatListItem: {
    minHeight: 58,
    justifyContent: "center",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },

  chatListRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  chatListTextWrap: {
    flex: 1,
  },

  chatListItemActive: {
    backgroundColor: "rgba(124, 99, 80, 0.10)",
  },

  chatListTitle: {
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },

  chatListPreview: {
    marginTop: 2,
    color: Brand.textMuted,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
  },

  settingsCard: {
    marginTop: 10,
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
  },

  settingsIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 239, 213, 0.9)",
  },

  settingsText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  accountCard: {
    marginTop: 14,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  accountInfo: {
    flex: 1,
  },

  accountLabel: {
    color: Brand.textMuted,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
  },

  accountName: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  accountMeta: {
    marginTop: 4,
    color: Brand.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },

  accountSignOutButton: {
    minWidth: 110,
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2c1d13",
  },

  accountSignOutText: {
    color: Brand.cream,
    fontSize: 14,
    fontWeight: "900",
  },

  drawerDismissArea: {
    flex: 1,
  },

  actionSheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(47, 33, 24, 0.18)",
  },

  actionSheetWrap: {
    paddingHorizontal: 12,
    paddingBottom: 16,
  },

  actionSheetCard: {
    borderRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  actionSheetHandle: {
    alignSelf: "center",
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: "rgba(124, 99, 80, 0.28)",
    marginBottom: 12,
  },

  actionSheetTitle: {
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  actionSheetSubtitle: {
    marginTop: 6,
    color: Brand.textMuted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  actionSheetRow: {
    marginTop: 18,
    minHeight: 58,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  actionSheetIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },

  actionSheetDeleteIconWrap: {
    backgroundColor: "#a34a34",
  },

  actionSheetDeleteText: {
    color: "#8b2f1f",
    fontSize: 15,
    fontWeight: "900",
  },

  actionSheetCancelButton: {
    minHeight: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  actionSheetCancelText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  voiceScreen: {
    flex: 1,
  },

  voiceTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  voiceLiveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  voiceLiveBadgeText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  voiceCloseButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.danger,
  },

  voiceCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },

  voiceOrbGlow: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    backgroundColor: "rgba(255, 227, 180, 0.34)",
  },

  voiceTitle: {
    marginTop: 24,
    color: Brand.ink,
    fontSize: 26,
    fontWeight: "900",
  },

  voiceSubtitle: {
    marginTop: 10,
    color: Brand.textMuted,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
    textAlign: "center",
    maxWidth: 300,
  },

  handsFreeBadge: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.72)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  handsFreeBadgeText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  handsFreeTranscript: {
    marginTop: 12,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
    textAlign: "center",
    maxWidth: 310,
  },

  voiceReplyPanel: {
    marginTop: 16,
    width: "100%",
    maxWidth: 340,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.72)",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },

  voiceReplyStatus: {
    color: Brand.cocoa,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "900",
  },

  voiceLastReply: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
  },

  voiceWaveWrap: {
    marginTop: 22,
    minHeight: 42,
    justifyContent: "center",
  },

  voiceBottomDock: {
    paddingTop: 8,
  },

  voiceBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  voiceDockInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.72)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  voiceDockPlaceholder: {
    color: "rgba(124, 99, 80, 0.66)",
    fontSize: 14,
    fontWeight: "700",
  },

  voiceDockButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.76)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  voiceDockButtonDanger: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.danger,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(47, 33, 24, 0.22)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },

  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 28,
    padding: 22,
  },

  modalIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 239, 213, 0.9)",
  },

  modalTitle: {
    marginTop: 18,
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  modalSubtitle: {
    marginTop: 10,
    color: Brand.textMuted,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
  },

  modalInfoCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  modalInfoLabel: {
    color: Brand.textMuted,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  modalInfoValue: {
    marginTop: 4,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "800",
  },

  modalActionsRow: {
    marginTop: 18,
    flexDirection: "row",
    gap: 12,
  },

  modalSecondaryButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.76)",
  },

  modalSecondaryButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  modalPrimaryButton: {
    flex: 1,
    borderRadius: 18,
    overflow: "hidden",
  },

  modalPrimaryGradient: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
  },

  modalPrimaryButtonText: {
    color: Brand.cream,
    fontSize: 14,
    fontWeight: "900",
  },
});
