import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
  PanResponder,
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
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Screen } from "@/components/ui";
import { AssistantCharacter } from "@/components/AssistantCharacter";
import { Orb } from "@/components/Orb";
import { BACKCHANNEL_CLIPS } from "@/assets/audio/backchannel/clips";
import {
  VoiceSessionTranscript,
  type VoiceSessionTurn,
} from "@/components/VoiceSessionTranscript";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand, Radius, Spacing, Type } from "@/constants/theme";
import { type CharacterState, type Emotion } from "@/lib/assistantCharacter";
import {
  createBackchannelController,
  type BackchannelController,
} from "@/lib/backchannel";
import { emotionFromText } from "@/lib/emotionFromText";
import {
  BACKEND_CHAT_FALLBACK_TIMEOUT_MS,
  API_BASE,
  apiDelete,
  apiGet,
  apiPost,
  apiPostBackendOnly,
  apiPostForm,
  buildChatRequestWithLifeContext,
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
  createChatSessionFromItem,
  filterHistoryItemsByHiddenItemIds,
  filterLocalChatHistoryItems,
  getChatHistoryItemKind,
  localChatItemsStorageKey,
  markChatHistoryItemsOrigin,
  mergeChatHistoryItems,
  normalizeChatSessionRecord,
  reconcileChatSessions,
  sessionTimeValue,
  sortSessionsByRecent,
  type ChatSessionKind,
  type ChatSessionRecord,
  uniqueNumberList,
} from "@/lib/chatHistory";
import { parseDatetime } from "@/lib/datetime";
import { saveScheduledTask } from "@/lib/localTaskStore";
import { getMobileBuildInfo } from "@/lib/mobileBuildInfo";
import {
  getE2eHandsFreeCommand,
  getE2eHandsFreeWakePhrase,
  isE2eMockVoiceTurnEnabled,
  isE2eMockHandsFreeAudioEnabled,
  isE2eMockHandsFreeEnabled,
} from "@/lib/e2eMode";
import {
  cleanHandsFreeCommand,
  isHandsFreeStopCommand,
} from "@/lib/handsFreeWake";
import {
  buildCommandRecognitionLocalePlan,
  isLanguageNotSupportedRecognitionError,
} from "@/lib/handsFreeCommandLocales";
import {
  handsFreeRecognizer,
  useHandsFreeRecognitionEvent,
} from "@/lib/handsFreeRecognizer";
import {
  handsFreeStateReducer,
  initialHandsFreeMachineState,
  isPermanentWakeError,
  isHandsFreeWakeEligible,
} from "@/lib/handsFreeStateMachine";
import {
  ensureWakeModel,
  createE2eHandsFreeCommandAudioEvent,
  getWakeWordStatus,
  hasHandsFreeSessionListeners,
  startHandsFreeSession,
  subscribeHandsFreeSessionEvents,
  stopHandsFreeSession,
  cancelHandsFreeCommand,
  notifyHandsFreeTtsStarted,
  notifyHandsFreeTtsCompleted,
  type HandsFreeCommandAudioEvent,
  type HandsFreeCommandEvent,
  type HandsFreeStateEvent,
  type WakeModelState,
  type WakeWordNativeError,
  type WakeWordEvent,
} from "@/lib/wakeWordEngine";
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
import { nextMouthOpenness } from "@/lib/visemeScheduler";
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

type ChatSessionListItem = Omit<ChatSessionRecord, "kind"> & {
  kind: ChatSessionKind;
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
type HandsFreePlaybackMode = "off" | "conversation";
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
const VOICE_NAV_SWIPE_MIN_DISTANCE = 72;
const VOICE_NAV_SWIPE_CAPTURE_DISTANCE = 18;
const VOICE_NAV_SWIPE_HORIZONTAL_RATIO = 1.35;
const VOICE_UNAVAILABLE_MESSAGE =
  "Voice is unavailable. Try again.";
const CHAT_LOCAL_SOFT_NOTICE_MESSAGE =
  "Still working...";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isClearHorizontalDrag(dx: number, dy: number, minDistance: number) {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  return (
    absDx >= minDistance &&
    absDx > absDy * VOICE_NAV_SWIPE_HORIZONTAL_RATIO
  );
}

function firstTouchPoint(event: any) {
  const touch = event?.nativeEvent?.changedTouches?.[0] || event?.nativeEvent?.touches?.[0];
  const pageX = Number(touch?.pageX ?? event?.nativeEvent?.pageX);
  const pageY = Number(touch?.pageY ?? event?.nativeEvent?.pageY);
  if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return null;
  return { x: pageX, y: pageY };
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

function getChatSessionKindLabel(kind: ChatSessionKind) {
  return kind === "voice" ? "Voice" : "Chat";
}

function normalizeItemForRequestSource(
  item: ChatHistoryItem,
  source: ChatRequestSource,
): ChatHistoryItem {
  if (source === "handsfree") {
    return { ...item, source: item.source || "handsfree" };
  }
  return source === "voice"
    ? { ...item, source: item.source || "voice" }
    : { ...item, source: item.source || "text" };
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

function isSameWakeModelState(
  current: WakeModelState | null,
  next: WakeModelState | null
) {
  return JSON.stringify(current) === JSON.stringify(next);
}

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name, settings, profile, updateSettings } = useAssistant();
  const { signOutUser } = useAuth();
  const voiceOnlyMode = useMemo(() => getMobileBuildInfo().voice_only_mode, []);
  const e2eHandsFreeEnabled = useMemo(() => isE2eMockHandsFreeEnabled(), []);
  const e2eVoiceTurnEnabled = useMemo(() => isE2eMockVoiceTurnEnabled(), []);
  const e2eHandsFreeAudioEnabled = useMemo(() => isE2eMockHandsFreeAudioEnabled(), []);
  const e2eHandsFreeWakePhrase = useMemo(() => getE2eHandsFreeWakePhrase(), []);

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
  const [historySearch, setHistorySearch] = useState("");
  const [hiddenChatSessionIds, setHiddenChatSessionIds] = useState<string[]>([]);
  const [hiddenChatItemIds, setHiddenChatItemIds] = useState<number[]>([]);
  const [chatActionsOpen, setChatActionsOpen] = useState(false);
  const [selectedHistoryItem, setSelectedHistoryItem] =
    useState<ChatSessionListItem | null>(null);
  const [handsFreeTranscript, setHandsFreeTranscript] = useState("");
  const [handsFreeStatus, setHandsFreeStatus] = useState("");
  const [wakeModelState, setWakeModelState] = useState<WakeModelState | null>(null);
  const [handsFreeMachine, dispatchHandsFree] = useReducer(
    handsFreeStateReducer,
    initialHandsFreeMachineState
  );
  const [appState, setAppState] = useState(AppState.currentState);
  const [pendingChatTurn, setPendingChatTurn] = useState<PendingChatTurn | null>(null);
  const [assistantEmotion, setAssistantEmotion] = useState<Emotion>("neutral");
  const [replyAudioPlaying, setReplyAudioPlaying] = useState(false);
  const [mouthOpenness, setMouthOpenness] = useState(0);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const replySoundRef = useRef<Audio.Sound | null>(null);
  const replyAudioUriRef = useRef<string | null>(null);
  const replyPlaybackTokenRef = useRef(0);
  const backchannelControllerRef = useRef<BackchannelController | null>(null);
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
  const floatingAssistantProgress = useRef(new Animated.Value(1)).current;
  const [drawerMounted, setDrawerMounted] = useState(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const activeChatSessionIdRef = useRef<string | null>(null);
  const historyLongPressTriggeredRef = useRef(false);
  const nativeHandsFreeSessionInFlightRef = useRef(false);
  const nativeHandsFreeSessionActiveRef = useRef(false);
  const nativeHandsFreeSessionStartTokenRef = useRef(0);
  const commandListeningRef = useRef(false);
  const wakeModelStateRef = useRef<WakeModelState | null>(null);
  const handsFreeMachineRef = useRef(handsFreeMachine);
  const handsFreeEligibleRef = useRef(false);
  const nativeWakeHandlerRef = useRef<(event: WakeWordEvent) => void>(() => undefined);
  const nativeStateHandlerRef = useRef<(event: HandsFreeStateEvent) => void>(() => undefined);
  const nativeCommandHandlerRef = useRef<(event: HandsFreeCommandEvent) => void | Promise<void>>(
    () => undefined,
  );
  const nativeCommandAudioHandlerRef = useRef<
    (event: HandsFreeCommandAudioEvent) => void | Promise<void>
  >(() => undefined);
  const commandLocalePlanRef = useRef<string[]>([]);
  const commandLocaleIndexRef = useRef(0);
  const voiceSheetOpenRef = useRef(false);
  const voiceSheetGenerationRef = useRef(0);
  const chatSwipeTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const voiceSwipeTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const e2eHandsFreeConfiguredRef = useRef(false);
  const e2eHandsFreeTriggeredRef = useRef(false);
  const e2eHandsFreePendingRef = useRef(false);
  const e2eHandsFreeBusyRetryCountRef = useRef(0);
  const activeChatRequestIdRef = useRef<string | null>(null);
  const modelSetupAlertLastShownAtRef = useRef(0);
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
  const assistantHeroSize = clamp(width * 0.4, 158, 212);
  const assistantFloatingSize = clamp(width * 0.17, 58, 74);

  const assistantLabel = useMemo(() => (name || "Elli").trim(), [name]);
  const handsFreeWakePhrase = useMemo(
    () => (settings.wakePhrase || `Hey ${assistantLabel}`).trim(),
    [assistantLabel, settings.wakePhrase]
  );
  const handsFreeLocale = useMemo(
    () => (settings.languageMode === "ta" ? "ta-IN" : "en-IN"),
    [settings.languageMode]
  );
  const handsFreeForegroundEnabled =
    (!e2eHandsFreeEnabled || e2eHandsFreeTriggeredRef.current) &&
    isHandsFreeWakeEligible({
      handsFreeEnabled: settings.handsFreeEnabled,
      appState,
      voiceSheetOpen,
      wakeModelReady: Boolean(wakeModelState?.ready),
    });
  const handsFreeActive =
    handsFreeMachine.state === "wakeListening" ||
    handsFreeMachine.state === "commandListening";
  const handsFreeConversationActive =
    handsFreeMachine.state === "wakeDetected" ||
    handsFreeMachine.state === "commandListening" ||
    handsFreeMachine.state === "commandReady" ||
    handsFreeMachine.state === "submitting" ||
    handsFreeMachine.state === "speaking";
  const handsFreePlaybackMode: HandsFreePlaybackMode = handsFreeConversationActive
    ? "conversation"
    : "off";
  const pressToTalkListeningActive = listening && activeSurface === "live";
  const assistantListeningActive =
    pressToTalkListeningActive || handsFreeActive || handsFreeConversationActive;
  const assistantThinkingActive =
    recordingPreparing ||
    recordingStopping ||
    busy ||
    pendingChatTurn?.status === "thinking" ||
    handsFreeMachine.state === "submitting";
  const assistantCharacterState: CharacterState = replyAudioPlaying
    ? "speaking"
    : assistantListeningActive
      ? "listening"
      : "idle";
  const assistantCharacterEmotion: Emotion =
    !replyAudioPlaying && assistantThinkingActive ? "thinking" : assistantEmotion;
  const backchannelListeningActive =
    voiceSheetOpen &&
    !replyAudioPlaying &&
    (pressToTalkListeningActive || handsFreeMachine.state === "commandListening");
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

  useEffect(() => {
    wakeModelStateRef.current = wakeModelState;
  }, [wakeModelState]);

  useEffect(() => {
    handsFreeMachineRef.current = handsFreeMachine;
  }, [handsFreeMachine]);

  useEffect(() => {
    handsFreeEligibleRef.current = handsFreeForegroundEnabled;
  }, [handsFreeForegroundEnabled]);

  useEffect(() => {
    Animated.timing(floatingAssistantProgress, {
      toValue: voiceSheetOpen ? 0 : 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [floatingAssistantProgress, voiceSheetOpen]);

  useEffect(() => {
    if (e2eVoiceTurnEnabled || e2eHandsFreeEnabled || e2eHandsFreeAudioEnabled) {
      return undefined;
    }

    const controller = createBackchannelController({
      clips: BACKCHANNEL_CLIPS,
      minGapMs: 4500,
      maxGapMs: 9000,
      volume: 0.18,
    });
    backchannelControllerRef.current = controller;

    return () => {
      backchannelControllerRef.current = null;
      void controller.dispose();
    };
  }, [e2eHandsFreeAudioEnabled, e2eHandsFreeEnabled, e2eVoiceTurnEnabled]);

  useEffect(() => {
    backchannelControllerRef.current?.setListening(backchannelListeningActive);
  }, [backchannelListeningActive]);

  useEffect(() => {
    backchannelControllerRef.current?.setTtsActive(replyAudioPlaying);
  }, [replyAudioPlaying]);

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
        const kind = session.kind || getChatHistoryItemKind(firstItem);

        return {
          ...session,
          kind,
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
  const openVoiceFromChatSwipe = useCallback(
    (dx: number, dy: number) => {
      if (
        dx <= -VOICE_NAV_SWIPE_MIN_DISTANCE &&
        isClearHorizontalDrag(dx, dy, VOICE_NAV_SWIPE_MIN_DISTANCE) &&
        !voiceSheetOpenRef.current &&
        !drawerOpen &&
        !chatActionsOpen &&
        !confirmOpen
      ) {
        openVoiceSession();
      }
    },
    [chatActionsOpen, confirmOpen, drawerOpen],
  );
  const closeVoiceFromSwipe = useCallback((dx: number, dy: number) => {
    if (
      dx >= VOICE_NAV_SWIPE_MIN_DISTANCE &&
      isClearHorizontalDrag(dx, dy, VOICE_NAV_SWIPE_MIN_DISTANCE) &&
      voiceSheetOpenRef.current
    ) {
      void closeVoiceSheetSafely();
    }
  }, []);
  const handleChatSwipeTouchStart = useCallback((event: any) => {
    chatSwipeTouchStartRef.current = firstTouchPoint(event);
  }, []);
  const handleChatSwipeTouchEnd = useCallback(
    (event: any) => {
      const start = chatSwipeTouchStartRef.current;
      chatSwipeTouchStartRef.current = null;
      const end = firstTouchPoint(event);
      if (!start || !end) return;
      openVoiceFromChatSwipe(end.x - start.x, end.y - start.y);
    },
    [openVoiceFromChatSwipe],
  );
  const handleVoiceSwipeTouchStart = useCallback((event: any) => {
    voiceSwipeTouchStartRef.current = firstTouchPoint(event);
  }, []);
  const handleVoiceSwipeTouchEnd = useCallback(
    (event: any) => {
      const start = voiceSwipeTouchStartRef.current;
      voiceSwipeTouchStartRef.current = null;
      const end = firstTouchPoint(event);
      if (!start || !end) return;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      if (
        e2eHandsFreeEnabled &&
        Math.abs(dx) < 24 &&
        Math.abs(dy) < 24 &&
        end.x >= width - 190 &&
        end.y <= topPadding + 72
      ) {
        void simulateE2eHandsFreeWakeCommand();
        return;
      }
      closeVoiceFromSwipe(dx, dy);
    },
    [closeVoiceFromSwipe, e2eHandsFreeEnabled, topPadding, width],
  );
  const chatSwipePanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          gestureState.dx < 0 &&
          isClearHorizontalDrag(
            gestureState.dx,
            gestureState.dy,
            VOICE_NAV_SWIPE_CAPTURE_DISTANCE,
          ),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          gestureState.dx < 0 &&
          isClearHorizontalDrag(
            gestureState.dx,
            gestureState.dy,
            VOICE_NAV_SWIPE_CAPTURE_DISTANCE,
          ),
        onPanResponderRelease: (_event, gestureState) => {
          openVoiceFromChatSwipe(gestureState.dx, gestureState.dy);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [openVoiceFromChatSwipe],
  );
  const voiceSwipePanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          gestureState.dx > 0 &&
          isClearHorizontalDrag(
            gestureState.dx,
            gestureState.dy,
            VOICE_NAV_SWIPE_CAPTURE_DISTANCE,
          ),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          gestureState.dx > 0 &&
          isClearHorizontalDrag(
            gestureState.dx,
            gestureState.dy,
            VOICE_NAV_SWIPE_CAPTURE_DISTANCE,
          ),
        onPanResponderRelease: (_event, gestureState) => {
          closeVoiceFromSwipe(gestureState.dx, gestureState.dy);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [closeVoiceFromSwipe],
  );

  const drawerTranslateX = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 24, 0],
  });

  const drawerScrimOpacity = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const openHandsFreeVoiceSheet = useCallback(() => {
    const wasVoiceSheetOpen = voiceSheetOpenRef.current;
    voiceSheetGenerationRef.current += 1;
    voiceSheetOpenRef.current = true;
    if (!wasVoiceSheetOpen) {
      openVoiceSession();
    } else {
      setVoiceSheetOpen(true);
    }
  }, []);

  const keepHandsFreeVoiceSheetOpen = useCallback(() => {
    voiceSheetGenerationRef.current += 1;
    voiceSheetOpenRef.current = true;
    setVoiceSheetOpen(true);
    setVoiceSessionMode("live");
  }, []);

  const resetCommandLocalePlan = useCallback(() => {
    commandLocalePlanRef.current = buildCommandRecognitionLocalePlan(
      handsFreeRuntimeRef.current.locale,
    );
    commandLocaleIndexRef.current = 0;
  }, []);

  const stopHandsFreeCommandRecognizer = useCallback(async () => {
    commandListeningRef.current = false;
    try {
      await handsFreeRecognizer.abort("handsfree-command");
    } catch {
      // ignore
    }
  }, []);

  const abortHandsFreeRecognizer = useCallback(async (_clearDesiredMode = false) => {
    nativeHandsFreeSessionStartTokenRef.current += 1;
    nativeHandsFreeSessionActiveRef.current = false;
    const deadline = Date.now() + 1500;
    while (nativeHandsFreeSessionInFlightRef.current && Date.now() < deadline) {
      await wait(25);
    }
    await stopHandsFreeSession().catch(() => undefined);
    await stopHandsFreeCommandRecognizer();
  }, [stopHandsFreeCommandRecognizer]);

  const shutdownHandsFree = useCallback(async (clearStatus = false) => {
    await abortHandsFreeRecognizer(false);
    commandLocalePlanRef.current = [];
    commandLocaleIndexRef.current = 0;
    if (clearStatus) {
      setHandsFreeStatus("");
      setHandsFreeTranscript("");
    }
  }, [abortHandsFreeRecognizer]);

  const startNativeHandsFreeSession = useCallback(async () => {
    if (e2eHandsFreeEnabled) return;

    const runtime = handsFreeRuntimeRef.current;
    if (!runtime.foreground) return;
    if (
      handsFreeMachineRef.current.state !== "wakeListening" ||
      recordingPhaseRef.current !== "idle"
    ) {
      return;
    }
    if (
      runtime.busy ||
      runtime.listening ||
      nativeHandsFreeSessionInFlightRef.current ||
      nativeHandsFreeSessionActiveRef.current
    ) {
      return;
    }

    const model = wakeModelStateRef.current;
    if (!model?.ready) {
      dispatchHandsFree({ type: "WAKE_MODEL_MISSING" });
      setHandsFreeStatus("Needs model");
      return;
    }

    try {
      nativeHandsFreeSessionInFlightRef.current = true;
      const startToken = nativeHandsFreeSessionStartTokenRef.current;
      const nativeStatus = await getWakeWordStatus().catch(() => null);
      if (startToken !== nativeHandsFreeSessionStartTokenRef.current) return;
      const nativeHandsFreeStatus = nativeStatus?.handsFree;
      const nativeSessionState = nativeHandsFreeStatus?.state || nativeStatus?.sessionState;
      if (
        nativeHandsFreeStatus?.running === true ||
        nativeHandsFreeStatus?.captureRestartScheduled === true ||
        (nativeSessionState && nativeSessionState !== "idle")
      ) {
        if (!hasHandsFreeSessionListeners()) {
          subscribeHandsFreeSessionEvents(createNativeHandsFreeEventHandlers());
        }
        nativeHandsFreeSessionActiveRef.current = true;
        setHandsFreeStatus(
          nativeHandsFreeStatus?.captureRestartScheduled ? "Recovering mic..." : "Listening",
        );
        dispatchHandsFree({ type: "WAKE_STARTED" });
        return;
      }
      const permission = await Audio.requestPermissionsAsync();
      if (startToken !== nativeHandsFreeSessionStartTokenRef.current) return;
      if (!permission.granted) {
        setHandsFreeStatus("Try again");
        dispatchHandsFree({ type: "WAKE_PERMANENT_ERROR" });
        return;
      }
      if (
        !handsFreeRuntimeRef.current.foreground ||
        handsFreeMachineRef.current.state !== "wakeListening" ||
        recordingPhaseRef.current !== "idle"
      ) {
        return;
      }

      setHandsFreeStatus("Listening");
      dispatchHandsFree({ type: "WAKE_STARTED" });
      await startHandsFreeSession(model, createNativeHandsFreeEventHandlers());
      if (
        startToken !== nativeHandsFreeSessionStartTokenRef.current ||
        handsFreeMachineRef.current.state !== "wakeListening" ||
        recordingPhaseRef.current !== "idle"
      ) {
        await stopHandsFreeSession().catch(() => undefined);
        return;
      }
      nativeHandsFreeSessionActiveRef.current = true;
    } catch (error: unknown) {
      nativeHandsFreeSessionActiveRef.current = false;
      const message =
        error instanceof Error ? error.message : "Could not start hands-free voice.";
      console.warn("[hands-free wake]", message);
      if (isPermanentWakeError(error)) {
        dispatchHandsFree({ type: "WAKE_PERMANENT_ERROR" });
      } else {
        dispatchHandsFree({ type: "WAKE_TRANSIENT_ERROR" });
      }
      setHandsFreeStatus(isPermanentWakeError(error) ? "Needs model" : "Try again");
    } finally {
      nativeHandsFreeSessionInFlightRef.current = false;
    }
  }, [e2eHandsFreeEnabled]);

  const startHandsFreeCommandRecognizer = useCallback(async () => {
    const runtime = handsFreeRuntimeRef.current;
    if (!runtime.foreground || commandListeningRef.current || runtime.busy || runtime.listening) {
      return;
    }

    if (!handsFreeRecognizer.isRecognitionAvailable()) {
      setHandsFreeStatus("Try again");
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      return;
    }

    try {
      nativeHandsFreeSessionInFlightRef.current = true;

      const permission = await handsFreeRecognizer.requestPermissionsAsync();
      if (!permission.granted) {
        setHandsFreeStatus("Try again");
        dispatchHandsFree({ type: "COMMAND_EMPTY" });
        return;
      }

      const latestRuntime = handsFreeRuntimeRef.current;
      if (!commandLocalePlanRef.current.length) {
        resetCommandLocalePlan();
      }
      const locale =
        commandLocalePlanRef.current[commandLocaleIndexRef.current] ||
        latestRuntime.locale;
      setHandsFreeStatus("Listening");
      setHandsFreeTranscript("");

      const contextualStrings = [latestRuntime.wakePhrase, assistantLabel].filter(Boolean);
      commandListeningRef.current = true;
      await handsFreeRecognizer.start("handsfree-command", {
        lang: locale,
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: Platform.OS === "ios",
        addsPunctuation: false,
        contextualStrings,
        iosTaskHint: "dictation",
        androidIntentOptions:
          Platform.OS === "android"
            ? {
                EXTRA_LANGUAGE_MODEL: "free_form",
                EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4200,
                EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2200,
                EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1000,
              }
            : undefined,
      });
    } catch (error: unknown) {
      commandListeningRef.current = false;
      const eventLike = {
        error: (error as any)?.code || (error as any)?.name,
        message: error instanceof Error ? error.message : String(error || ""),
      };
      if (
        isLanguageNotSupportedRecognitionError(eventLike) &&
        commandLocaleIndexRef.current < commandLocalePlanRef.current.length - 1
      ) {
        commandLocaleIndexRef.current += 1;
        setHandsFreeStatus("Listening");
        void startHandsFreeCommandRecognizer();
      } else {
        const message =
          error instanceof Error ? error.message : "Could not start hands-free listening.";
        console.warn("[hands-free]", message);
        setHandsFreeStatus("Try again");
        dispatchHandsFree({ type: "COMMAND_EMPTY" });
      }
    } finally {
      nativeHandsFreeSessionInFlightRef.current = false;
    }
  }, [assistantLabel, resetCommandLocalePlan]);

  function handleNativeHandsFreeState(event: HandsFreeStateEvent) {
    switch (event.state) {
      case "wakeListening":
        setHandsFreeStatus("Listening");
        dispatchHandsFree({ type: "WAKE_STARTED" });
        break;
      case "wakeDetected":
        dispatchHandsFree({ type: "WAKE_DETECTED" });
        break;
      case "commandListening":
        setHandsFreeStatus("Listening");
        dispatchHandsFree({ type: "COMMAND_STARTED" });
        break;
      case "commandReady":
        dispatchHandsFree({ type: "COMMAND_READY" });
        break;
      case "speaking":
        dispatchHandsFree({ type: "TTS_STARTED" });
        break;
      case "idle":
        nativeHandsFreeSessionActiveRef.current = false;
        break;
      default:
        break;
    }
  }

  function handleNativeHandsFreeError(error: WakeWordNativeError) {
    if ((error.restartable === true || error.sessionActive === true) && error.permanent !== true) {
      nativeHandsFreeSessionActiveRef.current = true;
      setHandsFreeStatus(error.restartable === true ? "Recovering mic..." : "Listening");
      return;
    }
    nativeHandsFreeSessionActiveRef.current = false;
    if (error.permanent === true || isPermanentWakeError(error)) {
      const value = `${String(error.code || "")} ${String(error.message || "")}`.toLowerCase();
      setHandsFreeStatus(
        value.includes("model") ||
          value.includes("missing") ||
          value.includes("unsupported") ||
          value.includes("unavailable")
          ? "Needs model"
          : "Try again",
      );
      dispatchHandsFree({ type: "WAKE_PERMANENT_ERROR" });
    } else {
      setHandsFreeStatus("Try again");
      dispatchHandsFree({ type: "WAKE_TRANSIENT_ERROR" });
    }
  }

  function createNativeHandsFreeEventHandlers() {
    return {
      onState: (event: HandsFreeStateEvent) => nativeStateHandlerRef.current(event),
      onWake: (event: WakeWordEvent) => {
        void nativeWakeHandlerRef.current(event);
      },
      onCommand: (event: HandsFreeCommandEvent) => {
        void nativeCommandHandlerRef.current(event);
      },
      onCommandAudio: (event: HandsFreeCommandAudioEvent) => {
        void nativeCommandAudioHandlerRef.current(event);
      },
      onError: handleNativeHandsFreeError,
    };
  }

  async function handleNativeWakeWordDetected(_event: WakeWordEvent) {
    if (!handsFreeEligibleRef.current) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (replySoundRef.current) {
      await releaseReplySound();
    }
    openHandsFreeVoiceSheet();
    resetCommandLocalePlan();
    setHandsFreeStatus("Listening");
  }

  nativeWakeHandlerRef.current = handleNativeWakeWordDetected;
  nativeStateHandlerRef.current = handleNativeHandsFreeState;

  async function handleNativeHandsFreeCommand(event: HandsFreeCommandEvent) {
    if (event.empty) {
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      setHandsFreeStatus("Listening");
      return;
    }
    const transcript = cleanHandsFreeCommand(String(event.text || ""));
    if (!transcript) {
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      setHandsFreeStatus("Listening");
      return;
    }
    await handleHandsFreeFinalTranscript(transcript);
  }

  async function handleNativeHandsFreeCommandAudio(event: HandsFreeCommandAudioEvent) {
    const uri = event.fileUri || event.uri;
    if (!uri) {
      await submitHandsFreeCommandAudio(event);
      return;
    }
    logVoiceTelemetry("hands-free command audio received", {
      route_taken: "handsfree_command_audio",
      voice_phase: "received",
      channel: "handsfree",
      client_source: "handsfree",
      mime_type: event.mimeType || "audio/wav",
      duration_ms: event.durationMs,
      sample_rate: event.sampleRate,
    } as any);
    openHandsFreeVoiceSheet();
    keepHandsFreeVoiceSheetOpen();
    setHandsFreeTranscript("Voice message");
    setHandsFreeStatus("Listening");
    dispatchHandsFree({ type: "COMMAND_FINAL" });
    await submitHandsFreeCommandAudio(event);
  }

  nativeCommandHandlerRef.current = handleNativeHandsFreeCommand;
  nativeCommandAudioHandlerRef.current = handleNativeHandsFreeCommandAudio;

  async function handleHandsFreeFinalTranscript(rawTranscript: string) {
    if (
      handsFreeMachineRef.current.state !== "commandListening" &&
      handsFreeMachineRef.current.state !== "commandReady"
    ) {
      return;
    }

    const transcript = cleanHandsFreeCommand(rawTranscript);
    if (!transcript) {
      await stopHandsFreeCommandRecognizer();
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      setHandsFreeStatus("Listening");
      return;
    }

    setHandsFreeTranscript(transcript);

    if (isHandsFreeStopCommand(transcript)) {
      setHandsFreeStatus("");
      await shutdownHandsFree(true);
      dispatchHandsFree({ type: "VOICE_SHEET_CLOSED" });
      voiceSheetOpenRef.current = false;
      setVoiceSheetOpen(false);
      return;
    }

    openHandsFreeVoiceSheet();
    await stopHandsFreeCommandRecognizer();
    setHandsFreeStatus("Listening");
    dispatchHandsFree({ type: "COMMAND_FINAL" });
    void submitChatMessage(transcript, "handsfree");
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
    setReplyAudioPlaying(false);
    setMouthOpenness(0);
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

  useHandsFreeRecognitionEvent("start", () => {
    if (
      handsFreeRecognizer.getOwner() === "handsfree-command" &&
      handsFreeMachineRef.current.state === "commandListening"
    ) {
      commandListeningRef.current = true;
    }
  });

  useHandsFreeRecognitionEvent("end", () => {
    if (
      !commandListeningRef.current ||
      handsFreeRecognizer.getOwner() !== "handsfree-command"
    ) {
      return;
    }
    commandListeningRef.current = false;
    dispatchHandsFree({ type: "COMMAND_EMPTY" });
    setHandsFreeStatus("Listening");
  });

  useHandsFreeRecognitionEvent("result", (event: any) => {
    if (
      !commandListeningRef.current ||
      handsFreeRecognizer.getOwner() !== "handsfree-command" ||
      handsFreeMachineRef.current.state !== "commandListening"
    ) {
      return;
    }

    const transcript = cleanHandsFreeCommand(
      String(event?.results?.[0]?.transcript || "")
    );
    if (!transcript) return;

    setHandsFreeTranscript(transcript);

    if (!event?.isFinal) return;
    void handleHandsFreeFinalTranscript(transcript);
  });

  useHandsFreeRecognitionEvent("error", (event: any) => {
    if (
      !commandListeningRef.current ||
      handsFreeRecognizer.getOwner() !== "handsfree-command" ||
      handsFreeMachineRef.current.state !== "commandListening"
    ) {
      return;
    }
    commandListeningRef.current = false;

    if (event?.error === "aborted") {
      return;
    }

    if (
      isLanguageNotSupportedRecognitionError(event) &&
      commandLocaleIndexRef.current < commandLocalePlanRef.current.length - 1
    ) {
      commandLocaleIndexRef.current += 1;
      setHandsFreeStatus("Listening");
      void startHandsFreeCommandRecognizer();
      return;
    }

    setHandsFreeStatus("Try again");
    dispatchHandsFree({ type: "COMMAND_EMPTY" });
  });

  useEffect(() => {
    let cancelled = false;
    if (!settings.handsFreeEnabled || appState !== "active" || !voiceSheetOpen) {
      setWakeModelState(null);
      dispatchHandsFree({ type: "INELIGIBLE" });
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const next = await ensureWakeModel(settings);
      if (cancelled) return;
      setWakeModelState((current) =>
        isSameWakeModelState(current, next) ? current : next
      );
      if (next.ready) {
        dispatchHandsFree({ type: "WAKE_READY" });
      } else {
        dispatchHandsFree({ type: "WAKE_MODEL_MISSING" });
      }
      const { ready: _ready, ...persistableWakeModel } = next as any;
      if (JSON.stringify(settings.wakeModel) !== JSON.stringify(persistableWakeModel)) {
        void updateSettings({ wakeModel: persistableWakeModel });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appState,
    settings.handsFreeEnabled,
    settings.wakePhrase,
    settings.wakeModel,
    updateSettings,
    voiceSheetOpen,
  ]);

  useEffect(() => {
    if (handsFreeForegroundEnabled) {
      dispatchHandsFree({ type: "ELIGIBLE" });
      setHandsFreeStatus("Listening");
      return;
    }

    if (
      settings.handsFreeEnabled &&
      appState === "active" &&
      voiceSheetOpen &&
      wakeModelState &&
      !wakeModelState.ready
    ) {
      dispatchHandsFree({ type: "WAKE_MODEL_MISSING" });
      void shutdownHandsFree(false);
      setHandsFreeStatus("Needs model");
      return;
    }

    dispatchHandsFree({ type: "INELIGIBLE" });
    void shutdownHandsFree(true);
  }, [
    appState,
    handsFreeForegroundEnabled,
    handsFreeLocale,
    handsFreeWakePhrase,
    profile?.userId,
    settings.handsFreeEnabled,
    shutdownHandsFree,
    voiceSheetOpen,
    wakeModelState,
  ]);

  useEffect(() => {
    if (!handsFreeForegroundEnabled) return;
    setHandsFreeStatus("Listening");
  }, [handsFreeWakePhrase, handsFreeForegroundEnabled]);

  useEffect(() => {
    if (!handsFreeForegroundEnabled) return;

    if (handsFreeMachine.state === "wakeListening") {
      void startNativeHandsFreeSession();
      return;
    }

    if (
      handsFreeMachine.state === "recording" ||
      handsFreeMachine.state === "stopping"
    ) {
      void abortHandsFreeRecognizer(false);
    }
  }, [
    abortHandsFreeRecognizer,
    busy,
    handsFreeForegroundEnabled,
    handsFreeMachine.state,
    listening,
    startNativeHandsFreeSession,
  ]);

  useEffect(() => {
    if (!e2eHandsFreeEnabled || e2eHandsFreeConfiguredRef.current) return;
    e2eHandsFreeConfiguredRef.current = true;
    void updateSettings({
      handsFreeEnabled: true,
      wakePhrase: e2eHandsFreeWakePhrase,
      wakeTrainingSamples: [e2eHandsFreeWakePhrase],
      wakeModel: {
        status: "e2e_mock",
        phraseKey: "e2e-mock",
        wakePhrase: e2eHandsFreeWakePhrase,
        modelType: "e2e_mock",
      },
    });
  }, [
    e2eHandsFreeEnabled,
    e2eHandsFreeWakePhrase,
    updateSettings,
  ]);

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

  async function configureAudioForPlayback() {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      } as any);
    } catch {
      // Playback mode failures should not hide the text reply.
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
    if (getChatHistoryItemKind(item) !== "chat") return;

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
        if (targetSession.kind === "chat") {
          workingSessions[targetIndex] = {
            ...targetSession,
            kind: "chat",
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
    voiceSheetGenerationRef.current += 1;
    const sessionId = nextVoiceSessionId();
    activeVoiceSessionIdRef.current = sessionId;
    voiceSheetOpenRef.current = true;
    voiceSessionItemsPendingHistoryRef.current = [];
    setActiveVoiceSessionId(sessionId);
    setVoiceSessionMode("live");
    setVoiceSessionTurns([]);
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
    markAssistantConcerned();
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

  function updateAssistantEmotionFromReply(reply: string) {
    setAssistantEmotion(emotionFromText(reply));
  }

  function markAssistantConcerned() {
    setAssistantEmotion("concerned");
  }

  function resetAssistantMouth() {
    setReplyAudioPlaying(false);
    setMouthOpenness(0);
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
      channel: (details as any).channel || "voice",
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
    let ttsLoaded = false;
    let playbackStartedLogged = false;
    let playbackFinishedLogged = false;

    if (isHandsFreeReply) {
      await stopHandsFreeCommandRecognizer();
    } else {
      await abortHandsFreeRecognizer(false);
    }
    await releaseReplySound();

    try {
      const voiceLanguage =
        context.voiceLanguage ||
        resolveVoiceLanguageParams({
          settingsLanguageMode: settings.languageMode,
          profileReplyLanguage: profile?.replyLanguage || null,
        });
      if (isVoiceReply) {
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "tts_started",
          });
        }
      } else if (isHandsFreeReply) {
        setHandsFreeStatus("Preparing reply...");
      }
      if (isHandsFreeReply) {
        dispatchHandsFree({ type: "TTS_STARTED" });
        await notifyHandsFreeTtsStarted();
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

      const replyAudioBytes = base64DecodedByteLength(String(data.audio_base64 || ""));
      if (!data.audio_base64 || replyAudioBytes <= 0) {
        throw new Error("TTS response did not include playable audio.");
      }

      if (replyPlaybackTokenRef.current !== playbackToken) {
        return;
      }

      if (isE2eMockVoiceTurnEnabled()) {
        const mockPlaybackUri = "e2e://voice-reply.wav";
        if (isVoiceReply && context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "loaded",
          });
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
          reply_audio_bytes: replyAudioBytes,
          playback_uri_scheme: uriScheme(mockPlaybackUri),
          e2e_mock: true,
        } as any);
        if (isVoiceReply && context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "playback_started",
          });
        } else if (isHandsFreeReply) {
          setHandsFreeStatus("Speaking reply...");
        }
        logVoiceTelemetry("client_voice_reply_playback_started", {
          request_id: context.requestId,
          route_taken: "voice_reply_tts",
          voice_phase: "playback_started",
          reply_playback_phase: "playback_started",
          voice_surface: context.voiceSurface || null,
          voice_session_id: context.voiceSessionId || undefined,
          requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
          tts_language_code: data.target_language_code || (isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined),
          reply_audio_bytes: replyAudioBytes,
          playback_uri_scheme: uriScheme(mockPlaybackUri),
          e2e_mock: true,
        } as any);
        setReplyAudioPlaying(true);
        setMouthOpenness(nextMouthOpenness({ isPlaying: true, positionMillis: 120 }));
        await wait(650);
        if (replyPlaybackTokenRef.current !== playbackToken) {
          resetAssistantMouth();
          return;
        }
        if (isVoiceReply && context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "playback_finished",
          });
        } else if (isHandsFreeReply) {
          setHandsFreeStatus("Listening");
        }
        logVoiceTelemetry("client_voice_reply_playback_finished", {
          request_id: context.requestId,
          route_taken: "voice_reply_tts",
          voice_phase: "playback_finished",
          reply_playback_phase: "playback_finished",
          voice_surface: context.voiceSurface || null,
          voice_session_id: context.voiceSessionId || undefined,
          requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
          tts_language_code: data.target_language_code || (isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined),
          reply_audio_bytes: replyAudioBytes,
          playback_uri_scheme: uriScheme(mockPlaybackUri),
          e2e_mock: true,
        } as any);
        resetAssistantMouth();
        if (isHandsFreeReply) {
          dispatchHandsFree({ type: "TTS_COMPLETED" });
          await notifyHandsFreeTtsCompleted();
        }
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

      const logPlaybackStarted = () => {
        if (playbackStartedLogged) return;
        playbackStartedLogged = true;
        setReplyAudioPlaying(true);
        if (isVoiceReply && context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "playback_started",
          });
        } else if (isHandsFreeReply) {
          setHandsFreeStatus("Speaking reply...");
        }
        logVoiceTelemetry("client_voice_reply_playback_started", {
          request_id: context.requestId,
          route_taken: "voice_reply_tts",
          voice_phase: "playback_started",
          reply_playback_phase: "playback_started",
          voice_surface: context.voiceSurface || null,
          voice_session_id: context.voiceSessionId || undefined,
          requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
          tts_language_code: data.target_language_code || (isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined),
          reply_audio_bytes: replyAudioBytes,
          playback_uri_scheme: uriScheme(cachedUri),
        });
      };

      const logPlaybackFinished = () => {
        if (playbackFinishedLogged) return;
        playbackFinishedLogged = true;
        resetAssistantMouth();
        if (isVoiceReply && context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "playback_finished",
          });
        } else if (isHandsFreeReply) {
          setHandsFreeStatus("Listening");
        }
        logVoiceTelemetry("client_voice_reply_playback_finished", {
          request_id: context.requestId,
          route_taken: "voice_reply_tts",
          voice_phase: "playback_finished",
          reply_playback_phase: "playback_finished",
          voice_surface: context.voiceSurface || null,
          voice_session_id: context.voiceSessionId || undefined,
          requested_reply_language: isSpokenVoiceReply ? voiceLanguage.replyLanguage : undefined,
          tts_language_code: data.target_language_code || (isSpokenVoiceReply ? voiceLanguage.ttsLanguageCode : undefined),
          reply_audio_bytes: replyAudioBytes,
          playback_uri_scheme: uriScheme(cachedUri),
        });
      };

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) {
          const statusError = String((status as any)?.error || "");
          if (statusError && replySoundRef.current === sound) {
            markAssistantConcerned();
            resetAssistantMouth();
            logVoiceTelemetry("client_voice_reply_playback_failed", {
              request_id: context.requestId,
              route_taken: "voice_reply_tts",
              voice_phase: "playback_failed",
              reply_playback_phase: "failed",
              voice_surface: context.voiceSurface || null,
              voice_session_id: context.voiceSessionId || undefined,
              playback_uri_scheme: uriScheme(cachedUri),
              error_type: "playback_status_error",
              error_message: statusError,
            });
            if (isVoiceReply && context.voiceSessionId) {
              updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
                assistantText: textValue ? `${textValue}\nVoice playback failed.` : "Voice playback failed.",
                status: textValue ? "done" : "error",
                ttsStatus: "playback_failed",
              });
            }
          }
          if (replySoundRef.current === sound) {
            replySoundRef.current = null;
          }
          resetAssistantMouth();
          return;
        }

        if (status.isPlaying || status.positionMillis > 0) {
          logPlaybackStarted();
        }
        if (status.isPlaying) {
          setMouthOpenness(
            nextMouthOpenness({
              isPlaying: true,
              positionMillis: status.positionMillis,
            }),
          );
        } else if (!status.didJustFinish) {
          resetAssistantMouth();
        }

        if (status.didJustFinish) {
          if (replySoundRef.current === sound) {
            logPlaybackFinished();
          }
          void releaseReplySound(sound).finally(() => {
            if (isHandsFreeReply) {
              dispatchHandsFree({ type: "TTS_COMPLETED" });
              void notifyHandsFreeTtsCompleted();
            }
          });
        }
      });

      await configureAudioForPlayback();
      const status = await sound.loadAsync(
        { uri: cachedUri },
        {
          shouldPlay: false,
          progressUpdateIntervalMillis: 250,
        }
      );
      if (!status.isLoaded) {
        throw new Error("TTS audio could not be loaded.");
      }
      ttsLoaded = true;

      if (replyPlaybackTokenRef.current !== playbackToken) {
        await releaseReplySound(sound);
        await deleteReplyAudioFile(cachedUri);
        return;
      }

      replySoundRef.current = sound;
      replyAudioUriRef.current = cachedUri;
      if (isVoiceReply) {
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            ttsStatus: "loaded",
          });
        }
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
        reply_audio_bytes: replyAudioBytes,
        playback_uri_scheme: uriScheme(cachedUri),
      });
      const playStatus = await sound.playAsync();
      if (!playStatus.isLoaded) {
        throw new Error("TTS audio playback could not start.");
      }
      logPlaybackStarted();
    } catch (error: unknown) {
      markAssistantConcerned();
      resetAssistantMouth();
      if (sound) {
        await releaseReplySound(sound);
      }
      if (cachedUri && replyAudioUriRef.current !== cachedUri) {
        await deleteReplyAudioFile(cachedUri);
      }
      const failureEvent = ttsLoaded
        ? "client_voice_reply_playback_failed"
        : "client_voice_reply_tts_failed";
      const failurePhase = ttsLoaded ? "playback_failed" : "tts_failed";
      if (isVoiceReply) {
        if (context.voiceSessionId) {
          updateVoiceSessionTurn(context.requestId || context.voiceSessionId, {
            assistantText: textValue ? `${textValue}\nVoice playback failed.` : "Voice playback failed.",
            status: textValue ? "done" : "error",
            ttsStatus: failurePhase,
          });
        }
      } else if (isHandsFreeReply) {
        setHandsFreeStatus("Try again");
        dispatchHandsFree({ type: "TTS_COMPLETED" });
        await notifyHandsFreeTtsCompleted();
      }
      logVoiceTelemetry(failureEvent, {
        request_id: context.requestId,
        route_taken: "voice_reply_tts",
        voice_phase: failurePhase,
        reply_playback_phase: "failed",
        voice_surface: context.voiceSurface || null,
        voice_session_id: context.voiceSessionId || undefined,
        playback_uri_scheme: uriScheme(cachedUri),
        error_type: safeVoiceErrorType(error, failurePhase),
        ...({ speaker_misconfigured: isTtsSpeakerMisconfiguredError(error) } as any),
        error_message: error instanceof Error ? error.message : String(error || ""),
      });
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

    if (source !== "handsfree" && handsFreeRuntimeRef.current.foreground) {
      await abortHandsFreeRecognizer(false);
    }

    const requestId = nextChatRequestId(source);
    const currentSessionId = activeChatSessionIdRef.current;
    const isHandsFreeTurn =
      source === "handsfree" &&
      voiceSheetOpenRef.current;
    const replyPolicyHandsFreeMode: HandsFreePlaybackMode =
      source === "handsfree" && isHandsFreeTurn ? "conversation" : "off";
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
      if (isHandsFreeTurn) {
        dispatchHandsFree({ type: "SUBMIT_STARTED" });
      }
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
        setHandsFreeStatus("Listening");
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
      const chatRequestBody = await buildChatRequestWithLifeContext({
        user_id: profile.userId,
        message: cleaned,
        reply_language: settings.languageMode,
        request_id: requestId,
        client_source: source,
      });
      const response = await withLocalTimeout(
        apiPost<BackendChatResponse>("/api/chat", chatRequestBody),
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

      const nextItem = normalizeItemForRequestSource(
        normalizeChatTurnPayload(response, cleaned),
        source,
      );
      updateAssistantEmotionFromReply(nextItem.details || "");
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
      const assistantDetails = String(nextItem.details || "");
      const shouldSpeak =
        assistantDetails &&
        shouldAutoSpeakReply({
          source,
          autoSpeakReplies: settings.autoSpeakReplies,
          handsFreeMode: replyPolicyHandsFreeMode,
        });

      if (shouldSpeak) {
        void playAgentReply(assistantDetails, { requestId, source });
      } else if (source === "handsfree") {
        dispatchHandsFree({ type: "SUBMIT_FINISHED" });
        setHandsFreeStatus("Listening");
        void notifyHandsFreeTtsCompleted();
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
              const backendFallbackBody = await buildChatRequestWithLifeContext({
                user_id: profile.userId,
                message: cleaned,
                reply_language: settings.languageMode,
                request_id: requestId,
                client_source: source,
                client_fallback_reason: "local_timeout",
                client_local_budget_ms: getLocalToBackendFallbackMs(),
                client_original_route: "local_answer",
              });
              const backendResponse = await apiPostBackendOnly<BackendChatResponse>(
                "/api/chat",
                backendFallbackBody,
                { timeoutMs: BACKEND_CHAT_FALLBACK_TIMEOUT_MS },
              );
              if (!isActiveChatRequest(requestId)) {
                await clearActiveWorkflow(requestId).catch(() => undefined);
                return;
              }
              const nextItem = normalizeItemForRequestSource(
                normalizeChatTurnPayload(backendResponse, cleaned),
                source,
              );
              updateAssistantEmotionFromReply(nextItem.details || "");
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
              const assistantDetails = String(nextItem.details || "");
              const shouldSpeak =
                assistantDetails &&
                shouldAutoSpeakReply({
                  source,
                  autoSpeakReplies: settings.autoSpeakReplies,
                  handsFreeMode: replyPolicyHandsFreeMode,
                });
              if (shouldSpeak) {
                void playAgentReply(assistantDetails, { requestId, source });
              } else if (source === "handsfree") {
                dispatchHandsFree({ type: "SUBMIT_FINISHED" });
                setHandsFreeStatus("Listening");
                void notifyHandsFreeTtsCompleted();
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
            setHandsFreeStatus("Try again");
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
            dispatchHandsFree({ type: "SUBMIT_FINISHED" });
            void notifyHandsFreeTtsCompleted();
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
          setHandsFreeStatus("Try again");
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
          dispatchHandsFree({ type: "SUBMIT_FINISHED" });
          void notifyHandsFreeTtsCompleted();
        }
      }
    } finally {
      clearProgressTimers();
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
        setBusy(false);
      }
    }
  }

  async function handleChatSend() {
    await submitChatMessage(text, "text");
  }

  async function simulateE2eHandsFreeWakeCommand() {
    if (!e2eHandsFreeEnabled || e2eHandsFreeTriggeredRef.current) return;
    if ((busy || handsFreeRuntimeRef.current.busy) && !e2eHandsFreeAudioEnabled) {
      if (!e2eHandsFreePendingRef.current) {
        console.info("[e2e_hands_free_audio_mock] waiting_for_busy_to_clear", {
          client_source: "handsfree",
        });
      }
      if (e2eHandsFreeBusyRetryCountRef.current < 30) {
        e2eHandsFreePendingRef.current = true;
        e2eHandsFreeBusyRetryCountRef.current += 1;
        setTimeout(() => {
          e2eHandsFreePendingRef.current = false;
          void simulateE2eHandsFreeWakeCommand();
        }, 1000);
      }
      return;
    }
    if (busy || handsFreeRuntimeRef.current.busy) {
      console.info("[e2e_hands_free_audio_mock] continuing_with_mock_audio_while_busy", {
        client_source: "handsfree",
      });
    }
    e2eHandsFreePendingRef.current = false;
    e2eHandsFreeBusyRetryCountRef.current = 0;
    e2eHandsFreeTriggeredRef.current = true;
    const wakePhrase = e2eHandsFreeWakePhrase || handsFreeWakePhrase;
    const command = getE2eHandsFreeCommand() || "tell me about Spitzola";
    setHandsFreeTranscript(wakePhrase);
    openHandsFreeVoiceSheet();
    setHandsFreeStatus("Listening");
    dispatchHandsFree({ type: "WAKE_DETECTED" });
    dispatchHandsFree({ type: "COMMAND_STARTED" });
    if (e2eHandsFreeAudioEnabled) {
      setTimeout(() => {
        void (async () => {
          if (!voiceSheetOpenRef.current) {
            openHandsFreeVoiceSheet();
          }
          const event = await createE2eHandsFreeCommandAudioEvent();
          console.info("[e2e_hands_free_audio_mock] onCommandAudio", {
            fileUri: event.fileUri,
            mimeType: event.mimeType,
            durationMs: event.durationMs,
            sampleRate: event.sampleRate,
            client_source: "handsfree",
          });
          await handleNativeHandsFreeCommandAudio(event);
        })();
      }, 250);
      return;
    }
    setTimeout(() => {
      if (!voiceSheetOpenRef.current) {
        openHandsFreeVoiceSheet();
      }
      setHandsFreeTranscript(command);
      dispatchHandsFree({ type: "COMMAND_FINAL" });
      void submitChatMessage(command, "handsfree");
    }, 250);
  }

  async function simulateE2eHandsFreeStop() {
    if (!e2eHandsFreeEnabled) return;
    e2eHandsFreeTriggeredRef.current = false;
    setHandsFreeTranscript("go to sleep");
    dispatchHandsFree({ type: "VOICE_SHEET_CLOSED" });
    await shutdownHandsFree(true);
    voiceSheetOpenRef.current = false;
    setVoiceSheetOpen(false);
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
    dispatchHandsFree({ type: "PRESS_TO_TALK_FINISHED" });
    await resetAudioMode();
  }

  // Normal chat is intentionally text-only. Audio input belongs in the live assistant
  // voice screen; do not reintroduce a composer mic without updating UX tests.
  async function startRecording(surface: RecorderSurface) {
    if (busy || recordingPhaseRef.current !== "idle") return;
    if (e2eVoiceTurnEnabled) {
      await submitE2eVoiceAudio(surface);
      return;
    }
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
      dispatchHandsFree({ type: "PRESS_TO_TALK_STARTED" });
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

  async function uploadVoiceAudioForAnalysis(input: {
    requestId: string;
    uri: string;
    fileName: string;
    mimeType: string;
    source: ChatRequestSource;
    voiceSurface: RecorderSurface;
    voiceSessionId: string | null;
    fileSize?: number;
  }) {
    const form = new FormData();
    form.append(
      "file",
      {
        uri: input.uri,
        name: input.fileName,
        type: input.mimeType,
      } as any
    );
    form.append("client_source", input.source);

    const timeoutMs = await getChatTurnTimeoutMs(input.source);
    const voiceLanguage = resolveVoiceLanguageParams({
      settingsLanguageMode: settings.languageMode,
      profileReplyLanguage: profile?.replyLanguage || null,
    });
    logVoiceTelemetry("client_voice_upload_started", {
      request_id: input.requestId,
      route_taken: "voice_upload",
      voice_phase: "uploading",
      voice_surface: input.voiceSurface,
      voice_session_id: input.voiceSessionId || undefined,
      channel: input.source,
      client_source: input.source,
      file_size: input.fileSize,
      mime_type: input.mimeType,
      requested_reply_language: voiceLanguage.replyLanguage,
      requested_speech_language: voiceLanguage.speechLanguage,
      tts_language_code: voiceLanguage.ttsLanguageCode,
      settings_language_mode: settings.languageMode,
    } as any);
    const res = await withLocalTimeout(
      apiPostForm<BackendChatResponse | ChatHistoryItem>(
        `/api/transcribe-and-analyze?user_id=${profile?.userId ?? ""}&reply_language=${voiceLanguage.replyLanguage}&speech_language=${voiceLanguage.speechLanguage}&client_source=${input.source}`,
        form,
      ),
      timeoutMs,
      {
        source: input.source,
        message: friendlyLocalTimeoutMessage(),
      },
    );
    logVoiceTelemetry("client_voice_upload_completed", {
      request_id: input.requestId,
      route_taken: "voice_upload",
      voice_phase: "completed",
      voice_surface: input.voiceSurface,
      voice_session_id: input.voiceSessionId || undefined,
      channel: input.source,
      client_source: input.source,
      file_size: input.fileSize,
      mime_type: input.mimeType,
      requested_reply_language: voiceLanguage.replyLanguage,
      requested_speech_language: voiceLanguage.speechLanguage,
      tts_language_code: voiceLanguage.ttsLanguageCode,
      settings_language_mode: settings.languageMode,
    } as any);
    return { res, voiceLanguage };
  }

  async function submitE2eVoiceAudio(surface: RecorderSurface) {
    if (busy) return;
    const requestId = nextChatRequestId("voice");
    activeChatRequestIdRef.current = requestId;
    voiceBusyRequestIdRef.current = requestId;
    const voiceSessionId = ensureVoiceSession("live");
    let uploadStarted = false;
    let audioFileSize: number | undefined;
    let mimeType = "audio/wav";

    try {
      dispatchHandsFree({ type: "PRESS_TO_TALK_STARTED" });
      await abortHandsFreeRecognizer(false);
      await releaseReplySound();
      setBusy(true);
      recordingPhaseRef.current = "stopping";
      activeSurfaceRef.current = surface;
      setActiveSurface(surface);
      setRecordingPreparing(false);
      setRecordingStopping(true);
      setListening(false);
      updateVoiceSessionTurn(requestId, {
        userText: "Voice message",
        assistantText: "",
        status: "thinking",
        replyLanguage: settings.languageMode,
      });
      logVoiceTelemetry("client_voice_prepare_started", {
        route_taken: "voice_prepare",
        voice_phase: "preparing",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        e2e_mock: true,
      } as any);

      const uri = "file:///e2e-voice.wav";
      const recordingDurationMs = 1000;
      mimeType = "audio/wav";
      logVoiceTelemetry("client_voice_prepare_completed", {
        route_taken: "voice_prepare",
        voice_phase: "ready",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        duration_ms: 0,
        e2e_mock: true,
      } as any);
      logVoiceTelemetry("client_voice_recording_started", {
        route_taken: "voice_recording",
        voice_phase: "recording",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        e2e_mock: true,
      } as any);
      logVoiceTelemetry("client_voice_recording_stopped", {
        request_id: requestId,
        route_taken: "voice_recording",
        voice_phase: "stopped",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        duration_ms: recordingDurationMs,
        file_size: audioFileSize,
        mime_type: mimeType,
        e2e_mock: true,
      } as any);
      assertMinimumVoiceRecordingDuration(recordingDurationMs);

      uploadStarted = true;
      const { res, voiceLanguage } = await uploadVoiceAudioForAnalysis({
        requestId,
        uri,
        fileName: "e2e-voice.wav",
        mimeType,
        source: "voice",
        voiceSurface: surface,
        voiceSessionId,
        fileSize: audioFileSize,
      });

      if (!isActiveChatRequest(requestId)) {
        return;
      }

      const nextItem = normalizeItemForRequestSource(normalizeChatTurnPayload(res), "voice");
      const assistantReplyText = String(nextItem.details || "").trim();
      const userTranscript = String(nextItem.raw_text || nextItem.transcript || "Voice message").trim();
      updateAssistantEmotionFromReply(assistantReplyText);
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
      if (!isE2eMockVoiceTurnEnabled()) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      if (
        assistantReplyText &&
        shouldAutoSpeakReply({
          source: "voice",
          autoSpeakReplies: settings.autoSpeakReplies,
          handsFreeMode: handsFreePlaybackMode,
          voiceSurface: surface,
          voiceOnlyMode,
        })
      ) {
        void playAgentReply(assistantReplyText, {
          requestId,
          source: "voice",
          voiceSurface: surface,
          voiceLanguage,
          voiceSessionId,
        });
      }
    } catch (error: unknown) {
      logVoiceTelemetry("client_voice_upload_failed", {
        request_id: requestId,
        route_taken: uploadStarted ? "voice_upload" : "voice_file_validation",
        voice_phase: uploadStarted ? "upload_failed" : "file_validation_failed",
        voice_surface: surface,
        voice_session_id: voiceSessionId || undefined,
        file_size: audioFileSize,
        mime_type: mimeType,
        error_type: safeVoiceErrorType(
          error,
          uploadStarted ? "voice_upload_failed" : "voice_file_validation_failed",
        ),
        e2e_mock: true,
      } as any);
      if (isActiveChatRequest(requestId)) {
        markAssistantConcerned();
        updateVoiceSessionTurn(requestId, {
          userText: "Voice message",
          assistantText: VOICE_UNAVAILABLE_MESSAGE,
          status: "error",
        });
        warnChatFailure(error, requestId, "voice");
      }
    } finally {
      await cleanupVoiceRecordingState();
      const ownsVoiceBusyState = voiceBusyRequestIdRef.current === requestId;
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
      }
      if (ownsVoiceBusyState) {
        setBusy(false);
        voiceBusyRequestIdRef.current = null;
      }
    }
  }

  async function submitHandsFreeCommandAudio(event: HandsFreeCommandAudioEvent) {
    const uri = event.fileUri || event.uri;
    if (!uri) {
      logVoiceTelemetry("hands-free command audio missing uri", {
        route_taken: "handsfree_command_audio",
        voice_phase: "missing_uri",
        channel: "handsfree",
        client_source: "handsfree",
        mime_type: event.mimeType || "audio/wav",
        duration_ms: event.durationMs,
        sample_rate: event.sampleRate,
      } as any);
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      setHandsFreeStatus("Try again");
      await cancelHandsFreeCommand();
      await notifyHandsFreeTtsCompleted();
      return;
    }
    if (busy && !e2eHandsFreeAudioEnabled) {
      logVoiceTelemetry("hands-free command audio ignored while busy", {
        route_taken: "handsfree_command_audio",
        voice_phase: "busy",
        channel: "handsfree",
        client_source: "handsfree",
        mime_type: event.mimeType || "audio/wav",
        duration_ms: event.durationMs,
        sample_rate: event.sampleRate,
      } as any);
      dispatchHandsFree({ type: "COMMAND_EMPTY" });
      setHandsFreeStatus("Listening");
      await cancelHandsFreeCommand();
      await notifyHandsFreeTtsCompleted();
      return;
    }
    if (busy) {
      logVoiceTelemetry("hands-free command audio proceeding with E2E busy override", {
        route_taken: "handsfree_command_audio",
        voice_phase: "busy_e2e_override",
        channel: "handsfree",
        client_source: "handsfree",
        mime_type: event.mimeType || "audio/wav",
        duration_ms: event.durationMs,
        sample_rate: event.sampleRate,
      } as any);
    }
    if (!profile?.userId) {
      setHandsFreeStatus("Finish setup to use hands-free voice.");
      dispatchHandsFree({ type: "SUBMIT_FINISHED" });
      await notifyHandsFreeTtsCompleted();
      return;
    }

    const requestId = nextChatRequestId("handsfree");
    activeChatRequestIdRef.current = requestId;
    const requestVoiceSurface: RecorderSurface = "live";
    const voiceSessionId = ensureVoiceSession("live");
    let uploadStarted = false;
    let audioFileSize: number | undefined;
    const mimeType = event.mimeType || "audio/wav";

    try {
      setBusy(true);
      dispatchHandsFree({ type: "SUBMIT_STARTED" });
      updateVoiceSessionTurn(requestId, {
        userText: "Voice message",
        assistantText: "",
        status: "thinking",
        replyLanguage: settings.languageMode,
      });

      const audioInfo = await assertUsableAudioFile(uri);
      audioFileSize = Number((audioInfo as any).size || 0) || undefined;
      assertMinimumVoiceRecordingDuration(event.durationMs, 700);
      uploadStarted = true;
      const { res, voiceLanguage } = await uploadVoiceAudioForAnalysis({
        requestId,
        uri,
        fileName: "handsfree-command.wav",
        mimeType,
        source: "handsfree",
        voiceSurface: requestVoiceSurface,
        voiceSessionId,
        fileSize: audioFileSize,
      });

      if (!isActiveChatRequest(requestId)) {
        return;
      }

      const nextItem = normalizeItemForRequestSource(normalizeChatTurnPayload(res), "handsfree");
      const assistantReplyText = String(nextItem.details || "").trim();
      const userTranscript = String(nextItem.raw_text || nextItem.transcript || "Voice message").trim();
      updateAssistantEmotionFromReply(assistantReplyText);
      keepHandsFreeVoiceSheetOpen();
      setHandsFreeTranscript(userTranscript);
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
      if (!isE2eMockVoiceTurnEnabled()) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      if (
        assistantReplyText &&
        shouldAutoSpeakReply({
          source: "handsfree",
          autoSpeakReplies: settings.autoSpeakReplies,
          handsFreeMode: "conversation",
          voiceSurface: requestVoiceSurface,
          voiceOnlyMode,
        })
      ) {
        void playAgentReply(assistantReplyText, {
          requestId,
          source: "handsfree",
          voiceSurface: requestVoiceSurface,
          voiceLanguage,
          voiceSessionId,
        });
      } else {
        dispatchHandsFree({ type: "SUBMIT_FINISHED" });
        setHandsFreeStatus("Listening");
        await notifyHandsFreeTtsCompleted();
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
      logVoiceTelemetry("client_voice_upload_failed", {
        request_id: requestId,
        route_taken: uploadStarted ? "voice_upload" : "voice_file_validation",
        voice_phase: uploadStarted ? "upload_failed" : "file_validation_failed",
        voice_surface: requestVoiceSurface,
        voice_session_id: voiceSessionId || undefined,
        channel: "handsfree",
        client_source: "handsfree",
        file_size: audioFileSize,
        mime_type: mimeType,
        error_type: emptyAudio
          ? "empty_audio"
          : tooShortAudio
            ? "too_short_audio"
            : safeVoiceErrorType(
                error,
                uploadStarted
                  ? "voice_upload_failed"
                  : "voice_file_validation_failed",
              ),
      } as any);
      if (isActiveChatRequest(requestId)) {
        markAssistantConcerned();
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
        setHandsFreeStatus("Try again");
        dispatchHandsFree({ type: "SUBMIT_FINISHED" });
        warnChatFailure(error, requestId, "handsfree");
      }
      await notifyHandsFreeTtsCompleted();
    } finally {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
        setBusy(false);
      }
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

      uploadStarted = true;
      const { res, voiceLanguage } = await uploadVoiceAudioForAnalysis({
        requestId,
        uri,
        fileName: "audio.m4a",
        mimeType: "audio/m4a",
        source: "voice",
        voiceSurface: requestVoiceSurface,
        voiceSessionId,
        fileSize: audioFileSize,
      });

      if (!isActiveChatRequest(requestId)) {
        return;
      }

      const nextItem = normalizeItemForRequestSource(normalizeChatTurnPayload(res), "voice");
      const assistantReplyText = String(nextItem.details || "").trim();
      const userTranscript = String(nextItem.raw_text || nextItem.transcript || "Voice message").trim();
      updateAssistantEmotionFromReply(assistantReplyText);
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
          handsFreeMode: handsFreePlaybackMode,
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
        markAssistantConcerned();
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
        warnChatFailure(error, requestId, "voice");
      }
    } finally {
      await cleanupVoiceRecordingState();
      const ownsVoiceBusyState = voiceBusyRequestIdRef.current === requestId;
      if (isActiveChatRequest(requestId)) {
        activeChatRequestIdRef.current = null;
      }
      if (ownsVoiceBusyState) {
        setBusy(false);
        voiceBusyRequestIdRef.current = null;
      }
    }
  }

  async function closeVoiceSheetSafely() {
    const closeGeneration = voiceSheetGenerationRef.current;
    dispatchHandsFree({ type: "VOICE_SHEET_CLOSED" });
    await shutdownHandsFree(true);
    const phase = recordingPhaseRef.current;
    if (phase === "starting" || phase === "recording") {
      await stopAndAnalyze();
    }
    if (closeGeneration !== voiceSheetGenerationRef.current) {
      return;
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

  const morphTranslateX = Math.min(contentMaxWidth * 0.28, 112);
  const morphTranslateY = Math.min(height * 0.26, 210);
  const floatingAssistantAnimatedStyle = {
    opacity: floatingAssistantProgress.interpolate({
      inputRange: [0, 0.18, 1],
      outputRange: [0.04, 0.38, 1],
    }),
    transform: [
      {
        translateX: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [-morphTranslateX, 0],
        }),
      },
      {
        translateY: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [-morphTranslateY, 0],
        }),
      },
      {
        scale: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [2.45, 1],
        }),
      },
    ],
  };
  const voiceHeroMorphStyle = {
    opacity: floatingAssistantProgress.interpolate({
      inputRange: [0, 0.7, 1],
      outputRange: [1, 0.82, 0.28],
    }),
    transform: [
      {
        translateX: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, morphTranslateX],
        }),
      },
      {
        translateY: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, morphTranslateY],
        }),
      },
      {
        scale: floatingAssistantProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0.42],
        }),
      },
    ],
  };

  return (
    <Screen safeArea={false} style={styles.screen}>
      <StatusBar style="light" />

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

          <View style={styles.iconButtonSpacer} />
        </View>

        {e2eHandsFreeEnabled ? (
          <View style={styles.e2eHandsFreeControls}>
            <Pressable
              onPress={() => {
                openVoiceSession();
              }}
              testID="e2e-open-voice-button"
              accessibilityLabel="e2e-open-voice-button"
              accessibilityRole="button"
              style={styles.e2eHandsFreeButton}
            >
              <Text style={styles.e2eHandsFreeButtonText}>E2E voice</Text>
            </Pressable>
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

        <View
          style={styles.chatBody}
          testID="chat-swipe-surface"
          accessibilityLabel="chat-swipe-surface"
          onTouchStart={handleChatSwipeTouchStart}
          onTouchEnd={handleChatSwipeTouchEnd}
          {...chatSwipePanResponder.panHandlers}
        >
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

          <Animated.View
            pointerEvents="none"
            style={[
              styles.floatingAssistantOverlay,
              {
                paddingHorizontal: horizontalPadding,
                bottom: layout.composerBottomOffset + Math.max(composerHeight, 58) + 8,
              },
              floatingAssistantAnimatedStyle,
            ]}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth, alignItems: "flex-end" }}>
              <AssistantCharacter
                testID="floating-assistant-character"
                mode="floating"
                size={assistantFloatingSize}
                state={assistantCharacterState}
                emotion={assistantCharacterEmotion}
                mouthOpenness={mouthOpenness}
                listening={assistantListeningActive}
                accessibilityHidden
              />
            </View>
          </Animated.View>

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
                  <TextInput
                    value={text}
                    testID="chat-input"
                    accessibilityLabel="chat-input"
                    onChangeText={setText}
                    placeholder={composerPlaceholder}
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
                    multiline
                    returnKeyType="send"
                    submitBehavior="submit"
                    onSubmitEditing={() => {
                      if (text.trim() && !busy && !listening) {
                        void handleChatSend();
                      }
                    }}
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
                  <Ionicons name="search-outline" size={18} color="rgba(226, 238, 255, 0.52)" />
                  <TextInput
                    value={historySearch}
                    onChangeText={setHistorySearch}
                    placeholder="Search chat history"
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
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
                            <View style={styles.chatListHeaderRow}>
                              <Text numberOfLines={1} style={styles.chatListTitle}>
                                {item.title}
                              </Text>
                              <View
                                style={[
                                  styles.chatListKindBadge,
                                  item.kind === "voice" && styles.chatListKindBadgeVoice,
                                ]}
                              >
                                <Text style={styles.chatListKindBadgeText}>
                                  {getChatSessionKindLabel(item.kind || "chat")}
                                </Text>
                              </View>
                            </View>
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
                  <Ionicons name="trash-outline" size={18} color={Brand.cream} />
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
        <Screen safeArea={false} style={styles.voiceScreen}>
          <StatusBar style="light" />

          <View
            style={styles.voiceSwipeSurface}
            testID="voice-swipe-surface"
            accessibilityLabel="voice-swipe-surface"
            onTouchStart={handleVoiceSwipeTouchStart}
            onTouchEnd={handleVoiceSwipeTouchEnd}
            {...voiceSwipePanResponder.panHandlers}
          >
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

            <View style={styles.voiceTopSpacer} />

            {e2eVoiceTurnEnabled || e2eHandsFreeEnabled ? (
              <View style={styles.e2eVoiceTopControls}>
                <Pressable
                  onPress={() => {
                    void closeVoiceSheetSafely();
                  }}
                  testID="e2e-close-voice-button"
                  accessibilityLabel="e2e-close-voice-button"
                  accessibilityRole="button"
                  style={styles.e2eHandsFreeButton}
                >
                  <Text style={styles.e2eHandsFreeButtonText}>E2E close</Text>
                </Pressable>

                {e2eHandsFreeEnabled && (handsFreeActive || handsFreeConversationActive) ? (
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
              </View>
            ) : null}
          </View>

          <View style={styles.voiceCenter}>
            <View pointerEvents="none" style={styles.voiceAssistantGlow} />
            <Animated.View style={voiceHeroMorphStyle}>
              <Orb
                listening={listening && activeSurface === "live"}
                state={assistantCharacterState}
                emotion={assistantCharacterEmotion}
                mouthOpenness={mouthOpenness}
                onPressIn={() => {
                  void handleLiveOrbPressIn();
                }}
                onPressOut={() => {
                  void handleLiveOrbPressOut();
                }}
                size={assistantHeroSize}
              />
            </Animated.View>

            <Text style={styles.voiceTitle}>
              {recordingStopping && activeSurface === "live"
                ? "Sending"
                : recordingPreparing && activeSurface === "live"
                ? "Listening"
                : listening && activeSurface === "live"
                  ? "Listening"
                  : handsFreeConversationActive
                    ? "Listening"
                  : handsFreeActive
                    ? "Listening"
                    : "Hold to Talk"}
            </Text>

            {settings.handsFreeEnabled && (handsFreeActive || handsFreeConversationActive || handsFreeStatus) ? (
              <View style={styles.handsFreeBadge}>
                <Ionicons
                  name={handsFreeActive ? "radio" : "radio-outline"}
                  size={14}
                  color={Brand.cocoa}
                />
                <Text style={styles.handsFreeBadgeText}>
                  {handsFreeStatus || (handsFreeMachine.state === "wakeListening" ? "Listening" : "Listening")}
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
                testID="e2e-hands-free-stop-inline-button"
                accessibilityLabel="e2e-hands-free-stop-inline-button"
                accessibilityRole="button"
                style={styles.e2eHandsFreeButton}
              >
                <Text style={styles.e2eHandsFreeButtonText}>E2E stop</Text>
              </Pressable>
            ) : null}

            <VoiceSessionTranscript
              turns={voiceSessionMode === "live" ? voiceSessionTurns : []}
            />

            {(recordingPreparing || listening || recordingStopping) && activeSurface === "live" ? (
              <View style={styles.voiceWaveWrap}>
                <Waveform active={listening} />
              </View>
            ) : null}
          </View>
          </View>

          {e2eHandsFreeEnabled ? (
            <Pressable
              onPress={() => {
                void simulateE2eHandsFreeWakeCommand();
              }}
              testID="e2e-hands-free-trigger-button"
              accessibilityLabel="e2e-hands-free-trigger-button"
              accessibilityRole="button"
              style={[
                styles.e2eHandsFreeButton,
                styles.e2eHandsFreeVoiceButton,
                {
                  top: topPadding + 46,
                  right: horizontalPadding,
                },
              ]}
            >
              <Text style={styles.e2eHandsFreeButtonText}>E2E hands-free</Text>
            </Pressable>
          ) : null}
        </Screen>
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
    </Screen>
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

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: Spacing.sm,
    gap: Spacing.md,
  },

  topBarCenter: {
    flex: 1,
    alignItems: "center",
  },

  topBarTitle: {
    ...Type.subheading,
    color: Brand.ink,
  },

  topBarSubtitle: {
    ...Type.overline,
    marginTop: Spacing.xxs,
    color: Brand.textMuted,
  },

  iconButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  iconButtonSpacer: {
    width: 36,
    height: 36,
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  e2eVoiceTopControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 30,
  },

  e2eHandsFreeVoiceButton: {
    position: "absolute",
    maxWidth: 150,
    zIndex: 20,
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: Brand.bronze,
    borderBottomRightRadius: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },

  assistantBubble: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: Brand.line,
    borderBottomLeftRadius: 8,
  },

  messageText: {
    ...Type.body,
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
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderColor: "rgba(255, 138, 138, 0.32)",
  },

  composerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },

  floatingAssistantOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 6,
  },

  composerCard: {
    borderRadius: Radius.xl,
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },

  composerMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xxs,
    paddingVertical: 0,
  },

  composerInput: {
    flex: 1,
    maxHeight: MAX_INPUT_HEIGHT,
    color: Brand.ink,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: Spacing.sm,
  },

  sendButton: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
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

  drawerRoot: {
    flex: 1,
  },

  drawerScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    borderBottomColor: Brand.line,
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
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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

  chatListHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  chatListItemActive: {
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },

  chatListTitle: {
    flex: 1,
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },

  chatListKindBadge: {
    minWidth: 42,
    alignItems: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },

  chatListKindBadgeVoice: {
    backgroundColor: "rgba(87, 222, 255, 0.12)",
  },

  chatListKindBadgeText: {
    color: Brand.cocoa,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "900",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },

  settingsText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  accountCard: {
    marginTop: 14,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 138, 138, 0.16)",
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
    backgroundColor: "rgba(0, 0, 0, 0.58)",
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
    backgroundColor: "rgba(255, 255, 255, 0.20)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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

  voiceSwipeSurface: {
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  voiceLiveBadgeText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  voiceTopSpacer: {
    width: 38,
    height: 38,
  },

  voiceCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },

  voiceAssistantGlow: {
    position: "absolute",
    width: 280,
    height: 160,
    borderRadius: 999,
    backgroundColor: "rgba(87, 222, 255, 0.13)",
    transform: [{ translateY: 28 }],
  },

  voiceTitle: {
    ...Type.title,
    marginTop: Spacing.xxl,
    color: Brand.ink,
  },

  handsFreeBadge: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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

  voiceWaveWrap: {
    marginTop: 22,
    minHeight: 42,
    justifyContent: "center",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
