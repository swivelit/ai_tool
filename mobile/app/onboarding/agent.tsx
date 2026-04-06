import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Alert
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import {
  createProfileOnBackend,
  getProfileForFirebaseUid,
  markQuestionnaireCompleted,
} from "@/lib/account";

type Message = {
  id: string;
  role: "user" | "ai";
  text: string;
};

const API_URL = process.env.EXPO_PUBLIC_API_URL ? `${process.env.EXPO_PUBLIC_API_URL}/api/onboarding/chat` : "http://10.0.2.2:8000/api/onboarding/chat";

export default function AgentScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);

  const { refresh } = useAssistant();
  const { user } = useAuth();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [questionCount, setQuestionCount] = useState(0);

  const userId = user?.uid || "user_" + Math.floor(Math.random() * 100000);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, options, sending]);

  async function syncProfileIfMissing() {
    if (!user) return;
    const existing = await getProfileForFirebaseUid(user.uid, user.email);
    if (!existing?.userId) {
      const provider =
        user.providerData?.some((item) => item.providerId === "google.com")
          ? "google"
          : "password";

      await createProfileOnBackend({
        userId: undefined,
        firebaseUid: user.uid,
        firebaseEmailVerified: user.emailVerified,
        email: user.email || "",
        avatarUrl: user.photoURL || undefined,
        authProvider: provider,
        name: user.displayName || "User",
        place: "",
        assistantName: "AI Assistant",
        timezone: "Asia/Kolkata",
        questionnaireCompleted: true,
        replyLanguage: "en",
      });
    }
  }

  async function handleComplete() {
    setDone(true);
    await syncProfileIfMissing();
    await markQuestionnaireCompleted(true);
    await refresh();
    setTimeout(() => {
      router.replace("/(tabs)");
    }, 1500);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return;

    const userMessage: Message = { id: Date.now().toString(), role: "user", text: text.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setOptions([]);
    setSending(true);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, message: text.trim() }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      const data = await response.json();

      if (data.status === "DONE" || data.status === "COMPLETED") {
        setMessages((prev) => [...prev, { id: Date.now().toString() + "ai", role: "ai", text: data.text }]);
        handleComplete();
        return;
      }

      setMessages((prev) => [...prev, { id: Date.now().toString() + "ai", role: "ai", text: data.text }]);
      setQuestionCount((c) => c + 1);

      if (data.options && data.options.length > 0) {
        setOptions(data.options);
      }
    } catch (error: any) {
      console.warn("API Error:", error);
      setMessages((prev) => [...prev, { id: Date.now().toString() + "err", role: "ai", text: "Connection lost. Please check if the API is running at " + API_URL }]);
    } finally {
      setSending(false);
    }
  }

  async function startAgent() {
    setStarted(true);
    setSending(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, message: "" }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();
      setMessages([{ id: Date.now().toString(), role: "ai", text: data.text }]);
      setQuestionCount(1);
    } catch (error) {
       console.warn("Start Error:", error);
       setMessages([{ id: Date.now().toString(), role: "ai", text: "Hi! I couldn't connect to the backend. Please ensure the Python API is running on " + API_URL }]);
    } finally {
      setSending(false);
    }
  }

  if (!started) {
    return (
      <View style={styles.startOverlay}>
        <StatusBar style="light" />
        <View style={styles.logoBadge}>
          <Text style={{ fontSize: 36 }}>🤖</Text>
        </View>
        <Text style={styles.startTitle}>AI Assistant</Text>
        <Text style={styles.startSubtitle}>Your personal onboarding companion. Type to get started!</Text>
        <Pressable style={styles.startBtn} onPress={startAgent}>
          <Text style={styles.startBtnText}>Tap to Begin</Text>
        </Pressable>
      </View>
    );
  }

  if (done) {
    return (
      <View style={styles.startOverlay}>
        <StatusBar style="light" />
        <View style={[styles.logoBadge, { backgroundColor: "#22c55e", shadowColor: "#22c55e", elevation: 10 }]}>
          <Ionicons name="checkmark" size={40} color="white" />
        </View>
        <Text style={styles.startTitle}>Setup Complete! 🎉</Text>
        <Text style={styles.startSubtitle}>Your profile has been created. Redirecting you to the dashboard...</Text>
      </View>
    );
  }

  const pct = Math.min((questionCount / 15) * 100, 100);

  return (
    <LinearGradient colors={["#0a0e1a", "#0d1117"]} style={styles.shell}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.headerLeft}>
          <View style={styles.aiAvatar}><Text style={{ fontSize: 18 }}>🤖</Text></View>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>AI Assistant</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>Online</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.progressContainer}>
        <View style={styles.progressTrack}>
          <LinearGradient
            colors={["#1a73e8", "#8b5cf6", "#ec4899"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.progressFill, { width: `${pct}%` }]}
          />
        </View>
        <Text style={styles.progressLabel}>Question {Math.min(questionCount, 15)} of 15</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.chatArea}
          contentContainerStyle={{ paddingBottom: 20 }}
          keyboardShouldPersistTaps="handled"
        >
          {messages.map((msg, idx) => {
            const isAi = msg.role === "ai";
            return (
              <View key={msg.id} style={[styles.msgRow, isAi ? styles.rowAi : styles.rowUser]}>
                {isAi && <View style={styles.msgAvatar}><Text style={{ fontSize: 14 }}>🤖</Text></View>}
                <View style={[styles.bubble, isAi ? styles.bubbleAi : styles.bubbleUser]}>
                  <Text style={[styles.bubbleText, isAi ? styles.textAi : styles.textUser]}>{msg.text}</Text>
                </View>
              </View>
            );
          })}

          {sending && (
            <View style={[styles.msgRow, styles.rowAi]}>
               <View style={styles.msgAvatar}><Text style={{ fontSize: 14 }}>🤖</Text></View>
               <View style={styles.typingDots}>
                  <ActivityIndicator color="#93c5fd" size="small" />
               </View>
            </View>
          )}

          {options.length > 0 && !sending && (
            <View style={styles.optionsRow}>
              {options.map((opt, i) => (
                <Pressable key={i} style={styles.optionBtn} onPress={() => sendMessage(opt)}>
                  <Text style={styles.optionBtnText}>{opt}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>

        <View style={[styles.inputPanel, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Pressable style={styles.micBtn} onPress={() => Alert.alert("Voice Not Supported", "Please use the text input for now.")}>
            <Ionicons name="mic" size={20} color="white" />
          </Pressable>
          <TextInput
            style={styles.inputField}
            placeholder="Type your answer..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={input}
            onChangeText={setInput}
            editable={!sending}
            onSubmitEditing={() => sendMessage(input)}
          />
          <Pressable 
             style={styles.sendBtn} 
             onPress={() => sendMessage(input)}
             disabled={sending || !input.trim()}
          >
            <Ionicons name="send" size={18} color={sending || !input.trim() ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.8)"} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  startOverlay: {
    flex: 1,
    backgroundColor: "#05080f",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    gap: 24
  },
  logoBadge: {
    width: 80, height: 80, borderRadius: 24,
    backgroundColor: "#1a73e8",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#1a73e8", shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  startTitle: { color: "white", fontSize: 24, fontWeight: "600" },
  startSubtitle: { color: "rgba(255,255,255,0.5)", textAlign: "center", fontSize: 14, lineHeight: 22 },
  startBtn: {
    paddingHorizontal: 40, paddingVertical: 14,
    backgroundColor: "#1565c0", borderRadius: 14,
    shadowColor: "#1a73e8", shadowOpacity: 0.5, shadowRadius: 15, elevation: 8
  },
  startBtnText: { color: "white", fontSize: 16, fontWeight: "600" },
  
  header: {
    paddingHorizontal: 20, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)",
    backgroundColor: "rgba(10, 14, 26, 0.95)"
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  aiAvatar: {
    width: 38, height: 38, borderRadius: 12, backgroundColor: "#1a73e8",
    alignItems: "center", justifyContent: "center",
  },
  headerInfo: { justifyContent: "center" },
  headerTitle: { color: "white", fontSize: 16, fontWeight: "600", letterSpacing: 0.3 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#4ade80" },
  statusText: { color: "#4ade80", fontSize: 11, fontWeight: "400" },

  progressContainer: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6, backgroundColor: "rgba(10, 14, 26, 0.95)" },
  progressTrack: { height: 3, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 10 },
  progressLabel: { fontSize: 10, color: "rgba(255,255,255,0.35)", textAlign: "right", marginTop: 4 },

  chatArea: { flex: 1, paddingHorizontal: 16, paddingTop: 20 },
  msgRow: { flexDirection: "row", maxWidth: "88%", marginBottom: 12 },
  rowAi: { alignSelf: "flex-start", gap: 10 },
  rowUser: { alignSelf: "flex-end" },
  msgAvatar: { width: 30, height: 30, borderRadius: 10, backgroundColor: "#1a73e8", alignItems: "center", justifyContent: "center", marginTop: 2 },
  bubble: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16 },
  bubbleAi: { backgroundColor: "rgba(26, 115, 232, 0.08)", borderWidth: 1, borderColor: "rgba(26, 115, 232, 0.2)", borderBottomLeftRadius: 4 },
  bubbleUser: { backgroundColor: "#1565c0", borderBottomRightRadius: 4 },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  textAi: { color: "#e2e8f0" },
  textUser: { color: "white" },

  typingDots: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: "rgba(26, 115, 232, 0.08)", borderWidth: 1, borderColor: "rgba(26, 115, 232, 0.15)", borderRadius: 16, borderBottomLeftRadius: 4 },

  optionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 40, marginBottom: 12 },
  optionBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: "rgba(26, 115, 232, 0.08)", borderWidth: 1, borderColor: "rgba(26, 115, 232, 0.25)" },
  optionBtnText: { color: "#93c5fd", fontSize: 13, fontWeight: "500" },

  inputPanel: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 12, backgroundColor: "rgba(10, 14, 26, 0.98)", borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)" },
  micBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#1565c0", alignItems: "center", justifyContent: "center" },
  inputField: { flex: 1, height: 48, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", borderRadius: 14, paddingHorizontal: 14, color: "white", fontSize: 14 },
  sendBtn: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }
});
