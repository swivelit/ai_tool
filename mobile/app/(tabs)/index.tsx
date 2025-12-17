import React, { useMemo, useRef, useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable, ScrollView, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";

import { GlassCard } from "@/components/Glass";
import { Orb } from "@/components/Orb";
import { Waveform } from "@/components/Waveform";
import { useAssistant } from "@/components/AssistantProvider";
import { apiPost, apiPostForm } from "@/lib/api";
import { Item } from "@/lib/types";

type AnalyzeResponse = Item;

export default function Home() {
  const { name, settings } = useAssistant();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [listening, setListening] = useState(false);

  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  const placeholder = useMemo(() => {
    return settings.languageMode === "ta"
      ? "தமிழில் சொல்லுங்க… (உதா: நாளைக்கு காலை 8 மணிக்கு ரிமைண்டர்)"
      : "Tamil / Tanglish… (ex: nalaiku 8 mani reminder vechiko)";
  }, [settings.languageMode]);

  async function analyzeText() {
    if (!text.trim()) return;
    try {
      setBusy(true);
      const res = await apiPost<AnalyzeResponse>("/analyze-text", {
        text,
        meta: { tone: settings.tone, languageMode: settings.languageMode }, // future-proof
      });
      setResult(res);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
      form.append("file", {
        uri,
        name: "audio.m4a",
        type: "audio/m4a",
      } as any);

      const res = await apiPostForm<AnalyzeResponse>("/transcribe-and-analyze", form);
      setResult(res);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Voice analyze failed");
    } finally {
      setBusy(false);
    }
  }

  function chip(t: string) {
    setText(t);
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 16, paddingTop: 10 }}>
        <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
          <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 28, fontWeight: "900" }}>
            Tamil Voice AI
          </Text>
          <Text style={{ marginTop: 8, color: "rgba(255,255,255,0.60)", fontSize: 14 }}>
            Hi, I am {name}. What can I do for you today?
          </Text>

          <GlassCard style={{ marginTop: 16 }}>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder={placeholder}
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={{
                minHeight: 110,
                color: "white",
                fontSize: 16,
                lineHeight: 22,
              }}
            />

            <Pressable
              onPress={analyzeText}
              disabled={busy}
              style={{
                marginTop: 12,
                height: 52,
                borderRadius: 16,
                backgroundColor: "rgba(34,211,238,0.22)",
                borderWidth: 1,
                borderColor: "rgba(34,211,238,0.35)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "white", fontWeight: "900", fontSize: 16 }}>
                {busy ? "WORKING…" : "ANALYZE"}
              </Text>
            </Pressable>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
              {[
                "நாளைக்கு காலை 8 மணிக்கு office meeting reminder வை",
                "விஸ்னஸ் நோட்ஸ் ஒப்பன் பண்ணுங்க",
                "Today customer followup task add pannunga",
                "Amma ku medicine reminder vechiko",
              ].map((c) => (
                <Pressable
                  key={c}
                  onPress={() => chip(c)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.10)",
                    backgroundColor: "rgba(255,255,255,0.06)",
                  }}
                >
                  <Text style={{ color: "rgba(255,255,255,0.75)", fontWeight: "700" }}>{c}</Text>
                </Pressable>
              ))}
            </View>
          </GlassCard>

          <View style={{ marginTop: 18 }}>
            <Text style={{ color: "rgba(255,255,255,0.78)", fontWeight: "900", fontSize: 16 }}>
              Voice (Tamil)
            </Text>
            <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.55)" }}>
              Tap the orb to {recording ? "stop & analyze" : "start recording"}.
            </Text>

            <GlassCard style={{ marginTop: 12, alignItems: "center" }}>
              <Waveform active={!!recording} />
            </GlassCard>
          </View>

          {result && (
            <GlassCard style={{ marginTop: 16 }}>
              <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 18, fontWeight: "900" }}>
                Result
              </Text>
              <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.80)" }}>
                Id: {result.id}
              </Text>
              <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.80)" }}>
                Intent: {result.intent}
              </Text>
              <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.80)" }}>
                Category: {result.category}
              </Text>
              {!!result.datetime && (
                <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.80)" }}>
                  When: {result.datetime}
                </Text>
              )}
              {!!result.title && (
                <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.85)", fontWeight: "800" }}>
                  Title: {result.title}
                </Text>
              )}
              {!!result.details && (
                <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.70)" }}>
                  Details: {result.details}
                </Text>
              )}
              <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.70)" }}>
                Raw: {result.raw_text}
              </Text>
            </GlassCard>
          )}
        </ScrollView>

        {/* Floating Orb */}
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 24,
            alignItems: "center",
          }}
        >
          <Orb
            listening={listening || !!recording}
            onPress={() => {
              if (recording) stopAndAnalyze();
              else startRecording();
            }}
          />
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}
