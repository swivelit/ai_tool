import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, TextInput, ScrollView, ActivityIndicator, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import Constants from "expo-constants";

import AssistantNameModal from "../../components/AssistantNameModal";
import { DEFAULT_ASSISTANT_NAME, getAssistantName, setAssistantName } from "../../lib/assistantName";

const API_BASE =
  (Constants.expoConfig?.extra?.API_BASE as string) ||
  "https://ai-tool-rrau.onrender.com"; // Render URL for APK builds

type Result = {
  id?: number;
  intent?: string;
  category?: string;
  datetime?: string | null;
  title?: string | null;
  details?: string | null;
  raw_text?: string;
  transcript?: string | null;
  error?: string;
};

export default function HomeScreen() {
  const [assistantName, setAssistantNameState] = useState<string>(DEFAULT_ASSISTANT_NAME);
  const [showNameModal, setShowNameModal] = useState(false);

  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  // hook your real recording logic here
  const recordingSupported = Platform.OS !== "web";
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    (async () => {
      const existing = await getAssistantName();
      if (!existing) {
        setShowNameModal(true);
      } else {
        setAssistantNameState(existing);
      }
    })();
  }, []);

  const canAnalyze = useMemo(() => text.trim().length > 0 && !loading, [text, loading]);

  async function analyzeText(payloadText?: string) {
    const finalText = (payloadText ?? text).trim();
    if (!finalText) return;

    try {
      setLoading(true);
      setResult(null);

      const res = await fetch(`${API_BASE}/analyze-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: finalText }),
      });

      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setResult({ error: e?.message || "Something went wrong" });
    } finally {
      setLoading(false);
    }
  }

  async function startRecording() {
    // TODO: plug your Expo Audio start logic
    setIsRecording(true);
  }

  async function stopAndAnalyzeRecording() {
    // TODO: plug your Expo Audio stop + upload logic to /transcribe-and-analyze
    setIsRecording(false);
  }

  const chips = [
    { label: "Office meeting reminder", value: "நாளைக்கு காலை 8 மணிக்கு office meeting reminder வெச்சுக்கோ" },
    { label: "Business notes", value: "நேத்து சொன்ன business notes save பண்ணுங்க" },
    { label: "Open PDF", value: "அந்த pdf open பண்ணுங்க" },
    { label: "Task list", value: "இன்னைக்கு செய்ய வேண்டிய task list create பண்ணுங்க" },
  ];

  return (
    <LinearGradient
      colors={["#0B1020", "#1A1030", "#0B1020"]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={{ flex: 1 }}
    >
      <AssistantNameModal
        visible={showNameModal}
        defaultName={DEFAULT_ASSISTANT_NAME}
        onSkip={async () => {
          await setAssistantName(DEFAULT_ASSISTANT_NAME);
          setAssistantNameState(DEFAULT_ASSISTANT_NAME);
          setShowNameModal(false);
        }}
        onSave={async (name) => {
          await setAssistantName(name);
          setAssistantNameState(name);
          setShowNameModal(false);
        }}
      />

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 160 }}>
        {/* Top title */}
        <View style={{ marginTop: 10, marginBottom: 14 }}>
          <Text style={styles.title}>{assistantName}</Text>
          <Text style={styles.subTitle}>Type or speak in Tamil. We’ll understand and act.</Text>
        </View>

        {/* Main “Assistant Card” */}
        <BlurView intensity={22} tint="dark" style={styles.glassCard}>
          <Text style={styles.cardSmall}>Ask {assistantName}</Text>
          <Text style={styles.cardBig}>
            Hi, I am {assistantName}.{"\n"}What can I do for you today?
          </Text>

          {/* Input */}
          <View style={styles.inputWrap}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Type a Tamil instruction…"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.input}
              multiline
            />
          </View>

          {/* Analyze */}
          <Pressable
            onPress={() => analyzeText()}
            disabled={!canAnalyze}
            style={({ pressed }) => [
              styles.primaryBtn,
              (!canAnalyze || pressed) && { opacity: 0.7 },
              !canAnalyze && { opacity: 0.45 },
            ]}
          >
            {loading ? <ActivityIndicator /> : <Text style={styles.primaryBtnText}>Analyze</Text>}
          </Pressable>

          {/* Suggestion chips */}
          <View style={styles.chipsRow}>
            {chips.map((c) => (
              <Pressable
                key={c.label}
                onPress={() => {
                  setText(c.value);
                  analyzeText(c.value);
                }}
                style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
              >
                <Text style={styles.chipText}>{c.label}</Text>
              </Pressable>
            ))}
          </View>

          {/* Change name button */}
          <Pressable
            onPress={() => setShowNameModal(true)}
            style={({ pressed }) => [
              {
                marginTop: 14,
                alignSelf: "flex-start",
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.12)",
                backgroundColor: "rgba(255,255,255,0.06)",
              },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, fontWeight: "800" }}>
              Rename assistant
            </Text>
          </Pressable>
        </BlurView>

        {/* Result Card */}
        <BlurView intensity={18} tint="dark" style={[styles.glassCard, { marginTop: 14 }]}>
          <Text style={styles.cardSmall}>Result</Text>

          {!result ? (
            <Text style={{ color: "rgba(255,255,255,0.6)", marginTop: 8 }}>No result yet.</Text>
          ) : result.error ? (
            <Text style={{ color: "#FCA5A5", marginTop: 8 }}>{result.error}</Text>
          ) : (
            <View style={{ marginTop: 10, gap: 10 }}>
              <Row label="Intent" value={result.intent ?? ""} />
              <Row label="Category" value={result.category ?? ""} />
              <Row label="When" value={result.datetime ?? "—"} />
              <Row label="Title" value={result.title ?? "—"} />
              <Row label="Details" value={result.details ?? "—"} />
              <Row label="Raw" value={result.raw_text ?? result.transcript ?? ""} />
            </View>
          )}

          <Text style={{ color: "rgba(255,255,255,0.35)", marginTop: 14, fontSize: 12 }}>
            API: {API_BASE}
          </Text>
        </BlurView>
      </ScrollView>

      {/* Bottom mic orb */}
      <View style={styles.bottomDock}>
        <View style={styles.dockPad} />
        <Pressable
          onPress={recordingSupported ? (isRecording ? stopAndAnalyzeRecording : startRecording) : undefined}
          style={({ pressed }) => [styles.micOrb, pressed && { transform: [{ scale: 0.98 }] }]}
        >
          <LinearGradient
            colors={isRecording ? ["#FF4D6D", "#FF7A59"] : ["#7C3AED", "#22D3EE"]}
            style={styles.micOrbInner}
          >
            <Text style={{ color: "white", fontWeight: "900", fontSize: 16 }}>
              {recordingSupported ? (isRecording ? "STOP" : "MIC") : "WEB"}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={styles.micHint}>
          <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            {recordingSupported ? (isRecording ? "Listening…" : "Tap to speak") : "Voice not supported on web"}
          </Text>
        </View>
      </View>
    </LinearGradient>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>{label}</Text>
      <Text style={{ color: "rgba(255,255,255,0.90)", fontSize: 15, marginTop: 2, lineHeight: 20 }}>
        {value}
      </Text>
    </View>
  );
}

const styles = {
  title: { color: "rgba(255,255,255,0.92)", fontSize: 30, fontWeight: "900" as const, letterSpacing: 0.2 },
  subTitle: { color: "rgba(255,255,255,0.55)", fontSize: 14, marginTop: 6, lineHeight: 20 },

  glassCard: {
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.06)",
    overflow: "hidden" as const,
  },

  cardSmall: { color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "700" as const },
  cardBig: { color: "rgba(255,255,255,0.92)", fontSize: 16, fontWeight: "800" as const, marginTop: 10, lineHeight: 22 },

  inputWrap: {
    marginTop: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(0,0,0,0.18)",
    padding: 12,
  },
  input: { minHeight: 84, color: "rgba(255,255,255,0.92)", textAlignVertical: "top" as const },

  primaryBtn: {
    marginTop: 12,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center" as const,
    backgroundColor: "rgba(124,58,237,0.85)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  primaryBtnText: { color: "white", fontWeight: "900" as const, fontSize: 14, letterSpacing: 0.3 },

  chipsRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10, marginTop: 14 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  chipText: { color: "rgba(255,255,255,0.75)", fontSize: 12, fontWeight: "700" as const },

  bottomDock: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    paddingBottom: 26,
    paddingTop: 10,
  },
  dockPad: {
    position: "absolute" as const,
    left: 16,
    right: 16,
    bottom: 16,
    height: 74,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  micOrb: {
    width: 74,
    height: 74,
    borderRadius: 37,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  micOrbInner: {
    flex: 1,
    borderRadius: 37,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.20)",
  },
  micHint: { marginTop: 6 },
};
