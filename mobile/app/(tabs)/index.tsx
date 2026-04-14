import React, { useEffect, useMemo, useRef, useState } from "react";
import { saveScheduledTask } from "@/lib/localAgents";
import {
  ActivityIndicator,
  Alert,
  Animated,
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
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import { parseDatetime } from "@/lib/datetime";
import { apiGet, apiPost, apiPostForm } from "@/lib/api";
import { scheduleReminder } from "@/lib/reminders";
import { Item } from "@/lib/types";

type AnalyzeResponse = Item;

type BackendChatResponse = {
  ok?: boolean;
  item?: Item | null;
  assistant?: {
    text?: string;
    english?: string;
    tamil?: string;
    theni_tamil?: string;
  } | null;
};

function normalizeChatResponse(
  payload: BackendChatResponse,
  fallbackRawText: string
): Item {
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
  };
}

type PendingReminder = {
  title: string;
  details: string;
  datetimeText: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getDayPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatIntentLabel(value?: string | null) {
  const source = (value || "assistant").replace(/[_-]+/g, " ").trim();
  if (!source) return "Assistant";

  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatHistoryTime(value?: string | null) {
  if (!value) return "No time";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No time";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const timeText = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (sameDay) return `Today · ${timeText}`;

  return `${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })} · ${timeText}`;
}

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name, settings, profile } = useAssistant();
  const { signOutUser } = useAuth();

  const minComposerInputHeight = 24;
  const [text, setText] = useState("");
  const [composerInputHeight, setComposerInputHeight] = useState(
    minComposerInputHeight
  );
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [listening, setListening] = useState(false);

  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingReminder, setPendingReminder] =
    useState<PendingReminder | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyItems, setHistoryItems] = useState<Item[]>([]);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingPhaseRef = useRef<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  const stopWhenReadyRef = useRef(false);

  const isSmallPhone = width < 370 || height < 760;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 8 : 12);
  const orbSize = clamp(width * 0.42, 156, 220);
  const drawerWidth = Math.min(width * 0.86, 360);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 560);
  const composerBottomPadding = Math.max(insets.bottom + 12, 16);
  const scrollBottomPadding = 28;

  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [drawerMounted, setDrawerMounted] = useState(false);

  const greetingName = useMemo(
    () => (profile?.name || "there").trim(),
    [profile?.name]
  );
  const assistantLabel = useMemo(() => (name || "Elli").trim(), [name]);
  const greeting = useMemo(
    () => `${getDayPart()}, ${greetingName}`,
    [greetingName]
  );

  const filteredHistory = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) return historyItems.slice(0, 24);

    return historyItems.filter((item) => {
      const blob = `${item.title || ""} ${item.details || ""} ${
        item.raw_text || ""
      } ${item.intent || ""}`.toLowerCase();
      return blob.includes(query);
    });
  }, [historyItems, historySearch]);

  const resultText = result?.details || result?.raw_text || "";
  const hasConversation = Boolean(lastPrompt || resultText || busy);
  const placeholder = listening
    ? "Recording... release to stop and send"
    : `Message ${assistantLabel}`;
  const maxComposerInputHeight = 220;

  const drawerTranslateX = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 28, 0],
  });

  const drawerScrimOpacity = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  useEffect(() => {
    void loadHistory();
  }, [profile?.userId]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    return () => {
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
      // Ignore cleanup failures.
    }
  }

  async function loadHistory() {
    try {
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<Item[]>(`/items${suffix}`);
      setHistoryItems(Array.isArray(data) ? data : []);
    } catch {
      setHistoryItems([]);
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

  function closeReminderConfirm() {
    setConfirmOpen(false);
    setPendingReminder(null);
  }

  async function analyzeText() {
    if (!text.trim() || busy || !profile?.userId) return;

    try {
      setBusy(true);

      const cleaned = stripAssistantTrigger(text);
      setLastPrompt(cleaned);

      const response = await apiPost<BackendChatResponse>("/api/chat", {
        user_id: profile?.userId ?? undefined,
        message: cleaned,
        reply_language: settings.languageMode,
      });

      const nextItem = normalizeChatResponse(response, cleaned);

      setLastPrompt(cleaned);
      setResult(nextItem);
      setText("");
      setComposerInputHeight(minComposerInputHeight);
      await loadHistory();
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );

      if (nextItem.intent === "reminder" && nextItem.datetime) {
        setPendingReminder({
          title: nextItem.title || "Reminder",
          details: nextItem.details || nextItem.raw_text,
          datetimeText: nextItem.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Failed to process your request.");
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    if (busy || recordingPhaseRef.current !== "idle") return;

    try {
      recordingPhaseRef.current = "starting";
      stopWhenReadyRef.current = false;

      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setListening(true);

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        recordingPhaseRef.current = "idle";
        setListening(false);
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

      recordingRef.current = nextRecording;
      setRecording(nextRecording);
      recordingPhaseRef.current = "recording";

      if (stopWhenReadyRef.current) {
        stopWhenReadyRef.current = false;
        await stopAndAnalyze();
      }
    } catch (error: any) {
      recordingPhaseRef.current = "idle";
      stopWhenReadyRef.current = false;
      recordingRef.current = null;
      setRecording(null);
      setListening(false);
      await resetAudioMode();
      Alert.alert("Error", error?.message || "Could not start recording.");
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
      setListening(false);

      await activeRecording.stopAndUnloadAsync();
      await resetAudioMode();

      const uri = activeRecording.getURI();

      if (!uri) {
        throw new Error("No audio file URI");
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

      const res = await apiPostForm<AnalyzeResponse>(
        `/transcribe-and-analyze?user_id=${
          profile?.userId ?? ""
        }&reply_language=${settings.languageMode}`,
        form
      );

      setLastPrompt(res.transcript || "Voice request");
      setResult(res);
      await loadHistory();
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );

      if (res.intent === "reminder" && res.datetime) {
        setPendingReminder({
          title: res.title || "Reminder",
          details: res.details || res.raw_text,
          datetimeText: res.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Voice analysis failed.");
    } finally {
      recordingPhaseRef.current = "idle";
      stopWhenReadyRef.current = false;
      recordingRef.current = null;
      setRecording(null);
      setListening(false);
      await resetAudioMode();
      setBusy(false);
    }
  }

  async function handleHoldPressIn() {
    if (busy || recordingPhaseRef.current !== "idle") return;
    await startRecording();
  }

  async function handleHoldPressOut() {
    if (
      recordingPhaseRef.current === "starting" ||
      recordingPhaseRef.current === "recording"
    ) {
      await stopAndAnalyze();
    }
  }

  async function handleOrbPressIn() {
    await handleHoldPressIn();
  }

  async function handleOrbPressOut() {
    await handleHoldPressOut();
  }

  async function confirmScheduleReminder() {
    if (!pendingReminder || !profile?.userId) return;

    try {
      setBusy(true);
      const timezone = profile?.timezone || "Asia/Kolkata";
      const parsed = await parseDatetime(
        pendingReminder.datetimeText,
        timezone
      );

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

      await scheduleReminder(
        pendingReminder.title,
        pendingReminder.details,
        when
      );

      await saveScheduledTask(profile.userId, {
        title: pendingReminder.title,
        details: pendingReminder.details,
        datetimeText: pendingReminder.datetimeText,
        isoDatetime: parsed.iso,
        status: "scheduled",
      });

      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );
      Alert.alert("Reminder set ✅", parsed.human || when.toString());
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Failed to schedule reminder.");
    } finally {
      setBusy(false);
      closeReminderConfirm();
    }
  }

  function clearConversation() {
    setResult(null);
    setLastPrompt("");
    setText("");
    setComposerInputHeight(minComposerInputHeight);
  }

  function openHistoryItem(item: Item) {
    setLastPrompt(item.raw_text || item.title || "");
    setResult(item);
    closeDrawer();
  }

  function openSchedule() {
    closeDrawer();
    router.push("/(tabs)/explore");
  }

  function openRoutine() {
    closeDrawer();
    router.push("./routine");
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
            // Do not call refresh() here.
            // Do not call closeDrawer() here after sign-out.
            // Do not call router.replace("/") here.
            // Root app/_layout.tsx RouteGate should handle navigation.
          } catch (error: any) {
            Alert.alert("Error", error?.message || "Failed to sign out.");
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
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <View style={styles.screen}>
          <View
            style={[
              styles.topBar,
              {
                width: contentMaxWidth,
                paddingTop: topPadding,
                paddingHorizontal: 0,
                alignSelf: "center",
              },
            ]}
          >
            <Pressable onPress={() => openDrawer()} style={styles.topIconBtn}>
              <Ionicons name="menu" size={19} color={Brand.cocoa} />
            </Pressable>

            <Pressable onPress={openRoutine} style={styles.topIconBtn}>
              <Ionicons name="options-outline" size={18} color={Brand.cocoa} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: horizontalPadding,
              paddingTop: 8,
              paddingBottom: scrollBottomPadding,
              alignItems: "center",
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              <View style={styles.heroStage}>
                <View pointerEvents="none" style={styles.heroAmbientTop} />

                <View style={styles.heroHeaderRow}>
                  <View style={styles.heroStatusChip}>
                    {busy ? (
                      <ActivityIndicator size="small" color={Brand.bronze} />
                    ) : (
                      <Ionicons
                        name="checkmark-circle"
                        size={14}
                        color={Brand.success}
                      />
                    )}
                    <Text style={styles.heroStatusText}>
                      {busy ? "Working" : "Ready"}
                    </Text>
                  </View>
                </View>

                <View style={styles.heroTextWrap}>
                  <Text style={styles.greeting}>{greeting}</Text>
                </View>

                <View style={styles.orbShell}>
                  <LinearGradient
                    pointerEvents="none"
                    colors={[
                      "rgba(255,255,255,0.70)",
                      "rgba(255,240,212,0.30)",
                      "rgba(215,154,89,0.10)",
                      "rgba(215,154,89,0.00)",
                    ]}
                    start={{ x: 0.2, y: 0.08 }}
                    end={{ x: 0.82, y: 1 }}
                    style={styles.orbAmbientDisc}
                  />
                  <View pointerEvents="none" style={styles.orbAmbientGlow} />
                  <View
                    pointerEvents="none"
                    style={styles.orbAmbientGlowSoft}
                  />
                  <Orb
                    listening={listening}
                    onPressIn={handleOrbPressIn}
                    onPressOut={handleOrbPressOut}
                    size={orbSize}
                  />
                </View>

                {listening ? (
                  <View style={styles.inlineWaveWrap}>
                    <Waveform active />
                  </View>
                ) : null}
              </View>

              {hasConversation ? (
                <GlassCard style={styles.conversationCard}>
                  <View style={styles.sectionHeaderRow}>
                    <View>
                      <Text style={styles.sectionTitle}>Current response</Text>
                      <Text style={styles.sectionSubtitle}>
                        Everything from your current request, in one place.
                      </Text>
                    </View>

                    <View style={styles.intentChip}>
                      <Ionicons
                        name="sparkles-outline"
                        size={14}
                        color={Brand.bronze}
                      />
                      <Text style={styles.intentChipText}>
                        {formatIntentLabel(result?.intent)}
                      </Text>
                    </View>
                  </View>

                  {lastPrompt ? (
                    <View style={styles.promptCard}>
                      <Text style={styles.promptLabel}>You</Text>
                      <Text style={styles.promptText}>{lastPrompt}</Text>
                    </View>
                  ) : null}

                  <View style={styles.responseCard}>
                    <View style={styles.responseHeaderRow}>
                      <View>
                        <Text style={styles.responseName}>{assistantLabel}</Text>
                        <Text style={styles.responseMeta}>
                          {busy && !resultText
                            ? "Analyzing your request"
                            : "Response ready"}
                        </Text>
                      </View>

                      <View style={styles.responseBadge}>
                        <Ionicons
                          name="sparkles"
                          size={14}
                          color={Brand.bronze}
                        />
                      </View>
                    </View>

                    <Text style={styles.responseText}>
                      {busy && !resultText
                        ? "Thinking..."
                        : resultText || "No response yet."}
                    </Text>

                    <View style={styles.responseChipsRow}>
                      {result?.datetime ? (
                        <View style={styles.metaChip}>
                          <Ionicons
                            name="time-outline"
                            size={14}
                            color={Brand.bronze}
                          />
                          <Text style={styles.metaChipText}>
                            {result.datetime}
                          </Text>
                        </View>
                      ) : null}

                      {result?.category ? (
                        <View style={styles.metaChip}>
                          <Ionicons
                            name="albums-outline"
                            size={14}
                            color={Brand.bronze}
                          />
                          <Text style={styles.metaChipText}>
                            {formatIntentLabel(result.category)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </GlassCard>
              ) : null}
            </View>
          </ScrollView>

          <View
            style={[
              styles.bottomComposerShell,
              {
                paddingHorizontal: horizontalPadding,
                paddingBottom: composerBottomPadding,
              },
            ]}
          >
            <View style={{ width: "100%", maxWidth: contentMaxWidth }}>
              <View style={styles.composerWrap}>
                <View style={styles.composerBox}>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={placeholder}
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
                    multiline
                    scrollEnabled={composerInputHeight >= maxComposerInputHeight}
                    textAlignVertical="top"
                    onContentSizeChange={(event) => {
                      const measuredHeight = Math.ceil(
                        event.nativeEvent.contentSize.height
                      );
                      const nextHeight = clamp(
                        measuredHeight,
                        minComposerInputHeight,
                        maxComposerInputHeight
                      );
                      setComposerInputHeight(nextHeight);
                    }}
                    style={[
                      styles.composerInput,
                      { height: composerInputHeight },
                    ]}
                  />

                  <View style={styles.composerActionsRow}>
                    <View style={styles.composerHintWrap}>
                      <Ionicons
                        name={
                          listening ? "radio" : "chatbubble-ellipses-outline"
                        }
                        size={14}
                        color={Brand.muted}
                      />
                      <Text style={styles.composerHintText}>
                        {listening
                          ? "Recording... release to stop and send"
                          : "Press and hold the orb to record"}
                      </Text>
                    </View>

                    <View style={styles.composerButtonsWrap}>
                      <Pressable
                        onPress={clearConversation}
                        style={styles.composerSecondaryBtn}
                        accessibilityLabel="Clear message"
                      >
                        <Ionicons
                          name="refresh-outline"
                          size={16}
                          color={Brand.cocoa}
                        />
                      </Pressable>

                      <Pressable
                        onPress={analyzeText}
                        disabled={busy || !text.trim()}
                        style={[
                          styles.composerActionBtn,
                          text.trim() ? styles.sendBtn : styles.sendBtnDisabled,
                        ]}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color={Brand.ink} />
                        ) : (
                          <Ionicons
                            name="arrow-up"
                            size={18}
                            color={
                              text.trim()
                                ? Brand.ink
                                : "rgba(124, 99, 80, 0.48)"
                            }
                          />
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
          statusBarTranslucent
          onRequestClose={closeDrawer}
        >
          <View style={styles.drawerModalRoot}>
            <Animated.View
              pointerEvents="none"
              style={[styles.drawerScrim, { opacity: drawerScrimOpacity }]}
            />

            <View style={styles.drawerBackdrop}>
              <Animated.View
                style={[
                  styles.drawerPanelWrap,
                  {
                    width: drawerWidth,
                    transform: [{ translateX: drawerTranslateX }],
                  },
                ]}
              >
                <LinearGradient
                  colors={["#fffaf2", "#fff0d2", "#ffe5b4"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[
                    styles.drawerPanel,
                    {
                      paddingTop: Math.max(
                        insets.top + 14,
                        Platform.OS === "ios" ? 56 : 28
                      ),
                      paddingBottom: Math.max(insets.bottom + 18, 18),
                    },
                  ]}
                >
                  <View style={styles.drawerHeader}>
                    <View style={styles.drawerSearchWrap}>
                      <Ionicons
                        name="search"
                        size={15}
                        color="rgba(124, 99, 80, 0.6)"
                      />
                      <TextInput
                        value={historySearch}
                        onChangeText={setHistorySearch}
                        placeholder="Search your history"
                        placeholderTextColor="rgba(124, 99, 80, 0.42)"
                        style={styles.drawerSearchInput}
                      />
                    </View>

                    <Pressable
                      onPress={closeDrawer}
                      style={styles.drawerCloseBtn}
                    >
                      <Ionicons name="close" size={18} color={Brand.cocoa} />
                    </Pressable>
                  </View>

                  <View style={styles.drawerTitleRow}>
                    <View>
                      <Text style={styles.drawerSectionTitle}>Workspace</Text>
                    </View>
                  </View>

                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingBottom: 18 }}
                  >
                    <Text style={styles.drawerLabel}>Recent requests</Text>

                    {filteredHistory.length === 0 ? (
                      <View style={styles.historyEmptyCard}>
                        <Ionicons
                          name="time-outline"
                          size={18}
                          color={Brand.muted}
                        />
                        <Text style={styles.historyEmptyText}>
                          No history yet
                        </Text>
                      </View>
                    ) : (
                      filteredHistory.map((item) => (
                        <Pressable
                          key={item.id}
                          onPress={() => openHistoryItem(item)}
                          style={styles.drawerHistoryItem}
                        >
                          <View style={styles.drawerHistoryIcon}>
                            <Ionicons
                              name="sparkles-outline"
                              size={15}
                              color={Brand.bronze}
                            />
                          </View>

                          <View style={{ flex: 1 }}>
                            <Text
                              style={styles.drawerHistoryTitle}
                              numberOfLines={1}
                            >
                              {item.raw_text ||
                                item.title ||
                                "Untitled request"}
                            </Text>
                            <Text
                              style={styles.drawerHistoryMeta}
                              numberOfLines={1}
                            >
                              {formatIntentLabel(item.intent)} ·{" "}
                              {formatHistoryTime(item.datetime)}
                            </Text>
                          </View>

                          <Ionicons
                            name="chevron-forward"
                            size={16}
                            color="rgba(124, 99, 80, 0.58)"
                          />
                        </Pressable>
                      ))
                    )}
                  </ScrollView>

                  <View style={styles.drawerFooter}>
                    <Pressable
                      onPress={openRoutine}
                      style={styles.drawerFooterCard}
                    >
                      <Ionicons
                        name="settings-outline"
                        size={16}
                        color={Brand.cocoa}
                      />
                      <Text style={styles.drawerFooterCardText}>Settings</Text>
                    </Pressable>

                    <Pressable
                      onPress={openSchedule}
                      style={styles.drawerFooterCard}
                    >
                      <Ionicons
                        name="calendar-outline"
                        size={16}
                        color={Brand.cocoa}
                      />
                      <Text style={styles.drawerFooterCardText}>Schedule</Text>
                    </Pressable>

                    <View style={styles.accountCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.accountTitle}>Account</Text>
                        <Text
                          style={styles.accountSubtitle}
                          numberOfLines={1}
                        >
                          {profile?.name || "Local account"}
                        </Text>
                        <Text style={styles.accountMeta} numberOfLines={1}>
                          {profile?.place ||
                            profile?.timezone ||
                            "Assistant user"}
                        </Text>
                      </View>

                      <Pressable onPress={signOut} style={styles.signOutBtn}>
                        <Text style={styles.signOutBtnText}>Sign out</Text>
                      </Pressable>
                    </View>
                  </View>
                </LinearGradient>
              </Animated.View>

              <Pressable
                style={styles.drawerDismissArea}
                onPress={closeDrawer}
              />
            </View>
          </View>
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
                <Ionicons
                  name="notifications-outline"
                  size={20}
                  color={Brand.bronze}
                />
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

                <Text style={[styles.modalInfoLabel, { marginTop: 14 }]}>
                  Detected time
                </Text>
                <Text style={styles.modalInfoValue}>
                  {pendingReminder?.datetimeText || "No time detected"}
                </Text>
              </View>

              <View style={styles.modalActionsRow}>
                <Pressable
                  onPress={closeReminderConfirm}
                  style={styles.modalSecondaryBtn}
                >
                  <Text style={styles.modalSecondaryBtnText}>Cancel</Text>
                </Pressable>

                <Pressable
                  onPress={confirmScheduleReminder}
                  style={styles.modalPrimaryBtn}
                >
                  <LinearGradient
                    colors={Brand.gradients.button}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.modalPrimaryBtnInner}
                  >
                    <Text style={styles.modalPrimaryBtnText}>
                      {busy ? "Scheduling..." : "Confirm"}
                    </Text>
                  </LinearGradient>
                </Pressable>
              </View>
            </GlassCard>
          </View>
        </Modal>
      </KeyboardAvoidingView>
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
    top: -100,
    right: -36,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.55)",
  },

  leftGlow: {
    position: "absolute",
    top: 260,
    left: -84,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -120,
    right: -22,
    width: 280,
    height: 280,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.18)",
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topBrandWrap: {
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },

  topBrandPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    maxWidth: "72%",
  },

  topBrandText: {
    color: Brand.ink,
    fontSize: 13,
    fontWeight: "800",
  },

  topBrandCaption: {
    color: Brand.muted,
    fontSize: 11,
    fontWeight: "700",
  },

  heroStage: {
    marginTop: 12,
    paddingTop: 4,
    paddingBottom: 18,
    position: "relative",
  },

  heroAmbientTop: {
    position: "absolute",
    top: -40,
    right: -16,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
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
    backgroundColor: "rgba(255,255,255,0.66)",
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroTextWrap: {
    marginTop: 18,
  },

  greeting: {
    color: Brand.bronze,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  heroHeadline: {
    marginTop: 10,
    color: Brand.ink,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
    fontWeight: "500",
  },

  orbShell: {
    marginTop: 22,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 270,
  },

  orbAmbientDisc: {
    position: "absolute",
    width: 330,
    height: 330,
    borderRadius: 999,
  },

  orbAmbientGlow: {
    position: "absolute",
    width: 272,
    height: 272,
    borderRadius: 999,
    backgroundColor: "rgba(255, 229, 180, 0.18)",
  },

  orbAmbientGlowSoft: {
    position: "absolute",
    width: 236,
    height: 236,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(214, 167, 113, 0.12)",
    backgroundColor: "rgba(255,255,255,0.12)",
  },

  inlineWaveWrap: {
    alignSelf: "center",
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.55)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  bottomComposerShell: {
    width: "100%",
    alignItems: "center",
    paddingTop: 12,
  },

  composerWrap: {
    marginTop: 0,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
    maxWidth: "84%",
  },

  ghostChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.6)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  ghostChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  composerBox: {
    padding: 14,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  composerInput: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 22,
    paddingTop: 0,
    paddingBottom: 0,
  },

  composerActionsRow: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  composerHintWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  composerHintText: {
    flex: 1,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "600",
  },

  composerButtonsWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  composerActionBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },

  composerSecondaryBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sendBtn: {
    backgroundColor: Brand.peach,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.65)",
  },

  sendBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  conversationCard: {
    marginTop: 16,
    borderRadius: 28,
  },

  intentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.6)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  intentChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  promptCard: {
    marginTop: 18,
    marginLeft: "auto",
    maxWidth: "92%",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 22,
    backgroundColor: Brand.ink,
  },

  promptLabel: {
    color: "rgba(255,255,255,0.68)",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  promptText: {
    marginTop: 6,
    color: "#fff8ec",
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
  },

  responseCard: {
    marginTop: 14,
    padding: 16,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  responseHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  responseName: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  responseMeta: {
    marginTop: 3,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  responseBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  responseText: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "500",
  },

  responseChipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,248,236,0.9)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metaChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  historyCard: {
    marginTop: 20,
    marginBottom: 4,
    borderRadius: 28,
  },

  historyEmptyState: {
    marginTop: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.5)",
  },

  historyEmptyTitle: {
    marginTop: 10,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "800",
  },

  historyEmptyText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },

  historyList: {
    marginTop: 16,
    gap: 12,
  },

  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.55)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  historyRowIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.7)",
  },

  historyRowTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "800",
  },

  historyRowMeta: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  drawerModalRoot: {
    flex: 1,
  },

  drawerScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(47, 33, 24, 0.22)",
  },

  drawerBackdrop: {
    flex: 1,
    flexDirection: "row",
  },

  drawerPanelWrap: {
    height: "100%",
    zIndex: 2,
  },

  drawerPanel: {
    flex: 1,
    paddingHorizontal: 16,
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.62)",
    shadowColor: "#9a5c1e",
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 8, height: 0 },
    elevation: 12,
  },

  drawerDismissArea: {
    flex: 1,
  },

  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  drawerSearchWrap: {
    flex: 1,
    minHeight: 46,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerSearchInput: {
    flex: 1,
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "600",
  },

  drawerCloseBtn: {
    width: 42,
    height: 42,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerTitleRow: {
    marginTop: 20,
    marginBottom: 12,
  },

  drawerSectionTitle: {
    color: Brand.ink,
    fontSize: 24,
    fontWeight: "900",
  },

  drawerSectionSub: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  drawerLabel: {
    marginBottom: 10,
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  historyEmptyCard: {
    padding: 16,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerHistoryItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 20,
    marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.54)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerHistoryIcon: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.72)",
  },

  drawerHistoryTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "800",
  },

  drawerHistoryMeta: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  drawerFooter: {
    marginTop: "auto",
    gap: 12,
  },

  drawerFooterCard: {
    minHeight: 50,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerFooterCardText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  accountTitle: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  accountSubtitle: {
    marginTop: 5,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  accountMeta: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  signOutBtn: {
    minWidth: 88,
    minHeight: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.ink,
  },

  signOutBtnText: {
    color: "#fff8ec",
    fontSize: 13,
    fontWeight: "900",
  },

  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "rgba(47, 33, 24, 0.18)",
  },

  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 30,
  },

  modalIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: "rgba(255,229,180,0.7)",
  },

  modalTitle: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 24,
    fontWeight: "900",
    textAlign: "center",
  },

  modalSubtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
  },

  modalInfoCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  modalInfoLabel: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  modalInfoValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "700",
  },

  modalActionsRow: {
    marginTop: 18,
    flexDirection: "row",
    gap: 12,
  },

  modalSecondaryBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  modalSecondaryBtnText: {
    color: Brand.cocoa,
    fontSize: 15,
    fontWeight: "900",
  },

  modalPrimaryBtn: {
    flex: 1,
    borderRadius: 18,
    overflow: "hidden",
  },

  modalPrimaryBtnInner: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },

  modalPrimaryBtnText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.92,
    transform: [{ scale: 0.995 }],
  },
});