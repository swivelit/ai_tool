import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import {
  createProfileOnBackend,
  getProfile,
  getProfileForFirebaseUid,
  markQuestionnaireCompleted,
} from "@/lib/account";
import {
  getProfilerStateOnPhone,
  LocalChatMessage,
  sendProfilerMessageOnPhone,
  startProfilerOnPhone,
} from "@/lib/localAgents";

export default function QuestionnaireScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);

  const { profile, userId, refresh, settings, name: assistantName } = useAssistant();
  const { user } = useAuth();

  const [resolvedUserId, setResolvedUserId] = useState<number | null>(userId || profile?.userId || null);
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [completedSlots, setCompletedSlots] = useState(0);
  const [totalSlots, setTotalSlots] = useState(15);

  const replyLanguage = settings.languageMode === "en" ? "en" : "ta";

  const progress = useMemo(() => {
    if (!totalSlots) return 0;
    return Math.min(1, completedSlots / totalSlots);
  }, [completedSlots, totalSlots]);

  useEffect(() => {
    let alive = true;

    async function resolveUserIdAndBoot() {
      try {
        setLoading(true);

        let nextUserId = userId || profile?.userId || null;

        if (!nextUserId) {
          const localProfile = await getProfile();
          if (localProfile?.userId) {
            nextUserId = localProfile.userId;
          }
        }

        if (!nextUserId && user) {
          const existing = await getProfileForFirebaseUid(user.uid, user.email);
          if (existing?.userId) {
            nextUserId = existing.userId;
          } else {
            const provider =
              user.providerData?.some((item) => item.providerId === "google.com")
                ? "google"
                : "password";

            const rebuilt = await createProfileOnBackend({
              userId: undefined,
              firebaseUid: user.uid,
              firebaseEmailVerified: user.emailVerified,
              email: user.email || "",
              avatarUrl: user.photoURL || undefined,
              authProvider: provider,
              name: profile?.name || user.displayName || "User",
              place: profile?.place || "",
              assistantName: profile?.assistantName || assistantName || "Elli",
              timezone: profile?.timezone || "Asia/Kolkata",
              questionnaireCompleted: false,
              replyLanguage,
            });

            nextUserId = rebuilt?.userId ?? null;
          }
        }

        if (!alive) return;

        if (!nextUserId) {
          Alert.alert("Profile missing", "Please complete your profile first.");
          router.replace("/onboarding/profile");
          return;
        }

        setResolvedUserId(nextUserId);

        const current = await getProfilerStateOnPhone(nextUserId);

        if (!alive) return;

        setCompletedSlots(current.completedSlots);
        setTotalSlots(current.totalSlots);
        setDone(current.missingSlots.length === 0);

        if (current.state.history?.length) {
          setMessages(current.state.history);
        } else {
          const started = await startProfilerOnPhone(nextUserId, {
            replyLanguage,
            userProfile: {
              name: profile?.name || user?.displayName || "User",
              place: profile?.place || "",
              assistantName: profile?.assistantName || assistantName || "Elli",
            },
          });
          if (!alive) return;
          setMessages(started.history);
          setCompletedSlots(started.completedSlots);
          setTotalSlots(started.totalSlots);
          setDone(started.done);
        }
      } catch (error: any) {
        if (!alive) return;
        Alert.alert("Couldn’t start onboarding", error?.message || "Please try again.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    void resolveUserIdAndBoot();

    return () => {
      alive = false;
    };
  }, [assistantName, profile?.assistantName, profile?.name, profile?.place, profile?.timezone, profile?.userId, replyLanguage, user, userId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);

    return () => clearTimeout(timer);
  }, [messages]);

  async function handleSend() {
    if (!resolvedUserId || !input.trim() || sending) return;

    const userMessage = input.trim();
    setInput("");
    setSending(true);

    try {
      const next = await sendProfilerMessageOnPhone(resolvedUserId, userMessage, {
        replyLanguage,
        userProfile: {
          name: profile?.name || user?.displayName || "User",
          place: profile?.place || "",
          assistantName: profile?.assistantName || assistantName || "Elli",
        },
      });

      setMessages(next.history);
      setCompletedSlots(next.completedSlots);
      setTotalSlots(next.totalSlots);
      setDone(next.done);

      if (next.done) {
        await markQuestionnaireCompleted(true);
        await refresh();
      }
    } catch (error: any) {
      Alert.alert("Couldn’t continue", error?.message || "Please try again.");
      setInput(userMessage);
    } finally {
      setSending(false);
    }
  }

  function continueToApp() {
    router.replace("/(tabs)");
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.screen}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 12}
      >
        <View
          style={[
            styles.container,
            { paddingTop: insets.top + 16, paddingBottom: Math.max(insets.bottom + 14, 18) },
          ]}
        >
          <GlassCard style={styles.headerCard}>
            <View style={styles.headerRow}>
              <View style={styles.headerCopy}>
                <Text style={styles.kicker}>Profiler Agent</Text>
                <Text style={styles.title}>Natural onboarding</Text>
                <Text style={styles.subtitle}>
                  No static 15-question form. The assistant collects your profile through a casual chat.
                </Text>
              </View>

              <View style={styles.sparkWrap}>
                <Ionicons name="sparkles" size={22} color={Brand.bronze} />
              </View>
            </View>

            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
              </View>
              <Text style={styles.progressText}>
                {completedSlots}/{totalSlots} collected
              </Text>
            </View>
          </GlassCard>

          <View style={styles.chatWrap}>
            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={Brand.bronze} />
                <Text style={styles.loadingText}>Starting your local profiler…</Text>
              </View>
            ) : (
              <ScrollView
                ref={scrollRef}
                style={styles.chatScroll}
                contentContainerStyle={styles.chatContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                showsVerticalScrollIndicator={false}
              >
                {messages.map((message, index) => {
                  const mine = message.role === "user";
                  return (
                    <View
                      key={`${message.createdAt}_${index}`}
                      style={[
                        styles.bubbleRow,
                        mine ? styles.bubbleRowRight : styles.bubbleRowLeft,
                      ]}
                    >
                      <View
                        style={[
                          styles.bubble,
                          mine ? styles.userBubble : styles.assistantBubble,
                        ]}
                      >
                        {!mine ? (
                          <Text style={styles.assistantLabel}>
                            {profile?.assistantName || assistantName || "Elli"}
                          </Text>
                        ) : null}
                        <Text style={[styles.bubbleText, mine ? styles.userBubbleText : styles.assistantBubbleText]}>
                          {message.content}
                        </Text>
                      </View>
                    </View>
                  );
                })}

                {done ? (
                  <GlassCard style={styles.doneCard}>
                    <Text style={styles.doneTitle}>Profile ready</Text>
                    <Text style={styles.doneText}>
                      The Profiler Agent has enough context to personalize responses.
                    </Text>

                    <Pressable style={styles.doneButton} onPress={continueToApp}>
                      <Text style={styles.doneButtonText}>Continue to app</Text>
                    </Pressable>
                  </GlassCard>
                ) : null}
              </ScrollView>
            )}
          </View>

          {!done ? (
            <GlassCard style={styles.composerCard}>
              <View style={styles.composerRow}>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder={replyLanguage === "ta" ? "உங்களைப் பற்றி பதில் சொல்லுங்கள்…" : "Reply naturally…"}
                  placeholderTextColor={Brand.textMuted}
                  style={styles.input}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  style={[styles.sendButton, (!input.trim() || sending) && styles.sendButtonDisabled]}
                  disabled={!input.trim() || sending}
                  onPress={handleSend}
                >
                  {sending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color="#fff" />
                  )}
                </Pressable>
              </View>
            </GlassCard>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 18,
    gap: 14,
  },
  headerCard: {
    padding: 18,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    gap: 14,
    alignItems: "flex-start",
  },
  headerCopy: {
    flex: 1,
    gap: 6,
  },
  sparkWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(218, 165, 32, 0.14)",
  },
  kicker: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.bronze,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: Brand.text,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: Brand.textMuted,
  },
  progressWrap: {
    gap: 8,
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: "rgba(135, 70, 40, 0.12)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: Brand.bronze,
  },
  progressText: {
    fontSize: 12,
    fontWeight: "700",
    color: Brand.textMuted,
  },
  chatWrap: {
    flex: 1,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    color: Brand.textMuted,
    fontSize: 14,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    paddingVertical: 6,
    paddingBottom: 8,
    gap: 10,
  },
  bubbleRow: {
    flexDirection: "row",
  },
  bubbleRowLeft: {
    justifyContent: "flex-start",
  },
  bubbleRowRight: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "86%",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  assistantBubble: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderWidth: 1,
    borderColor: "rgba(135,70,40,0.08)",
  },
  userBubble: {
    backgroundColor: Brand.bronze,
  },
  assistantLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: Brand.bronze,
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  assistantBubbleText: {
    color: Brand.text,
  },
  userBubbleText: {
    color: "#fff",
  },
  doneCard: {
    marginTop: 8,
    padding: 18,
    gap: 10,
  },
  doneTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: Brand.text,
  },
  doneText: {
    fontSize: 14,
    lineHeight: 20,
    color: Brand.textMuted,
  },
  doneButton: {
    marginTop: 4,
    borderRadius: 16,
    backgroundColor: Brand.bronze,
    paddingHorizontal: 16,
    paddingVertical: 13,
    alignItems: "center",
  },
  doneButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },
  composerCard: {
    padding: 10,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    fontSize: 15,
    lineHeight: 21,
    color: Brand.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Brand.bronze,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});