import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
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

export default function Home() {
  const insets = useSafeAreaInsets();
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

  const composerBottom = keyboardHeight > 0 ? keyboardHeight + 8 : Math.max(insets.bottom, 14);

  useEffect(() => {
    loadHistory();
  }, [profile?.userId]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (event) => {
      const screenY = event.endCoordinates?.screenY ?? 0;
      const height = event.endCoordinates?.height ?? 0;

      if (Platform.OS === "ios") {
        setKeyboardHeight(height);
        return;
      }

      setKeyboardHeight(height > 0 ? height : screenY);
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
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          <View style={topBar}>
            <Pressable style={topIconBtn} onPress={() => setDrawerOpen(true)}>
              <Ionicons name="menu" size={21} color="rgba(255,255,255,0.95)" />
            </Pressable>

            <Text style={brandText}>• {assistantLabel}</Text>

            <Pressable
              style={topIconBtn}
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
              paddingHorizontal: 18,
              paddingBottom: composerBottom + 92,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!hasConversation ? (
              <View style={{ alignItems: "center", paddingTop: 16 }}>
                <Orb listening={listening} onPress={toggleMic} size={168} />

                <Text style={helloSmall}>Hello {greetingName}!</Text>
                <Text style={helloBig}>How can I help you today?</Text>

                <Text style={tapHint}>
                  {recording ? "Listening..." : "Tap here to talk"}
                </Text>

                {listening ? (
                  <View style={{ marginTop: 14 }}>
                    <Waveform active />
                  </View>
                ) : null}

                <View style={{ marginTop: 26, width: "100%" }}>
                  <Text style={sectionLabel}>Suggestions</Text>
                  <View style={suggestionWrap}>
                    {SUGGESTIONS.map((item) => (
                      <Pressable
                        key={item}
                        onPress={() => setText(item)}
                        style={suggestionChip}
                      >
                        <Text style={suggestionText} numberOfLines={1}>
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
                  <View style={userBubbleWrap}>
                    <View style={userBubble}>
                      <Text style={userBubbleText}>{lastPrompt}</Text>
                    </View>
                  </View>
                ) : null}

                <View style={assistantBubbleWrap}>
                  <GlassCard style={{ borderRadius: 22 }}>
                    <Text style={assistantNameLabel}>{assistantLabel}</Text>
                    <Text style={assistantBubbleText}>
                      {busy && !resultText ? "Thinking..." : resultText}
                    </Text>

                    {!!result?.datetime ? (
                      <View style={metaChip}>
                        <Ionicons
                          name="time-outline"
                          size={14}
                          color="rgba(173,232,255,0.95)"
                        />
                        <Text style={metaChipText}>{result.datetime}</Text>
                      </View>
                    ) : null}
                  </GlassCard>
                </View>

                <View style={{ marginTop: 24 }}>
                  <Text style={sectionLabel}>Suggestions</Text>
                  <View style={suggestionWrap}>
                    {SUGGESTIONS.map((item) => (
                      <Pressable
                        key={item}
                        onPress={() => setText(item)}
                        style={suggestionChip}
                      >
                        <Text style={suggestionText} numberOfLines={1}>
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
            <View
              style={[
                floatingWaveWrap,
                { bottom: composerBottom + 94 },
              ]}
            >
              <Waveform active />
            </View>
          ) : null}

          <View style={[composerShell, { bottom: composerBottom }]}>
            <View style={composer}>
              <Pressable
                onPress={() => {
                  if (hasConversation) {
                    setResult(null);
                    setLastPrompt("");
                  } else {
                    setDrawerOpen(true);
                  }
                }}
                style={leftRoundBtn}
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
                style={composerInput}
              />

              <Pressable
                onPress={toggleMic}
                style={[
                  actionBtn,
                  recording ? actionBtnDanger : actionBtnMuted,
                ]}
              >
                <Ionicons
                  name={recording ? "stop" : "mic"}
                  size={18}
                  color="white"
                />
              </Pressable>

              <Pressable
                onPress={analyzeText}
                disabled={busy || !text.trim()}
                style={[
                  actionBtn,
                  text.trim() ? actionBtnPrimary : actionBtnDisabled,
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
            <View style={drawerBackdrop}>
              <Pressable style={{ flex: 1 }} onPress={() => setDrawerOpen(false)} />
              <View style={drawerPanel}>
                <View style={drawerHeader}>
                  <View style={drawerSearchWrap}>
                    <Ionicons name="search" size={15} color="rgba(255,255,255,0.55)" />
                    <TextInput
                      value={historySearch}
                      onChangeText={setHistorySearch}
                      placeholder="Search"
                      placeholderTextColor="rgba(255,255,255,0.34)"
                      style={drawerSearchInput}
                    />
                  </View>
                  <Pressable onPress={() => setDrawerOpen(false)} style={drawerCloseBtn}>
                    <Ionicons name="close" size={18} color="rgba(255,255,255,0.88)" />
                  </Pressable>
                </View>

                <Text style={drawerSectionTitle}>My History</Text>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 18 }}
                >
                  {filteredHistory.length === 0 ? (
                    <View style={historyEmptyCard}>
                      <Text style={historyEmptyText}>No history yet</Text>
                    </View>
                  ) : (
                    filteredHistory.map((item) => (
                      <Pressable
                        key={item.id}
                        onPress={() => openHistoryItem(item)}
                        style={historyItem}
                      >
                        <Text style={historyItemText} numberOfLines={1}>
                          {item.raw_text || item.title || "Untitled"}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </ScrollView>

                <View style={{ marginTop: "auto" }}>
                  <Pressable onPress={openRoutine} style={footerCard}>
                    <Ionicons name="settings-outline" size={16} color="rgba(255,255,255,0.88)" />
                    <Text style={footerCardText}>Setting</Text>
                  </Pressable>

                  <View style={accountCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={accountTitle}>Account</Text>
                      <Text style={accountSubtitle} numberOfLines={1}>
                        {profile?.name || "Local account"}
                      </Text>
                      <Text style={accountMeta} numberOfLines={1}>
                        {profile?.place || profile?.timezone || "Swivel AI user"}
                      </Text>
                    </View>

                    <Pressable onPress={signOut} style={signOutBtn}>
                      <Text style={signOutBtnText}>Sign out</Text>
                    </Pressable>
                  </View>

                  <View style={brandFooter}>
                    <Text style={brandFooterText}>{assistantLabel}</Text>
                    <Text style={brandFooterVersion}>v1.0</Text>
                  </View>

                  <Pressable onPress={openSchedule} style={scheduleShortcut}>
                    <Ionicons name="calendar-outline" size={16} color="rgba(255,255,255,0.88)" />
                    <Text style={scheduleShortcutText}>Schedule</Text>
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
            <View style={modalBackdrop}>
              <View style={modalCard}>
                <Text style={modalTitle}>Confirm reminder</Text>

                <Text style={modalText}>
                  <Text style={modalTextStrong}>Title: </Text>
                  {pendingReminder?.title}
                </Text>

                <Text style={modalText}>
                  <Text style={modalTextStrong}>When: </Text>
                  {pendingReminder?.datetimeText}
                </Text>

                <Text style={modalMuted} numberOfLines={3}>
                  {pendingReminder?.details}
                </Text>

                <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
                  <Pressable
                    onPress={() => {
                      setConfirmOpen(false);
                      setPendingReminder(null);
                    }}
                    style={[modalBtn, modalBtnGhost]}
                  >
                    <Text style={modalBtnGhostText}>Cancel</Text>
                  </Pressable>

                  <Pressable
                    onPress={confirmScheduleReminder}
                    disabled={busy}
                    style={[modalBtn, modalBtnPrimary]}
                  >
                    <Text style={modalBtnPrimaryText}>
                      {busy ? "SETTING..." : "Confirm"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const topBar = {
  paddingHorizontal: 18,
  paddingTop: 8,
  paddingBottom: 4,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const topIconBtn = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const brandText = {
  color: "rgba(255,255,255,0.96)",
  fontSize: 14,
  fontWeight: "800" as const,
  letterSpacing: 0.2,
};

const helloSmall = {
  marginTop: 6,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  fontWeight: "600" as const,
};

const helloBig = {
  marginTop: 8,
  color: "white",
  fontSize: 31,
  lineHeight: 37,
  textAlign: "center" as const,
  fontWeight: "900" as const,
  maxWidth: 260,
};

const tapHint = {
  marginTop: 20,
  color: "rgba(255,255,255,0.54)",
  fontSize: 12,
  fontWeight: "600" as const,
};

const sectionLabel = {
  color: "rgba(255,255,255,0.70)",
  fontSize: 13,
  fontWeight: "800" as const,
  marginBottom: 10,
};

const suggestionWrap = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  justifyContent: "space-between" as const,
  gap: 10,
};

const suggestionChip = {
  width: "47.8%",
  minHeight: 38,
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 999,
  backgroundColor: "rgba(255,255,255,0.14)",
  borderWidth: 1,
  borderColor: "rgba(175,230,255,0.14)",
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const suggestionText = {
  color: "rgba(255,255,255,0.92)",
  fontSize: 12,
  fontWeight: "700" as const,
};

const userBubbleWrap = {
  alignItems: "flex-end" as const,
  marginBottom: 12,
};

const userBubble = {
  maxWidth: "86%",
  backgroundColor: "rgba(9,17,34,0.92)",
  borderRadius: 18,
  paddingHorizontal: 14,
  paddingVertical: 12,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.07)",
};

const userBubbleText = {
  color: "rgba(255,255,255,0.95)",
  fontSize: 14,
  lineHeight: 20,
};

const assistantBubbleWrap = {
  alignItems: "flex-start" as const,
};

const assistantNameLabel = {
  color: "rgba(173,232,255,0.95)",
  fontSize: 12,
  fontWeight: "900" as const,
  letterSpacing: 0.3,
  marginBottom: 8,
};

const assistantBubbleText = {
  color: "rgba(255,255,255,0.95)",
  fontSize: 15,
  lineHeight: 22,
};

const metaChip = {
  marginTop: 14,
  alignSelf: "flex-start" as const,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
  paddingHorizontal: 10,
  paddingVertical: 7,
  borderRadius: 999,
  backgroundColor: "rgba(75,174,255,0.12)",
  borderWidth: 1,
  borderColor: "rgba(123,218,255,0.18)",
};

const metaChipText = {
  color: "rgba(218,244,255,0.95)",
  fontSize: 12,
  fontWeight: "700" as const,
};

const floatingWaveWrap = {
  position: "absolute" as const,
  left: 0,
  right: 0,
  alignItems: "center" as const,
};

const composerShell = {
  position: "absolute" as const,
  left: 0,
  right: 0,
  paddingHorizontal: 14,
};

const composer = {
  minHeight: 64,
  borderRadius: 28,
  paddingLeft: 10,
  paddingRight: 10,
  paddingVertical: 10,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
  backgroundColor: "rgba(128,175,230,0.24)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const leftRoundBtn = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
};

const composerInput = {
  flex: 1,
  maxHeight: 120,
  color: "white",
  fontSize: 15,
  paddingTop: 8,
  paddingBottom: 8,
};

const actionBtn = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const actionBtnMuted = {
  backgroundColor: "rgba(255,255,255,0.10)",
};

const actionBtnPrimary = {
  backgroundColor: "rgba(116,208,255,0.95)",
};

const actionBtnDisabled = {
  backgroundColor: "rgba(255,255,255,0.10)",
};

const actionBtnDanger = {
  backgroundColor: "rgba(255,79,79,0.95)",
};

const drawerBackdrop = {
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.24)",
  flexDirection: "row" as const,
};

const drawerPanel = {
  width: "74%",
  backgroundColor: "rgba(3,10,27,0.98)",
  paddingTop: Platform.OS === "ios" ? 56 : 28,
  paddingHorizontal: 12,
  paddingBottom: 18,
};

const drawerHeader = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
  marginBottom: 18,
};

const drawerSearchWrap = {
  flex: 1,
  height: 38,
  borderRadius: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  paddingHorizontal: 12,
  backgroundColor: "rgba(255,255,255,0.08)",
};

const drawerSearchInput = {
  flex: 1,
  marginLeft: 8,
  color: "white",
  fontSize: 14,
};

const drawerCloseBtn = {
  width: 34,
  height: 34,
  borderRadius: 17,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.07)",
};

const drawerSectionTitle = {
  color: "rgba(255,255,255,0.72)",
  fontSize: 13,
  fontWeight: "800" as const,
  marginBottom: 10,
};

const historyItem = {
  minHeight: 38,
  borderRadius: 10,
  justifyContent: "center" as const,
  paddingHorizontal: 10,
  backgroundColor: "rgba(255,255,255,0.04)",
  marginBottom: 8,
};

const historyItemText = {
  color: "rgba(255,255,255,0.84)",
  fontSize: 12,
};

const historyEmptyCard = {
  height: 48,
  borderRadius: 10,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.04)",
};

const historyEmptyText = {
  color: "rgba(255,255,255,0.50)",
  fontSize: 12,
};

const footerCard = {
  height: 40,
  borderRadius: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  paddingHorizontal: 12,
  backgroundColor: "rgba(255,255,255,0.07)",
  marginBottom: 10,
  gap: 8,
};

const footerCardText = {
  color: "rgba(255,255,255,0.90)",
  fontSize: 13,
  fontWeight: "700" as const,
};

const accountCard = {
  borderRadius: 12,
  backgroundColor: "rgba(255,255,255,0.07)",
  padding: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
};

const accountTitle = {
  color: "rgba(255,255,255,0.92)",
  fontSize: 13,
  fontWeight: "800" as const,
};

const accountSubtitle = {
  marginTop: 4,
  color: "rgba(255,255,255,0.84)",
  fontSize: 12,
};

const accountMeta = {
  marginTop: 2,
  color: "rgba(255,255,255,0.48)",
  fontSize: 11,
};

const signOutBtn = {
  height: 32,
  paddingHorizontal: 12,
  borderRadius: 999,
  backgroundColor: "rgba(255,90,90,0.20)",
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const signOutBtnText = {
  color: "#FFD7D7",
  fontSize: 12,
  fontWeight: "800" as const,
};

const brandFooter = {
  marginTop: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
  paddingHorizontal: 4,
};

const brandFooterText = {
  color: "rgba(255,255,255,0.88)",
  fontWeight: "800" as const,
  fontSize: 12,
};

const brandFooterVersion = {
  color: "rgba(255,255,255,0.48)",
  fontSize: 12,
};

const scheduleShortcut = {
  marginTop: 10,
  height: 38,
  borderRadius: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  paddingHorizontal: 12,
  backgroundColor: "rgba(255,255,255,0.07)",
  gap: 8,
};

const scheduleShortcutText = {
  color: "rgba(255,255,255,0.90)",
  fontSize: 13,
  fontWeight: "700" as const,
};

const modalBackdrop = {
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.45)",
  justifyContent: "center" as const,
  paddingHorizontal: 18,
};

const modalCard = {
  borderRadius: 24,
  padding: 18,
  backgroundColor: "rgba(7,14,30,0.98)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const modalTitle = {
  color: "white",
  fontSize: 20,
  fontWeight: "900" as const,
};

const modalText = {
  marginTop: 12,
  color: "rgba(255,255,255,0.82)",
  fontSize: 14,
  lineHeight: 20,
};

const modalTextStrong = {
  color: "white",
  fontWeight: "900" as const,
};

const modalMuted = {
  marginTop: 10,
  color: "rgba(255,255,255,0.58)",
  fontSize: 13,
  lineHeight: 19,
};

const modalBtn = {
  flex: 1,
  height: 50,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const modalBtnGhost = {
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const modalBtnPrimary = {
  backgroundColor: "rgba(98,193,255,0.96)",
};

const modalBtnGhostText = {
  color: "rgba(255,255,255,0.88)",
  fontWeight: "900" as const,
};

const modalBtnPrimaryText = {
  color: "#041222",
  fontWeight: "900" as const,
};