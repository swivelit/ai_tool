import React, { useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  KeyboardAvoidingView,
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
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import { apiDelete, apiGet, apiPost, apiPostForm } from "@/lib/api";
import { parseDatetime } from "@/lib/datetime";
import { saveScheduledTask } from "@/lib/localAgents";
import { ensureNotificationsReady, scheduleReminder } from "@/lib/reminders";
import { Item } from "@/lib/types";

type ChatHistoryItem = Item & {
  created_at?: string | null;
  source?: string | null;
};

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

type BackendChatResponse = {
  ok?: boolean;
  item?: (Item & { created_at?: string | null; source?: string | null }) | null;
  assistant?: {
    text?: string;
    english?: string;
    tamil?: string;
    theni_tamil?: string;
  } | null;
};

type PendingReminder = {
  title: string;
  details: string;
  datetimeText: string;
};

type RecorderSurface = "quick" | "live";

const MIN_INPUT_HEIGHT = 24;
const MAX_INPUT_HEIGHT = 130;
const RECORDING_STARTUP_SETTLE_MS = Platform.OS === "android" ? 320 : 160;
const CHAT_SESSIONS_STORAGE_PREFIX = "chat_sessions_v2";
const HIDDEN_CHAT_SESSIONS_STORAGE_PREFIX = "hidden_chat_session_ids_v2";
const HIDDEN_CHAT_ITEM_IDS_STORAGE_PREFIX = "hidden_chat_item_ids_v1";

function normalizeHandsFreeText(value?: string | null) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9஀-௿\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueHandsFreePhrases(values: string[]) {
  return Array.from(
    new Set(values.map((value) => normalizeHandsFreeText(value)).filter(Boolean))
  );
}

function buildWakePhraseCandidates(
  assistantName: string,
  wakePhrase?: string | null,
  trainedPhrases: string[] = []
) {
  const cleanName = normalizeHandsFreeText(assistantName);
  const explicitWakePhrase = normalizeHandsFreeText(wakePhrase);

  return uniqueHandsFreePhrases([
    explicitWakePhrase,
    ...trainedPhrases,
    cleanName ? `hey ${cleanName}` : "",
    cleanName ? `hi ${cleanName}` : "",
    cleanName ? `hello ${cleanName}` : "",
  ]);
}

function matchWakePhrase(input: string, phrases: string[]) {
  const normalizedInput = normalizeHandsFreeText(input);

  for (const phrase of phrases) {
    const normalizedPhrase = normalizeHandsFreeText(phrase);
    if (!normalizedPhrase) continue;

    if (normalizedInput === normalizedPhrase) {
      return { matched: true, command: "" };
    }

    if (normalizedInput.startsWith(`${normalizedPhrase} `)) {
      return {
        matched: true,
        command: normalizedInput.slice(normalizedPhrase.length).trim(),
      };
    }
  }

  return { matched: false, command: "" };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeChatResponse(
  payload: BackendChatResponse,
  fallbackRawText: string
): ChatHistoryItem {
  const item = payload?.item;

  if (item && typeof item === "object") {
    return {
      id: Number(item.id || Date.now()),
      intent: String(item.intent || "assistant"),
      category: String(item.category || "Other"),
      raw_text: String(item.raw_text || fallbackRawText || ""),
      transcript: item.transcript ?? null,
      datetime: item.datetime ?? null,
      title: item.title ?? null,
      details:
        item.details ||
        payload?.assistant?.text ||
        payload?.assistant?.theni_tamil ||
        payload?.assistant?.tamil ||
        payload?.assistant?.english ||
        item.raw_text ||
        fallbackRawText,
      created_at: item.created_at ?? new Date().toISOString(),
      source: item.source ?? "text",
    };
  }

  return {
    id: Date.now(),
    intent: "assistant",
    category: "Other",
    raw_text: fallbackRawText,
    transcript: null,
    datetime: null,
    title: "Assistant",
    details:
      payload?.assistant?.text ||
      payload?.assistant?.theni_tamil ||
      payload?.assistant?.tamil ||
      payload?.assistant?.english ||
      fallbackRawText,
    created_at: new Date().toISOString(),
    source: "text",
  };
}

function normalizeChatTurnPayload(
  payload: BackendChatResponse | ChatHistoryItem,
  fallbackRawText = ""
): ChatHistoryItem {
  if (payload && typeof payload === "object" && ("item" in payload || "assistant" in payload)) {
    return normalizeChatResponse(payload as BackendChatResponse, fallbackRawText);
  }

  const item = payload as ChatHistoryItem;
  return normalizeChatResponse(
    {
      item,
      assistant: {
        text: item.details || fallbackRawText,
      },
    },
    item.raw_text || fallbackRawText
  );
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

function uniqueNumberList(values: number[]) {
  return Array.from(
    new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value)))
  );
}

function filterHistoryItemsByHiddenItemIds(
  items: ChatHistoryItem[],
  hiddenItemIdSet: Set<number>
) {
  if (!hiddenItemIdSet.size) return items;

  return items.filter((item) => {
    const itemId = Number(item.id);
    return !Number.isFinite(itemId) || !hiddenItemIdSet.has(itemId);
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

function upsertHistoryItems(existing: ChatHistoryItem[], additions: ChatHistoryItem[]) {
  const map = new Map<number, ChatHistoryItem>();

  [...existing, ...additions].forEach((item) => {
    const itemId = Number(item?.id);
    if (!Number.isFinite(itemId)) return;
    map.set(itemId, {
      ...(map.get(itemId) || {}),
      ...item,
      id: itemId,
    } as ChatHistoryItem);
  });

  return Array.from(map.values()).sort((a, b) => Number(b.id) - Number(a.id));
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
  const tabBarHeight = useBottomTabBarHeight();
  const { width, height } = useWindowDimensions();
  const { name, settings, profile } = useAssistant();
  const { signOutUser } = useAuth();

  const [text, setText] = useState("");
  const [composerInputHeight, setComposerInputHeight] =
    useState(MIN_INPUT_HEIGHT);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingPreparing, setRecordingPreparing] = useState(false);
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
  const [historySearch, setHistorySearch] = useState("");
  const [hiddenChatSessionIds, setHiddenChatSessionIds] = useState<string[]>([]);
  const [hiddenChatItemIds, setHiddenChatItemIds] = useState<number[]>([]);
  const [chatActionsOpen, setChatActionsOpen] = useState(false);
  const [selectedHistoryItem, setSelectedHistoryItem] =
    useState<ChatSessionListItem | null>(null);
  const [handsFreeMode, setHandsFreeMode] = useState<"off" | "wake" | "command">("off");
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const [handsFreeTranscript, setHandsFreeTranscript] = useState("");
  const [handsFreeStatus, setHandsFreeStatus] = useState("");
  const [appState, setAppState] = useState(AppState.currentState);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const replySoundRef = useRef<Audio.Sound | null>(null);
  const replyPlaybackTokenRef = useRef(0);
  const recordingPhaseRef = useRef<"idle" | "starting" | "recording" | "stopping">(
    "idle"
  );
  const stopWhenReadyRef = useRef(false);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [drawerMounted, setDrawerMounted] = useState(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const historyLongPressTriggeredRef = useRef(false);
  const handsFreeDesiredModeRef = useRef<"off" | "wake" | "command">("off");
  const handsFreeStartingRef = useRef(false);
  const handsFreeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handsFreePermissionAlertedRef = useRef(false);
  const handsFreeBlockedRef = useRef(false);

  const isSmallPhone = width < 370 || height < 760;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 16);
  const bottomPadding = Platform.OS === "ios" ? Math.max(insets.bottom, 8) : 20;
  const composerBottomOffset =
    Platform.OS === "ios"
      ? -Math.max(tabBarHeight - insets.bottom, 0)
      : -Math.max(tabBarHeight - 12, 0);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 560);
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
  const handsFreeLocale = useMemo(
    () => (settings.languageMode === "ta" ? "ta-IN" : "en-IN"),
    [settings.languageMode]
  );
  const handsFreeForegroundEnabled = settings.handsFreeEnabled && appState === "active";
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
  const hiddenChatSessionIdSet = useMemo(
    () => new Set(hiddenChatSessionIds),
    [hiddenChatSessionIds]
  );
  const hiddenChatItemIdSet = useMemo(
    () => new Set(uniqueNumberList(hiddenChatItemIds)),
    [hiddenChatItemIds]
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

  const placeholder = recordingPreparing
    ? "Preparing microphone..."
    : listening
      ? "Recording... stop to send"
      : `Ask ${assistantLabel}`;

  const handsFreeSummaryText = recordingPreparing && activeSurface === "live"
    ? "Keep holding the orb. Start speaking when the orb begins pulsing."
    :
    handsFreeMode === "command"
      ? "Listening for your request…"
      : settings.handsFreeEnabled
        ? `Say "${handsFreeWakePhrase}" or hold the orb.`
        : "Press and hold the orb to record. Release to stop and send.";

  const drawerTranslateX = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 24, 0],
  });

  const drawerScrimOpacity = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

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

    queueHandsFreeRestart(nextMode, nextMode === "command" ? 180 : 450);
  });

  useSpeechRecognitionEvent("result", (event: any) => {
    if (handsFreeDesiredModeRef.current === "off") return;

    const transcript = String(event?.results?.[0]?.transcript || "").trim();
    if (!transcript) return;

    setHandsFreeTranscript(transcript);

    if (!event?.isFinal) return;

    if (handsFreeDesiredModeRef.current === "command") {
      handsFreeDesiredModeRef.current = "wake";
      setHandsFreeMode("wake");

      if (!transcript.trim()) {
        setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
        queueHandsFreeRestart("wake", 180);
        return;
      }

      void submitChatMessage(transcript, "handsfree");
      return;
    }

    const matched = matchWakePhrase(transcript, handsFreeWakeVariants);
    if (!matched.matched) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

    if (matched.command) {
      setVoiceSheetOpen(true);
      handsFreeDesiredModeRef.current = "wake";
      setHandsFreeMode("wake");
      setHandsFreeStatus("Working on it…");
      void submitChatMessage(matched.command, "handsfree");
      return;
    }

    setVoiceSheetOpen(true);
    handsFreeDesiredModeRef.current = "command";
    setHandsFreeMode("command");
    setHandsFreeStatus("Listening for your request…");
    void abortHandsFreeRecognizer(false);
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
      handsFreeDesiredModeRef.current = "off";
      setHandsFreeMode("off");

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

    handsFreeDesiredModeRef.current = "wake";
    setHandsFreeMode("wake");
    setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);

    if (handsFreeForegroundEnabled && !busy && !listening && !replySoundRef.current) {
      queueHandsFreeRestart("wake", 500);
    }
  });

  useEffect(() => {
    if (handsFreeForegroundEnabled) {
      handsFreeBlockedRef.current = false;
      handsFreePermissionAlertedRef.current = false;
      handsFreeDesiredModeRef.current = "wake";
      setHandsFreeMode("wake");
      setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
      queueHandsFreeRestart("wake", 120);
      return;
    }

    void shutdownHandsFree(true);
  }, [
    handsFreeForegroundEnabled,
    handsFreeLocale,
    handsFreeWakePhrase,
    handsFreeWakeVariants.join("|"),
    profile?.userId,
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
      queueHandsFreeRestart(handsFreeDesiredModeRef.current, 220);
    }
  }, [busy, listening, handsFreeForegroundEnabled, handsFreeActive]);

  useEffect(() => {
    if (!handsFreeForegroundEnabled) return;
    setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
  }, [handsFreeWakePhrase, handsFreeForegroundEnabled]);

  useEffect(() => {
    if (!busy && !listening && handsFreeForegroundEnabled && !handsFreeBlockedRef.current) {
      queueHandsFreeRestart("wake", 450);
    }
  }, [busy, listening, handsFreeForegroundEnabled]);

  useEffect(() => {
    void bootstrapChatState();
  }, [chatSessionStorageKey, hiddenChatStorageKey, hiddenChatItemStorageKey, profile?.userId]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (handsFreeRestartTimerRef.current) {
        clearTimeout(handsFreeRestartTimerRef.current);
        handsFreeRestartTimerRef.current = null;
      }
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

      const activeRecording = recordingRef.current;
      if (activeRecording) {
        void activeRecording.stopAndUnloadAsync().catch(() => undefined);
      }

      void Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: false,
      }).catch(() => undefined);
    };
  }, []);

  async function releaseReplySound(soundToRelease?: Audio.Sound | null) {
    const target = soundToRelease ?? replySoundRef.current;
    if (!target) return;

    if (!soundToRelease || replySoundRef.current === target) {
      replySoundRef.current = null;
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

    if (handsFreeForegroundEnabled && handsFreeDesiredModeRef.current !== "off") {
      queueHandsFreeRestart("wake", 320);
    }
  }

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

  function clearHandsFreeRestartTimer() {
    if (handsFreeRestartTimerRef.current) {
      clearTimeout(handsFreeRestartTimerRef.current);
      handsFreeRestartTimerRef.current = null;
    }
  }

  function queueHandsFreeRestart(nextMode: "wake" | "command" = "wake", delay = 350) {
    if (!handsFreeForegroundEnabled || handsFreeBlockedRef.current) return;

    clearHandsFreeRestartTimer();
    handsFreeDesiredModeRef.current = nextMode;

    handsFreeRestartTimerRef.current = setTimeout(() => {
      void startHandsFreeRecognizer(nextMode);
    }, delay);
  }

  async function abortHandsFreeRecognizer(clearDesiredMode = false) {
    clearHandsFreeRestartTimer();

    if (clearDesiredMode) {
      handsFreeDesiredModeRef.current = "off";
      setHandsFreeMode("off");
    }

    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // ignore
    }
  }

  async function shutdownHandsFree(clearStatus = false) {
    clearHandsFreeRestartTimer();
    handsFreeBlockedRef.current = false;
    handsFreeDesiredModeRef.current = "off";
    setHandsFreeMode("off");
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
  }

  async function startHandsFreeRecognizer(nextMode: "wake" | "command") {
    if (!handsFreeForegroundEnabled || handsFreeBlockedRef.current) return;
    if (busy || listening || replySoundRef.current || handsFreeStartingRef.current) return;

    clearHandsFreeRestartTimer();

    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      handsFreeBlockedRef.current = true;
      handsFreeDesiredModeRef.current = "off";
      setHandsFreeMode("off");
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
        handsFreeDesiredModeRef.current = "off";
        setHandsFreeMode("off");
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

      handsFreeDesiredModeRef.current = nextMode;
      setHandsFreeMode(nextMode);
      setHandsFreeStatus(
        nextMode === "command" ? "Listening for your request…" : `Say "${handsFreeWakePhrase}"`
      );
      setHandsFreeTranscript("");

      ExpoSpeechRecognitionModule.start({
        lang: handsFreeLocale,
        interimResults: true,
        maxAlternatives: 1,
        continuous:
          nextMode === "wake"
            ? Platform.OS !== "android" || Number(Platform.Version) >= 33
            : false,
        requiresOnDeviceRecognition: Platform.OS === "ios",
        addsPunctuation: false,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not start hands-free listening.";
      console.warn("[hands-free]", message);
      setHandsFreeStatus(message);
    } finally {
      handsFreeStartingRef.current = false;
    }
  }

  async function readChatHistoryFromApi(): Promise<ChatHistoryItem[]> {
    try {
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<ChatHistoryItem[]>(`/items${suffix}`);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function readStoredChatSessions(): Promise<ChatSessionRecord[]> {
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
  }

  async function readHiddenChatSessionIds(): Promise<string[]> {
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
  }

  async function readHiddenChatItemIds(): Promise<number[]> {
    try {
      const raw = await AsyncStorage.getItem(hiddenChatItemStorageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return uniqueNumberList(parsed);
    } catch {
      return [];
    }
  }

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

  async function bootstrapChatState() {
    const [itemsFromApi, storedSessions, storedHiddenSessionIds, storedHiddenItemIds] =
      await Promise.all([
        readChatHistoryFromApi(),
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
      itemsFromApi,
      migratedHiddenItemIdSet
    );

    setHistoryItems(visibleItemsFromApi);
    setHiddenChatSessionIds(storedHiddenSessionIds);
    setHiddenChatItemIds(migratedHiddenItemIds);

    const reconciled = reconcileChatSessions(visibleItemsFromApi, storedSessions);
    setChatSessions(reconciled);
    setActiveChatSessionId(null);

    try {
      await Promise.all([
        AsyncStorage.setItem(chatSessionStorageKey, JSON.stringify(reconciled)),
        AsyncStorage.setItem(
          hiddenChatItemStorageKey,
          JSON.stringify(migratedHiddenItemIds)
        ),
      ]);
    } catch {
      // ignore storage failures
    }
  }

  async function refreshHistoryAndSessions(extraItems: ChatHistoryItem[] = []) {
    const itemsFromApi = await readChatHistoryFromApi();
    const mergedItems = upsertHistoryItems(itemsFromApi, extraItems);
    const visibleMergedItems = filterHistoryItemsByHiddenItemIds(
      mergedItems,
      hiddenChatItemIdSet
    );

    setHistoryItems(visibleMergedItems);

    const reconciled = reconcileChatSessions(visibleMergedItems, chatSessions);
    setChatSessions(reconciled);

    try {
      await AsyncStorage.setItem(chatSessionStorageKey, JSON.stringify(reconciled));
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

    let workingSessions = reconcileChatSessions(latestItems, chatSessions)
      .map((session) => ({
        ...session,
        itemIds: session.itemIds.filter((value) => value !== itemId),
      }))
      .filter((session) => session.itemIds.length > 0);

    const timestamp = item.created_at || item.datetime || new Date().toISOString();

    if (activeChatSessionId) {
      const targetIndex = workingSessions.findIndex(
        (session) => session.id === activeChatSessionId
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
        setActiveChatSessionId(nextSession.id);
      }
    } else {
      const nextSession = createChatSessionFromItem(item);
      workingSessions = [nextSession, ...workingSessions];
      setActiveChatSessionId(nextSession.id);
    }

    workingSessions = workingSessions.sort(sortSessionsByRecent);
    setChatSessions(workingSessions);

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
    const deletedItemIds = uniqueNumberList(targetItem.items.map((item) => Number(item.id)));
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
              setActiveChatSessionId(null);
            }

            setHistoryItems((prev) =>
              filterHistoryItemsByHiddenItemIds(prev, new Set(nextHiddenChatItemIds))
            );
            setChatSessions((prev) =>
              prev.filter((session) => session.id !== targetItem.id)
            );

            await Promise.all([
              persistHiddenChatSessionIds(nextHiddenChatSessionIds),
              persistHiddenChatItemIds(nextHiddenChatItemIds),
            ]);

            closeHistoryItemActions();

            try {
              await Promise.all(
                deletedItemIds.map((itemId) =>
                  apiDelete(
                    `/items/${itemId}${
                      profile?.userId ? `?user_id=${profile.userId}` : ""
                    }`
                  )
                )
              );

              await refreshHistoryAndSessions();
            } catch (error: any) {
              Alert.alert(
                "Delete sync failed",
                error?.message ||
                  "The chat was hidden on this device, but the server copy could not be deleted."
              );
            }
          },
        },
      ]
    );
  }

  function closeReminderConfirm() {
    setConfirmOpen(false);
    setPendingReminder(null);
  }

  function startNewChat() {
    setActiveChatSessionId(null);
    setText("");
    setComposerInputHeight(MIN_INPUT_HEIGHT);
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
    setActiveChatSessionId(item.id);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }

  function openSettings() {
    closeDrawer();
    router.push("/modal");
  }

  async function playAgentReply(textValue: string) {
    if (!textValue) return;

    const playbackToken = replyPlaybackTokenRef.current + 1;
    replyPlaybackTokenRef.current = playbackToken;

    await abortHandsFreeRecognizer(false);
    await releaseReplySound();

    try {
      const data = await apiPost<{ audio_base64?: string }>("/api/tts", {
        text: textValue,
      });

      if (!data.audio_base64 || replyPlaybackTokenRef.current !== playbackToken) {
        return;
      }

      const uri = `data:audio/wav;base64,${data.audio_base64}`;
      const sound = new Audio.Sound();

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) {
          if (replySoundRef.current === sound) {
            replySoundRef.current = null;
          }
          return;
        }

        if (status.didJustFinish) {
          void releaseReplySound(sound);
        }
      });

      await sound.loadAsync(
        { uri },
        {
          shouldPlay: true,
          progressUpdateIntervalMillis: 250,
        }
      );

      if (replyPlaybackTokenRef.current !== playbackToken) {
        await releaseReplySound(sound);
        return;
      }

      replySoundRef.current = sound;
    } catch {
      // ignore playback failures
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

    try {
      setBusy(true);

      if (source === "text") {
        setText("");
        setComposerInputHeight(MIN_INPUT_HEIGHT);
      } else {
        setHandsFreeStatus("Working on it…");
      }

      const response = await apiPost<BackendChatResponse>("/api/chat", {
        user_id: profile.userId,
        message: cleaned,
        reply_language: settings.languageMode,
      });

      const nextItem = normalizeChatTurnPayload(response, cleaned);
      const mergedHistory = await refreshHistoryAndSessions([nextItem]);
      await attachItemToCurrentChat(nextItem, mergedHistory);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (nextItem.details) {
        void playAgentReply(nextItem.details);
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
      const message =
        error instanceof Error ? error.message : "Failed to process your request.";
      Alert.alert("Error", message);
    } finally {
      setBusy(false);

      if (handsFreeForegroundEnabled) {
        setHandsFreeMode("wake");
        setHandsFreeStatus(`Say "${handsFreeWakePhrase}"`);
        queueHandsFreeRestart("wake", 520);
      }
    }
  }

  async function handleChatSend() {
    await submitChatMessage(text, "text");
  }

  async function startRecording(surface: RecorderSurface) {
    if (busy || recordingPhaseRef.current !== "idle") return;

    try {
      await abortHandsFreeRecognizer(false);
      await releaseReplySound();
      recordingPhaseRef.current = "starting";
      stopWhenReadyRef.current = false;
      setActiveSurface(surface);
      setRecordingPreparing(true);
      setListening(false);

      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        recordingPhaseRef.current = "idle";
        setRecordingPreparing(false);
        setListening(false);
        setActiveSurface(null);
        Alert.alert("Mic permission needed", "Please allow microphone access.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const nextRecording = new Audio.Recording();
      await nextRecording.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      await nextRecording.startAsync();
      await wait(RECORDING_STARTUP_SETTLE_MS);

      recordingRef.current = nextRecording;
      setRecording(nextRecording);
      recordingPhaseRef.current = "recording";
      setRecordingPreparing(false);
      setListening(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (stopWhenReadyRef.current) {
        stopWhenReadyRef.current = false;
        await stopAndAnalyze();
      }
    } catch (error: unknown) {
      recordingPhaseRef.current = "idle";
      stopWhenReadyRef.current = false;
      recordingRef.current = null;
      setRecording(null);
      setRecordingPreparing(false);
      setListening(false);
      setActiveSurface(null);
      await resetAudioMode();
      const message =
        error instanceof Error ? error.message : "Could not start recording.";
      Alert.alert("Error", message);
    }
  }

  async function stopAndAnalyze() {
    if (recordingPhaseRef.current === "starting") {
      stopWhenReadyRef.current = true;
      return;
    }

    const activeRecording = recordingRef.current;
    if (!activeRecording || recordingPhaseRef.current !== "recording") {
      return;
    }

    try {
      recordingPhaseRef.current = "stopping";
      stopWhenReadyRef.current = false;
      setBusy(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      recordingRef.current = null;
      setRecording(null);
      setRecordingPreparing(false);
      setListening(false);

      await activeRecording.stopAndUnloadAsync();
      await resetAudioMode();

      const uri = activeRecording.getURI();
      if (!uri) throw new Error("No audio file URI");

      const form = new FormData();
      form.append(
        "file",
        {
          uri,
          name: "audio.m4a",
          type: "audio/m4a",
        } as any
      );

      const res = await apiPostForm<BackendChatResponse | ChatHistoryItem>(
        `/transcribe-and-analyze?user_id=${profile?.userId ?? ""}&reply_language=${
          settings.languageMode
        }`,
        form
      );

      const nextItem = normalizeChatTurnPayload(res);
      const mergedHistory = await refreshHistoryAndSessions([nextItem]);
      await attachItemToCurrentChat(nextItem, mergedHistory);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (nextItem.details) {
        void playAgentReply(nextItem.details);
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
      const message = error instanceof Error ? error.message : "Voice analysis failed.";
      Alert.alert("Error", message);
    } finally {
      recordingPhaseRef.current = "idle";
      stopWhenReadyRef.current = false;
      recordingRef.current = null;
      setRecording(null);
      setRecordingPreparing(false);
      setListening(false);
      setBusy(false);
      setActiveSurface(null);
      await resetAudioMode();
    }
  }

  async function handleQuickMicPress() {
    if (busy) return;

    if (
      recordingPhaseRef.current === "starting" ||
      recordingPhaseRef.current === "recording"
    ) {
      await stopAndAnalyze();
      return;
    }

    await startRecording("quick");
  }

  async function handleLiveOrbPressIn() {
    if (busy || recordingPhaseRef.current !== "idle") return;
    await startRecording("live");
  }

  async function handleLiveOrbPressOut() {
    if (
      recordingPhaseRef.current === "starting" ||
      recordingPhaseRef.current === "recording"
    ) {
      await stopAndAnalyze();
    }
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

  function clearComposer() {
    setText("");
    setComposerInputHeight(MIN_INPUT_HEIGHT);
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

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        enabled={Platform.OS === "ios"}
      >
        <View style={styles.screen}>
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
            <Pressable onPress={openDrawer} style={styles.iconButton}>
              <Ionicons name="menu" size={20} color={Brand.cocoa} />
            </Pressable>

            <View style={styles.topBarCenter}>
              <Text style={styles.topBarTitle}>{assistantLabel}</Text>
            </View>

            <Pressable onPress={() => setVoiceSheetOpen(true)} style={styles.iconButton}>
              <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
            </Pressable>
          </View>

          <ScrollView
            ref={scrollViewRef}
            style={styles.scrollArea}
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: horizontalPadding,
              paddingTop: 8,
              paddingBottom: 210,
              alignItems: "center",
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              {chatTimeline.length > 0 || (busy && !listening) ? (
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
                                <Text style={[styles.messageText, styles.assistantMessageText]}>
                                  {assistantMessage}
                                </Text>
                              </View>
                              <Text style={styles.messageMeta}>{timeLabel}</Text>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}

                  {busy && !listening ? (
                    <View style={[styles.messageRow, styles.messageRowAssistant]}>
                      <View style={styles.assistantAvatar}>
                        <Text style={styles.assistantAvatarText}>
                          {assistantLabel.slice(0, 1).toUpperCase()}
                        </Text>
                      </View>

                      <View style={styles.assistantMessageBlock}>
                        <Text style={styles.messageSender}>{assistantLabel}</Text>
                        <View style={[styles.messageBubble, styles.assistantBubble, styles.typingBubble]}>
                          <ActivityIndicator size="small" color={Brand.cocoa} />
                          <Text style={styles.typingText}>Thinking…</Text>
                        </View>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {activeSurface === "quick" && (recordingPreparing || listening) ? (
                <GlassCard style={styles.quickRecorderCard}>
                  <View style={styles.quickRecorderHeader}>
                    <View style={styles.recordingDot} />
                    <Text style={styles.quickRecorderTitle}>{recordingPreparing ? "Preparing microphone" : "Recording voice message"}</Text>
                  </View>

                  <View style={styles.quickRecorderBody}>
                    <Waveform active={listening} />
                    <Pressable onPress={handleQuickMicPress} style={styles.stopButton}>
                      <Ionicons name="stop" size={18} color={Brand.cream} />
                    </Pressable>
                  </View>
                </GlassCard>
              ) : null}
            </View>
          </ScrollView>

          <View
            style={[
              styles.composerShell,
              {
                paddingHorizontal: horizontalPadding,
                paddingBottom: bottomPadding,
                bottom: composerBottomOffset,
              },
            ]}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              <View style={styles.composerCard}>
                <View style={styles.composerMainRow}>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={placeholder}
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

                  <View style={styles.composerInlineActions}>
                    <Pressable
                      onPress={handleQuickMicPress}
                      disabled={busy && !listening}
                      style={[
                        styles.roundAction,
                        (recordingPreparing || listening) && activeSurface === "quick" && styles.roundActionActive,
                        busy && !listening && styles.iconButtonDisabled,
                      ]}
                    >
                      <Ionicons
                        name={
                          (recordingPreparing || listening) && activeSurface === "quick" ? "stop" : "mic-outline"
                        }
                        size={18}
                        color={Brand.cocoa}
                      />
                    </Pressable>

                    <Pressable
                      onPress={handleChatSend}
                      disabled={!text.trim() || busy || listening}
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

                {recordingPreparing ? (
                  <Text style={styles.composerHintText}>
                    Preparing microphone... keep holding and start speaking when recording begins
                  </Text>
                ) : listening ? (
                  <Text style={styles.composerHintText}>
                    Recording in progress... tap stop or release the orb
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

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
        onRequestClose={() => setVoiceSheetOpen(false)}
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

            <Pressable onPress={() => setVoiceSheetOpen(false)} style={styles.voiceCloseButton}>
              <Ionicons name="close" size={18} color={Brand.cream} />
            </Pressable>
          </View>

          <View style={styles.voiceCenter}>
            <View pointerEvents="none" style={styles.voiceOrbGlow} />
            <Orb
              listening={listening && activeSurface === "live"}
              onPressIn={handleLiveOrbPressIn}
              onPressOut={handleLiveOrbPressOut}
              size={orbSize}
            />

            <Text style={styles.voiceTitle}>
              {recordingPreparing && activeSurface === "live"
                ? "Preparing microphone..."
                : listening && activeSurface === "live"
                  ? "Listening..."
                  : handsFreeActive
                    ? "Hands-free ready"
                    : "Start Talking"}
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

            {(recordingPreparing || listening) && activeSurface === "live" ? (
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
                  setVoiceSheetOpen(false);
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
                onPress={async () => {
                  if (
                    recordingPhaseRef.current === "starting" ||
                    recordingPhaseRef.current === "recording"
                  ) {
                    await stopAndAnalyze();
                  } else {
                    setVoiceSheetOpen(false);
                  }
                }}
                style={styles.voiceDockButtonDanger}
              >
                <Ionicons
                  name={(recordingPreparing || listening) && activeSurface === "live" ? "stop" : "close"}
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

  quickRecorderCard: {
    marginTop: 16,
    padding: 16,
    borderRadius: 24,
  },

  quickRecorderHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: "#e04f4f",
  },

  quickRecorderTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  quickRecorderBody: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  },

  stopButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.caramel,
  },

  composerShell: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
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


  composerHintText: {
    marginTop: 6,
    paddingHorizontal: 6,
    color: Brand.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },

  composerInlineActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  roundAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.soft,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  roundActionActive: {
    backgroundColor: "rgba(255, 227, 180, 0.9)",
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