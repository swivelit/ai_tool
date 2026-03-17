import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Keyboard,
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

type PendingReminder = {
  title: string;
  details: string;
  datetimeText: string;
};

type SuggestionItem = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  helper: string;
};

const SUGGESTIONS: SuggestionItem[] = [
  {
    label: "Schedule a meeting",
    icon: "briefcase-outline",
    helper: "Create events and time blocks fast.",
  },
  {
    label: "Schedule a birthday",
    icon: "gift-outline",
    helper: "Remember important celebrations on time.",
  },
  {
    label: "Plan an event",
    icon: "calendar-clear-outline",
    helper: "Turn ideas into a clean schedule.",
  },
  {
    label: "Ask me anything",
    icon: "sparkles-outline",
    helper: "Notes, reminders, ideas, and everyday help.",
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getDayPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name, settings, profile, refresh } = useAssistant();
  const { signOutUser } = useAuth();

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [listening, setListening] = useState(false);

  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingReminder, setPendingReminder] = useState<PendingReminder | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyItems, setHistoryItems] = useState<Item[]>([]);

  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;

  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topBarPaddingTop = insets.top + (isSmallPhone ? 6 : 10);
  const orbSize = clamp(width * 0.46, 170, 220);
  const heroTitleSize = isVerySmallPhone ? 25 : isSmallPhone ? 29 : 33;
  const heroTitleLineHeight = isVerySmallPhone ? 31 : isSmallPhone ? 35 : 39;
  const composerBottom = keyboardHeight > 0 ? keyboardHeight + 8 : Math.max(insets.bottom, 14);
  const drawerWidth = Math.min(width * 0.82, 336);
  const pageBottomPadding = composerBottom + 108;
  const assistantCardMaxWidth = width < 360 ? "100%" : "94%";

  const greetingName = useMemo(() => {
    return (profile?.name || "there").trim();
  }, [profile?.name]);

  const assistantLabel = useMemo(() => {
    return (name || "Swivel AI").trim();
  }, [name]);

  const greeting = useMemo(() => {
    return `${getDayPart()}, ${greetingName}`;
  }, [greetingName]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyItems.slice(0, 12);

    return historyItems.filter((item) => {
      const blob = `${item.title || ""} ${item.details || ""} ${item.raw_text || ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [historyItems, historySearch]);

  const resultText = result?.details || result?.raw_text || "";
  const hasConversation = !!resultText || !!lastPrompt;
  const placeholder = listening ? "Listening... tap stop when you're done" : "Message your assistant";

  useEffect(() => {
    loadHistory();
  }, [profile?.userId]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (event) => {
      const screenY = event.endCoordinates?.screenY ?? 0;
      const heightValue = event.endCoordinates?.height ?? 0;

      if (Platform.OS === "ios") {
        setKeyboardHeight(heightValue);
        return;
      }

      setKeyboardHeight(heightValue > 0 ? heightValue : screenY);
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  async function loadHistory() {
    try {
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<Item[]>(`/items${suffix}`);
      setHistoryItems(data || []);
    } catch {
      setHistoryItems([]);
    }
  }

  function stripAssistantTrigger(input: string) {
    const cleaned = input.trim();
    if (!cleaned) return cleaned;

    const trigger = (name || "Elli").trim().toLowerCase();
    const lower = cleaned.toLowerCase();

    if (lower.startsWith(trigger)) {
      let rest = cleaned.slice((name || "Elli").length).trim();
      rest = rest.replace(/^[:,\-–—]+/, "").trim();
      return rest || cleaned;
    }

    return cleaned;
  }

  async function analyzeText() {
    if (!text.trim() || busy) return;

    try {
      setBusy(true);

      const cleaned = stripAssistantTrigger(text);
      setLastPrompt(cleaned);

      const res = await apiPost<AnalyzeResponse>("/analyze-text", {
        text: cleaned,
        user_id: profile?.userId ?? null,
        reply_language: settings.languageMode,
        meta: { tone: settings.tone, languageMode: settings.languageMode },
      });
      setResult(res);
      setText("");
      await loadHistory();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (res.intent === "reminder" && res.datetime) {
        setPendingReminder({
          title: res.title || "Reminder",
          details: res.details || res.raw_text,
          datetimeText: res.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setListening(true);

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setListening(false);
        Alert.alert("Mic permission needed", "Please allow microphone access.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(rec);
    } catch (e: any) {
      setListening(false);
      Alert.alert("Error", e?.message || "Could not start recording");
    }
  }

  async function stopAndAnalyze() {
    if (!recording) return;

    try {
      setBusy(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      setRecording(null);
      setListening(false);

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

      const res = await apiPostForm<AnalyzeResponse>(
        `/transcribe-and-analyze?user_id=${profile?.userId ?? ""}&reply_language=${settings.languageMode}`,
        form
      );
      setLastPrompt(res.transcript || "Voice request");
      setResult(res);
      await loadHistory();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (res.intent === "reminder" && res.datetime) {
        setPendingReminder({
          title: res.title || "Reminder",
          details: res.details || res.raw_text,
          datetimeText: res.datetime,
        });
        setConfirmOpen(true);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Voice analyze failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (recording) {
      await stopAndAnalyze();
      return;
    }
    await startRecording();
  }

  async function confirmScheduleReminder() {
    if (!pendingReminder) return;

    try {
      setBusy(true);
      const tz = profile?.timezone || "Asia/Kolkata";
      const parsed = await parseDatetime(pendingReminder.datetimeText, tz);

      if (!parsed.iso || parsed.confidence < 0.35) {
        Alert.alert(
          "Confirm time",
          `I couldn’t confidently understand the time.\n\nDetected: "${pendingReminder.datetimeText}".\nPlease type a clearer time.`
        );
        setConfirmOpen(false);
        setPendingReminder(null);
        return;
      }

      const when = new Date(parsed.iso);
      if (isNaN(when.getTime())) {
        Alert.alert("Error", "Parsed datetime was invalid.");
        setConfirmOpen(false);
        setPendingReminder(null);
        return;
      }

      if (when.getTime() < Date.now() + 30_000) {
        Alert.alert("Time is too soon", "Please choose a future time.");
        setConfirmOpen(false);
        setPendingReminder(null);
        return;
      }

      await scheduleReminder(pendingReminder.title, pendingReminder.details, when);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Reminder set ✅", parsed.human || when.toString());
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to schedule reminder");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
      setPendingReminder(null);
    }
  }

  function openHistoryItem(item: Item) {
    setLastPrompt(item.raw_text || "");
    setResult(item);
    setDrawerOpen(false);
  }

  function openSchedule() {
    setDrawerOpen(false);
    router.push("/(tabs)/explore");
  }

  function openRoutine() {
    setDrawerOpen(false);
    router.push("/(tabs)/routine");
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
            await refresh();
            setDrawerOpen(false);
            router.replace("/");
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

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <View
          style={[
            styles.topBar,
            {
              paddingTop: topBarPaddingTop,
              paddingHorizontal: horizontalPadding,
            },
          ]}
        >
          <Pressable style={styles.topIconBtn} onPress={() => setDrawerOpen(true)}>
            <Ionicons name="menu" size={20} color={Brand.cocoa} />
          </Pressable>

          <View style={styles.brandWrap}>
            <View style={styles.brandPill}>
              <Ionicons name="sparkles" size={13} color={Brand.bronze} />
              <Text style={[styles.brandText, { fontSize: isSmallPhone ? 12 : 13 }]} numberOfLines={1}>
                {assistantLabel}
              </Text>
            </View>
          </View>

          <Pressable
            style={styles.topIconBtn}
            onPress={() => {
              setResult(null);
              setLastPrompt("");
              setText("");
            }}
          >
            <Ionicons name="refresh" size={18} color={Brand.cocoa} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: horizontalPadding,
            paddingBottom: pageBottomPadding,
            paddingTop: isSmallPhone ? 8 : 12,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {!hasConversation ? (
            <View style={{ paddingTop: isSmallPhone ? 6 : 12 }}>
              <GlassCard style={{ borderRadius: 30 }}>
                <View style={styles.heroHeaderRow}>
                  <View style={styles.heroPill}>
                    <Ionicons name="radio-outline" size={14} color={Brand.bronze} />
                    <Text style={styles.heroPillText}>{recording ? "Voice is live" : "Premium assistant"}</Text>
                  </View>

                  <View style={styles.heroStatusChip}>
                    <Ionicons name="checkmark-circle" size={14} color={Brand.success} />
                    <Text style={styles.heroStatusText}>{busy ? "Working" : "Ready"}</Text>
                  </View>
                </View>

                <View style={styles.orbStage}>
                  <View style={styles.orbAmbientGlow} />
                  <Orb listening={listening} onPress={toggleMic} size={orbSize} />
                </View>

                <Text style={[styles.greeting, { fontSize: isSmallPhone ? 14 : 15 }]}>{greeting}</Text>
                <Text
                  style={[
                    styles.heroTitle,
                    {
                      fontSize: heroTitleSize,
                      lineHeight: heroTitleLineHeight,
                    },
                  ]}
                >
                  Your AI home, redesigned to feel refined, warm, and truly production ready.
                </Text>
                <Text style={styles.heroSubtitle}>
                  Tap the globe to speak, or type below to plan your day, set reminders, and get crisp answers with a cleaner premium interface.
                </Text>

                <View style={styles.heroMetaRow}>
                  <View style={styles.heroMetaCard}>
                    <Text style={styles.heroMetaTitle}>Voice mode</Text>
                    <Text style={styles.heroMetaValue}>{recording ? "Listening now" : "Tap to start"}</Text>
                  </View>

                  <View style={styles.heroMetaCard}>
                    <Text style={styles.heroMetaTitle}>Experience</Text>
                    <Text style={styles.heroMetaValue}>Warm · Polished · Fast</Text>
                  </View>
                </View>
              </GlassCard>

              {listening ? (
                <View style={styles.inlineWaveWrap}>
                  <Waveform active />
                </View>
              ) : null}

              <View style={{ marginTop: 22 }}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionLabel}>Quick actions</Text>
                  <Text style={styles.sectionCaption}>One tap to begin</Text>
                </View>

                <View style={styles.suggestionWrap}>
                  {SUGGESTIONS.map((item) => (
                    <Pressable
                      key={item.label}
                      onPress={() => setText(item.label)}
                      style={({ pressed }) => [styles.suggestionCard, pressed && styles.pressed]}
                    >
                      <View style={styles.suggestionIconWrap}>
                        <Ionicons name={item.icon} size={18} color={Brand.bronze} />
                      </View>
                      <Text style={styles.suggestionTitle}>{item.label}</Text>
                      <Text style={styles.suggestionHelper}>{item.helper}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          ) : (
            <View style={{ paddingTop: 6 }}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionLabel}>Conversation</Text>
                <Text style={styles.sectionCaption}>Current result</Text>
              </View>

              {lastPrompt ? (
                <View style={styles.userBubbleWrap}>
                  <View style={[styles.userBubble, { maxWidth: width < 360 ? "92%" : "86%" }]}>
                    <Text style={[styles.userBubbleText, { fontSize: isSmallPhone ? 13 : 14 }]}>{lastPrompt}</Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.assistantBubbleWrap}>
                <GlassCard style={{ borderRadius: 26, maxWidth: assistantCardMaxWidth }}>
                  <View style={styles.assistantHeaderRow}>
                    <View>
                      <Text style={styles.assistantNameLabel}>{assistantLabel}</Text>
                      <Text style={styles.assistantSubLabel}>{busy && !resultText ? "Analyzing your request" : "Response ready"}</Text>
                    </View>

                    <View style={styles.assistantBadge}>
                      <Ionicons name="sparkles" size={14} color={Brand.bronze} />
                    </View>
                  </View>

                  <Text
                    style={[
                      styles.assistantBubbleText,
                      { fontSize: isSmallPhone ? 14 : 15, lineHeight: isSmallPhone ? 22 : 24 },
                    ]}
                  >
                    {busy && !resultText ? "Thinking..." : resultText}
                  </Text>

                  {!!result?.datetime ? (
                    <View style={styles.metaChip}>
                      <Ionicons name="time-outline" size={14} color={Brand.bronze} />
                      <Text style={styles.metaChipText}>{result.datetime}</Text>
                    </View>
                  ) : null}
                </GlassCard>
              </View>

              <View style={{ marginTop: 24 }}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionLabel}>Keep going</Text>
                  <Text style={styles.sectionCaption}>Suggested prompts</Text>
                </View>

                <View style={styles.suggestionWrap}>
                  {SUGGESTIONS.map((item) => (
                    <Pressable
                      key={item.label}
                      onPress={() => setText(item.label)}
                      style={({ pressed }) => [styles.suggestionCard, pressed && styles.pressed]}
                    >
                      <View style={styles.suggestionIconWrap}>
                        <Ionicons name={item.icon} size={18} color={Brand.bronze} />
                      </View>
                      <Text style={styles.suggestionTitle}>{item.label}</Text>
                      <Text style={styles.suggestionHelper}>{item.helper}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          )}
        </ScrollView>

        {listening ? (
          <View style={[styles.floatingWaveWrap, { bottom: composerBottom + 100 }]}>
            <View style={styles.floatingWaveCard}>
              <Waveform active />
            </View>
          </View>
        ) : null}

        <View
          style={[
            styles.composerShell,
            {
              bottom: composerBottom,
              paddingHorizontal: horizontalPadding,
            },
          ]}
        >
          <View style={styles.composerWrap}>
            <LinearGradient
              colors={["rgba(255,255,255,0.92)", "rgba(255,239,210,0.88)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[styles.composer, { minHeight: isSmallPhone ? 64 : 68 }]}
            >
              <Pressable
                onPress={() => {
                  if (hasConversation) {
                    setResult(null);
                    setLastPrompt("");
                  } else {
                    setDrawerOpen(true);
                  }
                }}
                style={styles.leftRoundBtn}
              >
                <Ionicons
                  name={hasConversation ? "arrow-back" : "time-outline"}
                  size={18}
                  color={Brand.cocoa}
                />
              </Pressable>

              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor="rgba(124, 99, 80, 0.55)"
                multiline
                textAlignVertical="top"
                style={[styles.composerInput, { fontSize: isSmallPhone ? 14 : 15 }]}
              />

              <Pressable
                onPress={toggleMic}
                style={[styles.actionBtn, recording ? styles.actionBtnDanger : styles.actionBtnMuted]}
              >
                <Ionicons name={recording ? "stop" : "mic"} size={18} color={recording ? "#fff" : Brand.cocoa} />
              </Pressable>

              <Pressable
                onPress={analyzeText}
                disabled={busy || !text.trim()}
                style={[styles.actionBtn, text.trim() ? styles.actionBtnPrimary : styles.actionBtnDisabled]}
              >
                <Ionicons
                  name="paper-plane-outline"
                  size={18}
                  color={text.trim() ? Brand.ink : "rgba(124, 99, 80, 0.5)"}
                />
              </Pressable>
            </LinearGradient>
          </View>
        </View>

        <Modal transparent visible={drawerOpen} animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
          <View style={styles.drawerBackdrop}>
            <Pressable style={{ flex: 1 }} onPress={() => setDrawerOpen(false)} />
            <LinearGradient
              colors={["#fffaf2", "#fff0d2", "#ffe5b4"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[
                styles.drawerPanel,
                {
                  width: drawerWidth,
                  paddingTop: Math.max(insets.top + 14, Platform.OS === "ios" ? 56 : 28),
                  paddingBottom: Math.max(insets.bottom + 18, 18),
                },
              ]}
            >
              <View style={styles.drawerHeader}>
                <View style={styles.drawerSearchWrap}>
                  <Ionicons name="search" size={15} color="rgba(124, 99, 80, 0.6)" />
                  <TextInput
                    value={historySearch}
                    onChangeText={setHistorySearch}
                    placeholder="Search your history"
                    placeholderTextColor="rgba(124, 99, 80, 0.42)"
                    style={styles.drawerSearchInput}
                  />
                </View>

                <Pressable onPress={() => setDrawerOpen(false)} style={styles.drawerCloseBtn}>
                  <Ionicons name="close" size={18} color={Brand.cocoa} />
                </Pressable>
              </View>

              <View style={styles.drawerTitleRow}>
                <View>
                  <Text style={styles.drawerSectionTitle}>Recent history</Text>
                  <Text style={styles.drawerSectionSub}>Your latest prompts and results</Text>
                </View>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 18 }}>
                {filteredHistory.length === 0 ? (
                  <View style={styles.historyEmptyCard}>
                    <Ionicons name="time-outline" size={18} color={Brand.muted} />
                    <Text style={styles.historyEmptyText}>No history yet</Text>
                  </View>
                ) : (
                  filteredHistory.map((item) => (
                    <Pressable key={item.id} onPress={() => openHistoryItem(item)} style={styles.historyItem}>
                      <Text style={styles.historyItemText} numberOfLines={1}>
                        {item.raw_text || item.title || "Untitled"}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color="rgba(124, 99, 80, 0.58)" />
                    </Pressable>
                  ))
                )}
              </ScrollView>

              <View style={{ marginTop: "auto" }}>
                <Pressable onPress={openRoutine} style={styles.footerCard}>
                  <Ionicons name="settings-outline" size={16} color={Brand.cocoa} />
                  <Text style={styles.footerCardText}>Settings</Text>
                </Pressable>

                <Pressable onPress={openSchedule} style={styles.footerCard}>
                  <Ionicons name="calendar-outline" size={16} color={Brand.cocoa} />
                  <Text style={styles.footerCardText}>Schedule</Text>
                </Pressable>

                <View style={styles.accountCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.accountTitle}>Account</Text>
                    <Text style={styles.accountSubtitle} numberOfLines={1}>
                      {profile?.name || "Local account"}
                    </Text>
                    <Text style={styles.accountMeta} numberOfLines={1}>
                      {profile?.place || profile?.timezone || "Assistant user"}
                    </Text>
                  </View>

                  <Pressable onPress={signOut} style={styles.signOutBtn}>
                    <Text style={styles.signOutBtnText}>Sign out</Text>
                  </Pressable>
                </View>

                <View style={styles.brandFooter}>
                  <Text style={styles.brandFooterText}>{assistantLabel}</Text>
                  <Text style={styles.brandFooterVersion}>v1.0</Text>
                </View>
              </View>
            </LinearGradient>
          </View>
        </Modal>

        <Modal transparent visible={confirmOpen} animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
          <View style={styles.modalBackdrop}>
            <GlassCard style={{ borderRadius: 28 }}>
              <Text style={styles.modalTitle}>Confirm reminder</Text>

              <Text style={styles.modalText}>
                <Text style={styles.modalTextStrong}>Title: </Text>
                {pendingReminder?.title}
              </Text>

              <Text style={styles.modalText}>
                <Text style={styles.modalTextStrong}>When: </Text>
                {pendingReminder?.datetimeText}
              </Text>

              <Text style={styles.modalMuted} numberOfLines={3}>
                {pendingReminder?.details}
              </Text>

              <View style={styles.modalActionRow}>
                <Pressable
                  onPress={() => {
                    setConfirmOpen(false);
                    setPendingReminder(null);
                  }}
                  style={[styles.modalBtn, styles.modalBtnGhost]}
                >
                  <Text style={styles.modalBtnGhostText}>Cancel</Text>
                </Pressable>

                <Pressable
                  onPress={confirmScheduleReminder}
                  disabled={busy}
                  style={[styles.modalBtn, styles.modalBtnPrimary]}
                >
                  <Text style={styles.modalBtnPrimaryText}>{busy ? "SETTING..." : "Confirm"}</Text>
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

  topGlow: {
    position: "absolute",
    top: -110,
    right: -30,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.55)",
  },

  leftGlow: {
    position: "absolute",
    top: 240,
    left: -90,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255, 229, 180, 0.36)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -110,
    right: 10,
    width: 280,
    height: 280,
    borderRadius: 999,
    backgroundColor: "rgba(215, 154, 89, 0.18)",
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 8,
  },

  topIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  brandWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },

  brandPill: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  brandText: {
    color: Brand.cocoa,
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  heroHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },

  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.74)",
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
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  orbStage: {
    marginTop: 14,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 270,
  },

  orbAmbientGlow: {
    position: "absolute",
    width: 250,
    height: 250,
    borderRadius: 999,
    backgroundColor: "rgba(255, 229, 180, 0.18)",
  },

  greeting: {
    marginTop: 2,
    color: Brand.muted,
    textAlign: "center",
    fontWeight: "700",
  },

  heroTitle: {
    marginTop: 10,
    color: Brand.ink,
    textAlign: "center",
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 12,
    color: Brand.muted,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 22,
  },

  heroMetaRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 22,
  },

  heroMetaCard: {
    flex: 1,
    minHeight: 78,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroMetaTitle: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  heroMetaValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },

  inlineWaveWrap: {
    marginTop: 16,
    alignItems: "center",
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },

  sectionLabel: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  sectionCaption: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  suggestionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
  },

  suggestionCard: {
    width: "48%",
    minHeight: 130,
    borderRadius: 24,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.992 }],
  },

  suggestionIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.7)",
  },

  suggestionTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },

  suggestionHelper: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  userBubbleWrap: {
    alignItems: "flex-end",
    marginBottom: 12,
  },

  userBubble: {
    backgroundColor: "rgba(110, 76, 46, 0.95)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },

  userBubbleText: {
    color: Brand.warmWhite,
    lineHeight: 20,
    fontWeight: "600",
  },

  assistantBubbleWrap: {
    alignItems: "flex-start",
  },

  assistantHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },

  assistantNameLabel: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  assistantSubLabel: {
    marginTop: 3,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  assistantBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.7)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  assistantBubbleText: {
    color: Brand.ink,
  },

  metaChip: {
    marginTop: 16,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  metaChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "700",
  },

  floatingWaveWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },

  floatingWaveCard: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  composerShell: {
    position: "absolute",
    left: 0,
    right: 0,
  },

  composerWrap: {
    borderRadius: 28,
    overflow: "hidden",
    shadowColor: "#cb8e4d",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },

  composer: {
    borderRadius: 28,
    paddingLeft: 10,
    paddingRight: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  leftRoundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  composerInput: {
    flex: 1,
    maxHeight: 120,
    color: Brand.ink,
    paddingTop: 8,
    paddingBottom: 8,
  },

  actionBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },

  actionBtnMuted: {
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  actionBtnPrimary: {
    backgroundColor: "#f0c17e",
  },

  actionBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.62)",
  },

  actionBtnDanger: {
    backgroundColor: Brand.danger,
  },

  drawerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(82, 57, 28, 0.16)",
    flexDirection: "row",
  },

  drawerPanel: {
    paddingHorizontal: 12,
    borderLeftWidth: 1,
    borderColor: Brand.line,
  },

  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },

  drawerSearchWrap: {
    flex: 1,
    height: 40,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.7)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerSearchInput: {
    flex: 1,
    marginLeft: 8,
    color: Brand.ink,
    fontSize: 14,
  },

  drawerCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.7)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  drawerTitleRow: {
    marginBottom: 12,
  },

  drawerSectionTitle: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  drawerSectionSub: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
  },

  historyItem: {
    minHeight: 46,
    borderRadius: 14,
    justifyContent: "space-between",
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    marginBottom: 8,
  },

  historyItemText: {
    flex: 1,
    marginRight: 10,
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "700",
  },

  historyEmptyCard: {
    height: 78,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    gap: 8,
  },

  historyEmptyText: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  footerCard: {
    height: 44,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
    marginBottom: 10,
    gap: 8,
  },

  footerCardText: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "700",
  },

  accountCard: {
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  accountTitle: {
    color: Brand.ink,
    fontSize: 13,
    fontWeight: "900",
  },

  accountSubtitle: {
    marginTop: 4,
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "700",
  },

  accountMeta: {
    marginTop: 2,
    color: Brand.muted,
    fontSize: 11,
  },

  signOutBtn: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "rgba(185, 98, 72, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(185, 98, 72, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },

  signOutBtnText: {
    color: Brand.danger,
    fontSize: 12,
    fontWeight: "800",
  },

  brandFooter: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },

  brandFooterText: {
    color: Brand.cocoa,
    fontWeight: "800",
    fontSize: 12,
  },

  brandFooterVersion: {
    color: Brand.muted,
    fontSize: 12,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(72, 46, 18, 0.18)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  modalTitle: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  modalText: {
    marginTop: 12,
    color: Brand.cocoa,
    fontSize: 14,
    lineHeight: 20,
  },

  modalTextStrong: {
    color: Brand.ink,
    fontWeight: "900",
  },

  modalMuted: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  modalActionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },

  modalBtn: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },

  modalBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  modalBtnPrimary: {
    backgroundColor: "#efbf7c",
  },

  modalBtnGhostText: {
    color: Brand.cocoa,
    fontWeight: "900",
  },

  modalBtnPrimaryText: {
    color: Brand.ink,
    fontWeight: "900",
  },
});