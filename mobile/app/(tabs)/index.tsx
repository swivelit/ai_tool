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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { apiGet, apiPost, apiPostForm } from "@/lib/api";
import { Item } from "@/lib/types";
import { parseDatetime } from "@/lib/datetime";
import { scheduleReminder } from "@/lib/reminders";

type AnalyzeResponse = Item;

type PendingReminder = {
  title: string;
  details: string;
  datetimeText: string;
};

const SUGGESTIONS = [
  "Schedule a meeting",
  "Schedule a Birthday",
  "Schedule a Event",
  "Ask me anything...",
];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
  const topBarPaddingTop = insets.top + (isSmallPhone ? 4 : 8);
  const orbSize = clamp(width * 0.42, 148, 188);
  const helloBigFontSize = isVerySmallPhone ? 23 : isSmallPhone ? 27 : 31;
  const helloBigLineHeight = isVerySmallPhone ? 29 : isSmallPhone ? 33 : 37;
  const helloMaxWidth = Math.min(width - 72, 300);
  const suggestionGap = isSmallPhone ? 8 : 10;
  const suggestionChipWidth = width < 360 ? "48.5%" : "47.8%";
  const drawerWidth = Math.min(width * 0.78, 320);
  const composerBottom = keyboardHeight > 0 ? keyboardHeight + 8 : Math.max(insets.bottom, 14);
  const suggestionTopMargin = isSmallPhone ? 22 : 26;

  const greetingName = useMemo(() => {
    return (profile?.name || "there").trim();
  }, [profile?.name]);

  const assistantLabel = useMemo(() => {
    return (name || "Swivel AI").trim();
  }, [name]);

  const placeholder = "Ask me anything...";

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
        `/transcribe-and-analyze?user_id=${profile?.userId ?? ""}`,
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
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={styles.screen}
    >
      <View style={styles.screen}>
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
              <Ionicons name="menu" size={21} color="rgba(255,255,255,0.95)" />
            </Pressable>

            <View style={styles.brandWrap}>
              <Text
                style={[styles.brandText, { fontSize: isSmallPhone ? 13 : 14 }]}
                numberOfLines={1}
              >
                • {assistantLabel}
              </Text>
            </View>

            <Pressable
              style={styles.topIconBtn}
              onPress={() => {
                setResult(null);
                setLastPrompt("");
                setText("");
              }}
            >
              <Ionicons name="refresh" size={18} color="rgba(255,255,255,0.95)" />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: horizontalPadding,
              paddingBottom: composerBottom + 92,
              paddingTop: isSmallPhone ? 8 : 12,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!hasConversation ? (
              <View style={{ alignItems: "center", paddingTop: isSmallPhone ? 8 : 14 }}>
                <Orb listening={listening} onPress={toggleMic} size={orbSize} />

                <Text
                  style={[
                    styles.helloSmall,
                    { marginTop: isSmallPhone ? 4 : 6, fontSize: isSmallPhone ? 13 : 14 },
                  ]}
                >
                  Hello {greetingName}!
                </Text>

                <Text
                  style={[
                    styles.helloBig,
                    {
                      fontSize: helloBigFontSize,
                      lineHeight: helloBigLineHeight,
                      maxWidth: helloMaxWidth,
                      marginTop: isSmallPhone ? 6 : 8,
                    },
                  ]}
                >
                  How can I help you today?
                </Text>

                <Text
                  style={[
                    styles.tapHint,
                    {
                      marginTop: isSmallPhone ? 16 : 20,
                      fontSize: isSmallPhone ? 11 : 12,
                    },
                  ]}
                >
                  {recording ? "Listening..." : "Tap here to talk"}
                </Text>

                {listening ? (
                  <View style={{ marginTop: 14 }}>
                    <Waveform active />
                  </View>
                ) : null}

                <View style={{ marginTop: suggestionTopMargin, width: "100%" }}>
                  <Text
                    style={[
                      styles.sectionLabel,
                      { fontSize: isSmallPhone ? 12 : 13, marginBottom: isSmallPhone ? 8 : 10 },
                    ]}
                  >
                    Suggestions
                  </Text>

                  <View style={[styles.suggestionWrap, { gap: suggestionGap }]}>
                    {SUGGESTIONS.map((item) => (
                      <Pressable
                        key={item}
                        onPress={() => setText(item)}
                        style={[
                          styles.suggestionChip,
                          {
                            width: suggestionChipWidth,
                            minHeight: isSmallPhone ? 36 : 38,
                            paddingHorizontal: isSmallPhone ? 10 : 14,
                            paddingVertical: isSmallPhone ? 9 : 10,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.suggestionText,
                            { fontSize: isSmallPhone ? 11 : 12 },
                          ]}
                          numberOfLines={1}
                        >
                          {item}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            ) : (
              <View style={{ paddingTop: 10 }}>
                {lastPrompt ? (
                  <View style={styles.userBubbleWrap}>
                    <View style={[styles.userBubble, { maxWidth: width < 360 ? "90%" : "86%" }]}>
                      <Text style={[styles.userBubbleText, { fontSize: isSmallPhone ? 13 : 14 }]}>
                        {lastPrompt}
                      </Text>
                    </View>
                  </View>
                ) : null}

                <View style={styles.assistantBubbleWrap}>
                  <GlassCard style={{ borderRadius: 22 }}>
                    <Text style={styles.assistantNameLabel}>{assistantLabel}</Text>
                    <Text
                      style={[
                        styles.assistantBubbleText,
                        { fontSize: isSmallPhone ? 14 : 15, lineHeight: isSmallPhone ? 21 : 22 },
                      ]}
                    >
                      {busy && !resultText ? "Thinking..." : resultText}
                    </Text>

                    {!!result?.datetime ? (
                      <View style={styles.metaChip}>
                        <Ionicons
                          name="time-outline"
                          size={14}
                          color="rgba(173,232,255,0.95)"
                        />
                        <Text style={styles.metaChipText}>{result.datetime}</Text>
                      </View>
                    ) : null}
                  </GlassCard>
                </View>

                <View style={{ marginTop: 24 }}>
                  <Text
                    style={[
                      styles.sectionLabel,
                      { fontSize: isSmallPhone ? 12 : 13, marginBottom: isSmallPhone ? 8 : 10 },
                    ]}
                  >
                    Suggestions
                  </Text>

                  <View style={[styles.suggestionWrap, { gap: suggestionGap }]}>
                    {SUGGESTIONS.map((item) => (
                      <Pressable
                        key={item}
                        onPress={() => setText(item)}
                        style={[
                          styles.suggestionChip,
                          {
                            width: suggestionChipWidth,
                            minHeight: isSmallPhone ? 36 : 38,
                            paddingHorizontal: isSmallPhone ? 10 : 14,
                            paddingVertical: isSmallPhone ? 9 : 10,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.suggestionText,
                            { fontSize: isSmallPhone ? 11 : 12 },
                          ]}
                          numberOfLines={1}
                        >
                          {item}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            )}
          </ScrollView>

          {listening ? (
            <View style={[styles.floatingWaveWrap, { bottom: composerBottom + 94 }]}>
              <Waveform active />
            </View>
          ) : null}

          <View
            style={[
              styles.composerShell,
              {
                bottom: composerBottom,
                paddingHorizontal: isSmallPhone ? 10 : 14,
              },
            ]}
          >
            <View style={[styles.composer, { minHeight: isSmallPhone ? 60 : 64 }]}>
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
                  color="rgba(255,255,255,0.92)"
                />
              </Pressable>

              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor="rgba(255,255,255,0.38)"
                multiline
                textAlignVertical="top"
                style={[styles.composerInput, { fontSize: isSmallPhone ? 14 : 15 }]}
              />

              <Pressable
                onPress={toggleMic}
                style={[
                  styles.actionBtn,
                  recording ? styles.actionBtnDanger : styles.actionBtnMuted,
                ]}
              >
                <Ionicons name={recording ? "stop" : "mic"} size={18} color="white" />
              </Pressable>

              <Pressable
                onPress={analyzeText}
                disabled={busy || !text.trim()}
                style={[
                  styles.actionBtn,
                  text.trim() ? styles.actionBtnPrimary : styles.actionBtnDisabled,
                ]}
              >
                <Ionicons name="paper-plane-outline" size={18} color="white" />
              </Pressable>
            </View>
          </View>

          <Modal
            transparent
            visible={drawerOpen}
            animationType="fade"
            onRequestClose={() => setDrawerOpen(false)}
          >
            <View style={styles.drawerBackdrop}>
              <Pressable style={{ flex: 1 }} onPress={() => setDrawerOpen(false)} />
              <View
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
                    <Ionicons name="search" size={15} color="rgba(255,255,255,0.55)" />
                    <TextInput
                      value={historySearch}
                      onChangeText={setHistorySearch}
                      placeholder="Search"
                      placeholderTextColor="rgba(255,255,255,0.34)"
                      style={styles.drawerSearchInput}
                    />
                  </View>

                  <Pressable onPress={() => setDrawerOpen(false)} style={styles.drawerCloseBtn}>
                    <Ionicons name="close" size={18} color="rgba(255,255,255,0.88)" />
                  </Pressable>
                </View>

                <Text style={styles.drawerSectionTitle}>My History</Text>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 18 }}
                >
                  {filteredHistory.length === 0 ? (
                    <View style={styles.historyEmptyCard}>
                      <Text style={styles.historyEmptyText}>No history yet</Text>
                    </View>
                  ) : (
                    filteredHistory.map((item) => (
                      <Pressable
                        key={item.id}
                        onPress={() => openHistoryItem(item)}
                        style={styles.historyItem}
                      >
                        <Text style={styles.historyItemText} numberOfLines={1}>
                          {item.raw_text || item.title || "Untitled"}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </ScrollView>

                <View style={{ marginTop: "auto" }}>
                  <Pressable onPress={openRoutine} style={styles.footerCard}>
                    <Ionicons
                      name="settings-outline"
                      size={16}
                      color="rgba(255,255,255,0.88)"
                    />
                    <Text style={styles.footerCardText}>Setting</Text>
                  </Pressable>

                  <View style={styles.accountCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.accountTitle}>Account</Text>
                      <Text style={styles.accountSubtitle} numberOfLines={1}>
                        {profile?.name || "Local account"}
                      </Text>
                      <Text style={styles.accountMeta} numberOfLines={1}>
                        {profile?.place || profile?.timezone || "Swivel AI user"}
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

                  <Pressable onPress={openSchedule} style={styles.scheduleShortcut}>
                    <Ionicons
                      name="calendar-outline"
                      size={16}
                      color="rgba(255,255,255,0.88)"
                    />
                    <Text style={styles.scheduleShortcutText}>Schedule</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            transparent
            visible={confirmOpen}
            animationType="fade"
            onRequestClose={() => setConfirmOpen(false)}
          >
            <View style={styles.modalBackdrop}>
              <View style={styles.modalCard}>
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
                    <Text style={styles.modalBtnPrimaryText}>
                      {busy ? "SETTING..." : "Confirm"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 4,
  },

  topIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  brandWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },

  brandText: {
    color: "rgba(255,255,255,0.96)",
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  helloSmall: {
    color: "rgba(255,255,255,0.72)",
    fontWeight: "600",
  },

  helloBig: {
    color: "white",
    textAlign: "center",
    fontWeight: "900",
  },

  tapHint: {
    color: "rgba(255,255,255,0.54)",
    fontWeight: "600",
  },

  sectionLabel: {
    color: "rgba(255,255,255,0.70)",
    fontWeight: "800",
  },

  suggestionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },

  suggestionChip: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(175,230,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },

  suggestionText: {
    color: "rgba(255,255,255,0.92)",
    fontWeight: "700",
  },

  userBubbleWrap: {
    alignItems: "flex-end",
    marginBottom: 12,
  },

  userBubble: {
    backgroundColor: "rgba(9,17,34,0.92)",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
  },

  userBubbleText: {
    color: "rgba(255,255,255,0.95)",
    lineHeight: 20,
  },

  assistantBubbleWrap: {
    alignItems: "flex-start",
  },

  assistantNameLabel: {
    color: "rgba(173,232,255,0.95)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    marginBottom: 8,
  },

  assistantBubbleText: {
    color: "rgba(255,255,255,0.95)",
  },

  metaChip: {
    marginTop: 14,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(75,174,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(123,218,255,0.18)",
  },

  metaChipText: {
    color: "rgba(218,244,255,0.95)",
    fontSize: 12,
    fontWeight: "700",
  },

  floatingWaveWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },

  composerShell: {
    position: "absolute",
    left: 0,
    right: 0,
  },

  composer: {
    borderRadius: 28,
    paddingLeft: 10,
    paddingRight: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(128,175,230,0.24)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  leftRoundBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  composerInput: {
    flex: 1,
    maxHeight: 120,
    color: "white",
    paddingTop: 8,
    paddingBottom: 8,
  },

  actionBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },

  actionBtnMuted: {
    backgroundColor: "rgba(255,255,255,0.10)",
  },

  actionBtnPrimary: {
    backgroundColor: "rgba(116,208,255,0.95)",
  },

  actionBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.10)",
  },

  actionBtnDanger: {
    backgroundColor: "rgba(255,79,79,0.95)",
  },

  drawerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.24)",
    flexDirection: "row",
  },

  drawerPanel: {
    backgroundColor: "rgba(3,10,27,0.98)",
    paddingHorizontal: 12,
  },

  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },

  drawerSearchWrap: {
    flex: 1,
    height: 38,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  drawerSearchInput: {
    flex: 1,
    marginLeft: 8,
    color: "white",
    fontSize: 14,
  },

  drawerCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
  },

  drawerSectionTitle: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 10,
  },

  historyItem: {
    minHeight: 38,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    marginBottom: 8,
  },

  historyItemText: {
    color: "rgba(255,255,255,0.84)",
    fontSize: 12,
  },

  historyEmptyCard: {
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },

  historyEmptyText: {
    color: "rgba(255,255,255,0.50)",
    fontSize: 12,
  },

  footerCard: {
    height: 40,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    marginBottom: 10,
    gap: 8,
  },

  footerCardText: {
    color: "rgba(255,255,255,0.90)",
    fontSize: 13,
    fontWeight: "700",
  },

  accountCard: {
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  accountTitle: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "800",
  },

  accountSubtitle: {
    marginTop: 4,
    color: "rgba(255,255,255,0.84)",
    fontSize: 12,
  },

  accountMeta: {
    marginTop: 2,
    color: "rgba(255,255,255,0.48)",
    fontSize: 11,
  },

  signOutBtn: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,90,90,0.20)",
    alignItems: "center",
    justifyContent: "center",
  },

  signOutBtnText: {
    color: "#FFD7D7",
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
    color: "rgba(255,255,255,0.88)",
    fontWeight: "800",
    fontSize: 12,
  },

  brandFooterVersion: {
    color: "rgba(255,255,255,0.48)",
    fontSize: 12,
  },

  scheduleShortcut: {
    marginTop: 10,
    height: 38,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    gap: 8,
  },

  scheduleShortcutText: {
    color: "rgba(255,255,255,0.90)",
    fontSize: 13,
    fontWeight: "700",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  modalCard: {
    borderRadius: 24,
    padding: 18,
    backgroundColor: "rgba(7,14,30,0.98)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  modalTitle: {
    color: "white",
    fontSize: 20,
    fontWeight: "900",
  },

  modalText: {
    marginTop: 12,
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    lineHeight: 20,
  },

  modalTextStrong: {
    color: "white",
    fontWeight: "900",
  },

  modalMuted: {
    marginTop: 10,
    color: "rgba(255,255,255,0.58)",
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
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  modalBtnPrimary: {
    backgroundColor: "rgba(98,193,255,0.96)",
  },

  modalBtnGhostText: {
    color: "rgba(255,255,255,0.88)",
    fontWeight: "900",
  },

  modalBtnPrimaryText: {
    color: "#041222",
    fontWeight: "900",
  },
});