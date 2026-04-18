import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { AssistantSettings } from "@/lib/storage";
import { Brand } from "@/constants/theme";

function uniqueSamples(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    )
  );
}

export default function SettingsModal() {
  const { name, settings, updateName, updateSettings } = useAssistant();
  const [n, setN] = useState(name);
  const [tone, setTone] = useState<AssistantSettings["tone"]>(settings.tone);
  const [languageMode, setLanguageMode] = useState<AssistantSettings["languageMode"]>(
    settings.languageMode
  );
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(settings.handsFreeEnabled);
  const [wakePhrase, setWakePhrase] = useState(settings.wakePhrase || `Hey ${name || "Elli"}`);
  const [wakeTrainingSamples, setWakeTrainingSamples] = useState<string[]>(
    settings.wakeTrainingSamples || []
  );
  const [trainingWakePhrase, setTrainingWakePhrase] = useState(false);
  const [trainingTranscript, setTrainingTranscript] = useState("");

  useEffect(() => {
    setN(name);
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
    setHandsFreeEnabled(settings.handsFreeEnabled);
    setWakePhrase(settings.wakePhrase || `Hey ${name || "Elli"}`);
    setWakeTrainingSamples(settings.wakeTrainingSamples || []);
  }, [name, settings]);

  const wakePrompt = useMemo(
    () => wakePhrase.trim() || `Hey ${n.trim() || "Elli"}`,
    [n, wakePhrase]
  );

  const speechLocale = languageMode === "ta" ? "ta-IN" : "en-IN";

  useSpeechRecognitionEvent("result", (event: any) => {
    if (!trainingWakePhrase) return;
    const transcript = String(event?.results?.[0]?.transcript || "").trim();
    if (!transcript) return;

    setTrainingTranscript(transcript);

    if (event?.isFinal) {
      setWakePhrase(transcript);
      setWakeTrainingSamples((prev) => uniqueSamples([transcript, ...prev]));
      setTrainingWakePhrase(false);
      ExpoSpeechRecognitionModule.abort();
    }
  });

  useSpeechRecognitionEvent("error", (event: any) => {
    if (!trainingWakePhrase) return;

    setTrainingWakePhrase(false);

    if (event?.error && event.error !== "aborted") {
      Alert.alert(
        "Voice training failed",
        event?.message || "Could not capture the wake phrase sample."
      );
    }
  });

  useSpeechRecognitionEvent("end", () => {
    if (trainingWakePhrase) {
      setTrainingWakePhrase(false);
    }
  });

  async function startWakePhraseTraining() {
    try {
      setTrainingTranscript("");
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Permissions needed",
          "Please allow microphone and speech recognition access to train the wake phrase."
        );
        return;
      }

      setTrainingWakePhrase(true);
      ExpoSpeechRecognitionModule.start({
        lang: speechLocale,
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: Platform.OS === "ios",
      });
    } catch (error: unknown) {
      setTrainingWakePhrase(false);
      const message =
        error instanceof Error ? error.message : "Could not start wake phrase training.";
      Alert.alert("Voice training failed", message);
    }
  }

  async function save() {
    const nextName = n.trim() || "Elli";
    const nextWakePhrase = wakePrompt;

    await updateName(nextName);
    await updateSettings({
      tone,
      languageMode,
      handsFreeEnabled,
      wakePhrase: nextWakePhrase,
      wakeTrainingSamples: uniqueSamples(wakeTrainingSamples),
    });
    router.back();
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.page}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={styles.topGlow} />
          <View style={styles.leftGlow} />
          <View style={styles.bottomGlow} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Pressable onPress={() => router.back()} style={styles.closeBtn}>
            <Ionicons name="close" size={18} color={Brand.cocoa} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>

          <Text style={styles.title}>Quick settings</Text>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Assistant name</Text>
            <TextInput
              value={n}
              onChangeText={setN}
              placeholder="Elli"
              placeholderTextColor="rgba(124, 99, 80, 0.52)"
              style={styles.input}
            />
          </GlassCard>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Personality</Text>
            <Row>
              <Pill active={tone === "pro"} label="Professional" onPress={() => setTone("pro")} />
              <Pill
                active={tone === "friendly"}
                label="Friendly"
                onPress={() => setTone("friendly")}
              />
            </Row>
          </GlassCard>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <Text style={styles.sectionTitle}>Reply language</Text>

            <Row>
              <Pill
                active={languageMode === "en"}
                label="English"
                onPress={() => setLanguageMode("en")}
              />
              <Pill
                active={languageMode === "ta"}
                label="Tamil"
                onPress={() => setLanguageMode("ta")}
              />
            </Row>
          </GlassCard>

          <GlassCard style={{ borderRadius: 24, marginTop: 14 }}>
            <View style={styles.switchRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.sectionTitle}>Hands free</Text>
              </View>
              <Switch
                value={handsFreeEnabled}
                onValueChange={setHandsFreeEnabled}
                trackColor={{ false: "rgba(124, 99, 80, 0.18)", true: "rgba(215,154,89,0.55)" }}
                thumbColor="#fff7ef"
              />
            </View>

            <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Wake phrase</Text>
            <TextInput
              value={wakePhrase}
              onChangeText={setWakePhrase}
              placeholder={`Hey ${n.trim() || "Elli"}`}
              placeholderTextColor="rgba(124, 99, 80, 0.52)"
              autoCapitalize="words"
              style={styles.input}
            />

            <Pressable
              onPress={startWakePhraseTraining}
              style={({ pressed }) => [styles.trainingButton, pressed && styles.pressed]}
            >
              <Ionicons
                name={trainingWakePhrase ? "mic" : "radio-outline"}
                size={16}
                color={Brand.cocoa}
              />
              <Text style={styles.trainingButtonText}>
                {trainingWakePhrase ? "Listening for wake phrase…" : "Train wake phrase with your voice"}
              </Text>
            </Pressable>

            {trainingTranscript ? (
              <View style={styles.trainingResultCard}>
                <Text style={styles.trainingResultLabel}>Latest captured phrase</Text>
                <Text style={styles.trainingResultValue}>{trainingTranscript}</Text>
              </View>
            ) : null}

            {wakeTrainingSamples.length ? (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.trainingSamplesTitle}>Saved wake phrase samples</Text>
                <View style={styles.sampleWrap}>
                  {wakeTrainingSamples.map((sample) => (
                    <View key={sample} style={styles.samplePill}>
                      <Text style={styles.samplePillText}>{sample}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </GlassCard>

          <Pressable
            onPress={save}
            style={({ pressed }) => [styles.saveShell, pressed && styles.pressed]}
          >
            <LinearGradient
              colors={Brand.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtn}
            >
              <Text style={styles.saveText}>Save</Text>
            </LinearGradient>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Pill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        active && styles.pillActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  content: {
    padding: 16,
    paddingBottom: 28,
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 240,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  closeBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  closeText: {
    color: Brand.cocoa,
    fontWeight: "900",
    fontSize: 14,
  },

  title: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 28,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  sectionTitle: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 16,
  },

  input: {
    marginTop: 10,
    height: 50,
    borderRadius: 16,
    paddingHorizontal: 12,
    color: Brand.ink,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  row: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
    flexWrap: "wrap",
  },

  pill: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.60)",
  },

  pillActive: {
    borderColor: "rgba(185,120,54,0.22)",
    backgroundColor: "rgba(255,229,180,0.82)",
  },

  pillText: {
    color: Brand.cocoa,
    fontWeight: "900",
  },

  pillTextActive: {
    color: Brand.ink,
  },

  helperText: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  switchRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  trainingButton: {
    marginTop: 14,
    minHeight: 46,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.62)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
  },

  trainingButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  trainingResultCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.7)",
    padding: 12,
  },

  trainingResultLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  trainingResultValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "800",
  },

  trainingSamplesTitle: {
    color: Brand.ink,
    fontSize: 13,
    fontWeight: "900",
  },

  sampleWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },

  samplePill: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  samplePillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  saveShell: {
    marginTop: 16,
    borderRadius: 18,
    overflow: "hidden",
  },

  saveBtn: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },

  saveText: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 16,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});