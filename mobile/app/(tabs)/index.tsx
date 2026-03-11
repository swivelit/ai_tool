import React, { useMemo, useState } from "react";
import {
  Alert,
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

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { apiPost, apiPostForm } from "@/lib/api";
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
  "Schedule a meeting tomorrow morning 10am",
  "Schedule Ram birthday on 2nd February evening",
  "Create an event for customer follow-up today 4pm",
  "Remind me to take medicine tonight at 9pm",
];

export default function Home() {
  const { name, settings, profile } = useAssistant();

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [listening, setListening] = useState(false);

  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingReminder, setPendingReminder] = useState<PendingReminder | null>(null);

  const greetingName = useMemo(() => {
    return (profile?.name || "there").trim();
  }, [profile?.name]);

  const assistantLabel = useMemo(() => {
    return (name || "Swivel AI").trim();
  }, [name]);

  const placeholder = useMemo(() => {
    return settings.languageMode === "ta"
      ? "Ask me anything..."
      : "Ask me anything...";
  }, [settings.languageMode]);

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

  const resultText = result?.details || result?.raw_text || "";
  const hasConversation = !!resultText || !!lastPrompt;

  return (
    <LinearGradient
      colors={["#020816", "#04132D", "#0B3D86"]}
      start={{ x: 0.12, y: 0.04 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={topBar}>
            <Pressable style={iconBtn}>
              <Ionicons name="menu" size={22} color="rgba(255,255,255,0.92)" />
            </Pressable>

            <Text style={brandText}>{assistantLabel}</Text>

            <Pressable
              style={iconBtn}
              onPress={() => {
                setResult(null);
                setLastPrompt("");
              }}
            >
              <Ionicons name="refresh" size={20} color="rgba(255,255,255,0.92)" />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 180 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!hasConversation ? (
              <View style={{ alignItems: "center", paddingTop: 22 }}>
                <View style={{ marginTop: 8 }}>
                  <Orb listening={listening} onPress={toggleMic} size={166} />
                </View>

                <Text style={helloSmall}>Hello {greetingName}!</Text>
                <Text style={helloBig}>How can I help you today?</Text>

                <Text style={tapHint}>
                  {recording ? "Listening... tap again to stop" : "Tap here to talk"}
                </Text>

                {listening ? (
                  <View style={{ marginTop: 12 }}>
                    <Waveform active />
                  </View>
                ) : null}
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
              </View>
            )}

            <View style={{ marginTop: 28 }}>
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

            <View style={{ marginTop: 18 }}>
              <GlassCard style={{ borderRadius: 24 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={miniOrb} />
                  <View style={{ flex: 1 }}>
                    <Text style={cardTitle}>Voice assistant</Text>
                    <Text style={cardSub}>
                      {recording
                        ? "Recording in progress..."
                        : "Tap the mic below or tap the orb to speak in Tamil or English."}
                    </Text>
                  </View>
                </View>
              </GlassCard>
            </View>
          </ScrollView>

          <View style={composerShell}>
            <View style={composer}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor="rgba(255,255,255,0.38)"
                multiline
                style={composerInput}
              />

              <Pressable
                onPress={toggleMic}
                style={[
                  roundButton,
                  recording ? roundButtonDanger : roundButtonSoft,
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
                  roundButton,
                  text.trim() ? roundButtonPrimary : roundButtonDisabled,
                ]}
              >
                <Ionicons name="paper-plane" size={18} color="white" />
              </Pressable>
            </View>
          </View>

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

const iconBtn = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const brandText = {
  color: "rgba(255,255,255,0.95)",
  fontSize: 15,
  fontWeight: "800" as const,
  letterSpacing: 0.2,
};

const helloSmall = {
  marginTop: 4,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  fontWeight: "600" as const,
};

const helloBig = {
  marginTop: 6,
  color: "white",
  fontSize: 29,
  lineHeight: 35,
  textAlign: "center" as const,
  fontWeight: "900" as const,
  maxWidth: 260,
};

const tapHint = {
  marginTop: 18,
  color: "rgba(255,255,255,0.55)",
  fontSize: 13,
  fontWeight: "600" as const,
};

const sectionLabel = {
  color: "rgba(255,255,255,0.75)",
  fontSize: 13,
  fontWeight: "800" as const,
  marginBottom: 10,
};

const suggestionWrap = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 10,
};

const suggestionChip = {
  minHeight: 38,
  maxWidth: "48%",
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 999,
  backgroundColor: "rgba(255,255,255,0.12)",
  borderWidth: 1,
  borderColor: "rgba(179,230,255,0.12)",
};

const suggestionText = {
  color: "rgba(255,255,255,0.90)",
  fontSize: 12,
  fontWeight: "700" as const,
};

const userBubbleWrap = {
  alignItems: "flex-end" as const,
  marginBottom: 12,
};

const userBubble = {
  maxWidth: "86%",
  backgroundColor: "rgba(10,17,34,0.86)",
  borderRadius: 18,
  paddingHorizontal: 14,
  paddingVertical: 12,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.07)",
};

const userBubbleText = {
  color: "rgba(255,255,255,0.92)",
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

const miniOrb = {
  width: 42,
  height: 42,
  borderRadius: 21,
  backgroundColor: "rgba(90,217,255,0.22)",
  borderWidth: 1,
  borderColor: "rgba(130,220,255,0.22)",
};

const cardTitle = {
  color: "rgba(255,255,255,0.95)",
  fontWeight: "900" as const,
  fontSize: 15,
};

const cardSub = {
  marginTop: 5,
  color: "rgba(255,255,255,0.64)",
  lineHeight: 19,
  fontSize: 13,
};

const composerShell = {
  position: "absolute" as const,
  left: 0,
  right: 0,
  bottom: 82,
  paddingHorizontal: 14,
};

const composer = {
  minHeight: 64,
  borderRadius: 24,
  paddingLeft: 16,
  paddingRight: 10,
  paddingVertical: 10,
  flexDirection: "row" as const,
  alignItems: "flex-end" as const,
  gap: 10,
  backgroundColor: "rgba(18,33,67,0.96)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
  shadowColor: "#000",
  shadowOpacity: 0.22,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 12,
};

const composerInput = {
  flex: 1,
  maxHeight: 120,
  color: "white",
  fontSize: 15,
  paddingTop: 8,
  paddingBottom: 8,
};

const roundButton = {
  width: 42,
  height: 42,
  borderRadius: 21,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const roundButtonSoft = {
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const roundButtonPrimary = {
  backgroundColor: "rgba(99,191,255,0.95)",
};

const roundButtonDisabled = {
  backgroundColor: "rgba(255,255,255,0.10)",
};

const roundButtonDanger = {
  backgroundColor: "rgba(255,76,76,0.92)",
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