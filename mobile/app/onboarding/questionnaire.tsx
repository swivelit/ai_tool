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
import profilerSlotsSeed from "@/data/config/profiler_slots.json";
import {
  createProfileOnBackend,
  getProfile,
  getProfileForFirebaseUid,
} from "@/lib/account";
import {
  getProfilerStateOnPhone,
  LocalChatMessage,
  markProfilerOnboardingSyncedOnPhone,
  ProfilerSlot,
  retryPendingOnboardingSync,
  sendProfilerMessageOnPhone,
  startProfilerOnPhone,
} from "@/lib/localAgents";
import { enqueueClientTurnLog } from "@/lib/chatTelemetry";
import {
  OnboardingCompletionState,
  ensureOnboardingReadyHistory,
  resolveCompletedOnboardingState,
  sanitizeOnboardingHistory,
  shouldIgnoreOnboardingOptionPress,
  shouldIgnoreOnboardingSend,
  shouldShowOnboardingOptions,
} from "@/lib/onboardingWorkflow";

const PROFILER_SLOTS = profilerSlotsSeed as ProfilerSlot[];

function humanizeOption(option: string) {
  const clean = String(option || "").trim();
  if (!clean) return "";
  const spaced = clean.replace(/_/g, " ");
  if (spaced.toLowerCase() === "ai technology") return "AI & Technology";
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatSelectedOptions(options: string[]) {
  return options.map(humanizeOption).join(", ");
}

export default function QuestionnaireScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);

  const { profile, userId, refresh, settings, updateSettings, name: assistantName } = useAssistant();
  const { user } = useAuth();

  const [resolvedUserId, setResolvedUserId] = useState<number | null>(userId || profile?.userId || null);
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [completionState, setCompletionState] = useState<OnboardingCompletionState>("incomplete");
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [sessionReplyLanguage, setSessionReplyLanguage] = useState<"en" | "ta">(
    settings.languageMode === "en" ? "en" : "ta"
  );
  const sessionReplyLanguageRef = useRef(sessionReplyLanguage);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [, setCompletedSlots] = useState(0);
  const [, setTotalSlots] = useState(8);

  const activeSlot = useMemo(
    () => PROFILER_SLOTS.find((slot) => slot.id === activeSlotId) ?? null,
    [activeSlotId]
  );

  useEffect(() => {
    setSessionReplyLanguage(settings.languageMode === "en" ? "en" : "ta");
  }, [settings.languageMode]);

  useEffect(() => {
    sessionReplyLanguageRef.current = sessionReplyLanguage;
  }, [sessionReplyLanguage]);

  function inferReplyLanguageFromAnswer(message: string): "en" | "ta" {
    if (activeSlotId !== "preferred_language") {
      return sessionReplyLanguage;
    }

    const normalized = String(message || "").trim().toLowerCase();

    if (["en", "english", "speak english", "reply in english", "only english"].includes(normalized)) {
      return "en";
    }

    if (["ta", "tamil", "tamizh", "தமிழ்", "தமிழ் மட்டும்"].includes(normalized)) {
      return "ta";
    }

    return sessionReplyLanguage;
  }

  function persistReplyLanguage(nextReplyLanguage: "en" | "ta") {
    if (nextReplyLanguage === settings.languageMode) {
      return;
    }

    void updateSettings({
      ...settings,
      languageMode: nextReplyLanguage,
    }).catch((error) => {
      console.warn("[questionnaire] Failed to sync reply language:", error);
    });
  }

  function trackOnboarding(event: string, extra: Record<string, any> = {}) {
    void enqueueClientTurnLog({
      event,
      user_id: resolvedUserId,
      channel: "app",
      screen: "onboarding_questionnaire",
      ...extra,
    }).catch(() => undefined);
  }

  function syncCurrentStep(nextSlotId?: string | null) {
    setActiveSlotId(nextSlotId || null);
    setSelectedOptions([]);
  }

  useEffect(() => {
    let alive = true;

    async function resolveUserIdAndBoot() {
      try {
        setLoading(true);

        let nextUserId = userId || profile?.userId || null;
        let knownQuestionnaireCompleted = Boolean(profile?.questionnaireCompleted);
        const localProfile = await getProfile();
        knownQuestionnaireCompleted =
          knownQuestionnaireCompleted || Boolean(localProfile?.questionnaireCompleted);

        if (!nextUserId) {
          if (localProfile?.userId) {
            nextUserId = localProfile.userId;
          }
        }

        if (!nextUserId && user) {
          const existing = await getProfileForFirebaseUid(user.uid, user.email);
          knownQuestionnaireCompleted =
            knownQuestionnaireCompleted || Boolean(existing?.questionnaireCompleted);
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
              replyLanguage: sessionReplyLanguageRef.current,
            });

            nextUserId = rebuilt?.userId ?? null;
            knownQuestionnaireCompleted =
              knownQuestionnaireCompleted || Boolean(rebuilt?.questionnaireCompleted);
          }
        }

        if (!alive) return;

        if (!nextUserId) {
          Alert.alert("Profile missing", "Please complete your profile first.");
          router.replace("/onboarding/profile");
          return;
        }

        setResolvedUserId(nextUserId);
        void enqueueClientTurnLog({
          event: "onboarding_started",
          user_id: nextUserId,
          channel: "app",
          screen: "onboarding_questionnaire",
        }).catch(() => undefined);

        const current = await getProfilerStateOnPhone(nextUserId);

        if (!alive) return;

        setCompletedSlots(current.completedSlots);
        setTotalSlots(current.totalSlots);
        const currentDone =
          current.state.status === "complete" || current.missingSlots.length === 0;
        setDone(currentDone);
        syncCurrentStep(
          currentDone
            ? null
            : current.state.currentTargetSlot || current.missingSlots[0] || null
        );

        if (currentDone) {
          setMessages(ensureOnboardingReadyHistory(current.state.history || []));
          const resolvedCompletionState = resolveCompletedOnboardingState({
            localSyncState: current.state.completionSyncState,
            profileQuestionnaireCompleted: knownQuestionnaireCompleted,
          });
          setCompletionState(resolvedCompletionState);

          if (resolvedCompletionState === "complete_synced") {
            if (current.state.completionSyncState !== "complete_synced") {
              void markProfilerOnboardingSyncedOnPhone(nextUserId).catch(() => undefined);
            }
            return;
          }

          if (resolvedCompletionState === "sync_failed") {
            return;
          }

          try {
            setCompletionState("complete_local_pending_sync");
            await retryPendingOnboardingSync(nextUserId);
            const refreshedProfile = await refresh();
            if (!alive) return;
            if (!refreshedProfile?.questionnaireCompleted) {
              throw new Error("Backend did not confirm questionnaire completion.");
            }
            setCompletionState("complete_synced");
            trackOnboarding("onboarding_completed_synced");
          } catch (error: any) {
            if (!alive) return;
            setCompletionState("sync_failed");
            trackOnboarding("onboarding_sync_failed", {
              error_message: error?.message || "boot_sync_failed",
            });
          }
          return;
        }

        setCompletionState("incomplete");

        if (current.state.history?.length) {
          setMessages(
            sanitizeOnboardingHistory(current.state.history)
          );
        } else {
          const started = await startProfilerOnPhone(nextUserId, {
            replyLanguage: sessionReplyLanguageRef.current,
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
          setCompletionState(started.done ? "complete_local_pending_sync" : "incomplete");
          syncCurrentStep(started.done ? null : started.missingSlots[0] || null);
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
  }, [assistantName, profile?.assistantName, profile?.name, profile?.place, profile?.timezone, profile?.userId, user, userId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);

    return () => clearTimeout(timer);
  }, [messages, activeSlotId, selectedOptions]);

  async function handleSend(overrideMessage?: string) {
    if (
      shouldIgnoreOnboardingSend({
        resolvedUserId,
        sending,
        done,
        completionState,
        activeSlotId,
      })
    ) {
      trackOnboarding("onboarding_late_input_ignored", {
        workflow_step: activeSlotId,
        decision: "send_ignored_after_completion",
      });
      return;
    }

    const userMessage = String(overrideMessage ?? input).trim();
    if (!userMessage) return;
    const userIdForTurn = resolvedUserId;
    if (!userIdForTurn) return;

    const nextReplyLanguage = inferReplyLanguageFromAnswer(userMessage);

    if (nextReplyLanguage !== sessionReplyLanguage) {
      setSessionReplyLanguage(nextReplyLanguage);
      persistReplyLanguage(nextReplyLanguage);
    }

    trackOnboarding("onboarding_slot_answered", {
      workflow_step: activeSlotId,
      question_length: userMessage.length,
    });
    setInput("");
    setSending(true);
    let completedThisTurn = false;

    try {
      const next = await sendProfilerMessageOnPhone(userIdForTurn, userMessage, {
        replyLanguage: nextReplyLanguage,
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
        completedThisTurn = true;
        setActiveSlotId(null);
        setSelectedOptions([]);
        setCompletionState("complete_local_pending_sync");
        trackOnboarding("onboarding_completed_local");
        const refreshedProfile = await refresh();

        if (!refreshedProfile?.questionnaireCompleted) {
          setCompletionState("sync_failed");
          trackOnboarding("onboarding_sync_failed", {
            error_message: "backend_not_confirmed",
          });
          throw new Error(
            "The backend did not confirm questionnaire completion from saved profiler answers. Please try again."
          );
        }

        setCompletionState("complete_synced");
        trackOnboarding("onboarding_completed_synced");
      } else {
        syncCurrentStep(next.missingSlots[0] || null);
        setCompletionState("incomplete");
      }
    } catch (error: any) {
      if (done || completedThisTurn) {
        setCompletionState("sync_failed");
      }
      trackOnboarding("onboarding_sync_failed", {
        workflow_step: activeSlotId,
        error_message: error?.message || "unknown_error",
      });
      Alert.alert("Couldn’t continue", error?.message || "Please try again.");
      if (!overrideMessage) {
        setInput(userMessage);
      }
    } finally {
      setSending(false);
    }
  }

  async function retrySync() {
    if (!resolvedUserId || sending) return;

    try {
      setSending(true);
      setCompletionState("complete_local_pending_sync");
      await retryPendingOnboardingSync(resolvedUserId);
      const refreshedProfile = await refresh();

      if (!refreshedProfile?.questionnaireCompleted) {
        throw new Error("Backend still did not confirm questionnaire completion.");
      }

      setCompletionState("complete_synced");
      trackOnboarding("onboarding_completed_synced");
      Alert.alert("Synced", "Your onboarding profile is now synced.");
    } catch (error: any) {
      setCompletionState("sync_failed");
      trackOnboarding("onboarding_sync_failed", {
        error_message: error?.message || "retry_failed",
      });
      Alert.alert("Sync failed", error?.message || "Please check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  function continueToApp() {
    if (completionState !== "complete_synced") {
      Alert.alert("Sync pending", "Please wait for profile sync to finish before continuing.");
      return;
    }
    router.replace("/(chat)" as any);
  }

  function toggleMultiOption(option: string) {
    if (
      shouldIgnoreOnboardingOptionPress({
        sending,
        done,
        completionState,
      })
    ) {
      trackOnboarding("onboarding_late_input_ignored", {
        workflow_step: activeSlotId,
        decision: "multi_toggle_ignored_after_completion",
      });
      return;
    }
    if (!activeSlot || activeSlot.type !== "multi") return;
    const maxChoices = activeSlot.max_choices || 4;
    setSelectedOptions((current) => {
      if (current.includes(option)) {
        return current.filter((item) => item !== option);
      }
      if (current.length >= maxChoices) {
        return current;
      }
      return [...current, option];
    });
  }

  async function handleSingleOptionPress(option: string) {
    if (
      shouldIgnoreOnboardingOptionPress({
        sending,
        done,
        completionState,
      })
    ) {
      trackOnboarding("onboarding_late_input_ignored", {
        workflow_step: activeSlotId,
        decision: "single_option_ignored_after_completion",
      });
      return;
    }
    await handleSend(humanizeOption(option));
  }

  async function handleMultiOptionSubmit() {
    if (
      shouldIgnoreOnboardingOptionPress({
        sending,
        done,
        completionState,
      })
    ) {
      trackOnboarding("onboarding_late_input_ignored", {
        workflow_step: activeSlotId,
        decision: "multi_submit_ignored_after_completion",
      });
      return;
    }
    if (!activeSlot || activeSlot.type !== "multi" || selectedOptions.length === 0) return;
    await handleSend(formatSelectedOptions(selectedOptions));
  }

  const showOptions = shouldShowOnboardingOptions({
    done,
    completionState,
    activeSlotId,
  });
  const profileReadyVisible = done || completionState !== "incomplete";
  const interactionsDisabled =
    sending || done || completionState !== "incomplete";

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.screen}>
      <StatusBar style="light" />
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
          <View style={styles.chatWrap}>
            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={Brand.bronze} />
                <Text style={styles.loadingText}>Getting things ready…</Text>
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

                {showOptions && activeSlot ? (
                  <GlassCard style={styles.optionsCard}>
                    <Text style={styles.optionsTitle}>{activeSlot.prompt}</Text>
                    <Text style={styles.optionsSubtitle}>
                      {activeSlot.type === "multi"
                        ? `Choose up to ${activeSlot.max_choices || 4} options.`
                        : "Tap one option to continue instantly."}
                    </Text>

                    <View style={styles.chipsWrap}>
                      {activeSlot.options.map((option) => {
                        const selected = selectedOptions.includes(option);
                        return (
                          <Pressable
                            key={`${activeSlot.id}_${option}`}
                            accessibilityLabel={`onboarding-option-${option}`}
                            style={[
                              styles.optionChip,
                              activeSlot.type === "multi" && selected && styles.optionChipSelected,
                            ]}
                            disabled={interactionsDisabled}
                            onPress={() => {
                              if (activeSlot.type === "multi") {
                                toggleMultiOption(option);
                                return;
                              }
                              void handleSingleOptionPress(option);
                            }}
                          >
                            <Text
                              style={[
                                styles.optionChipText,
                                activeSlot.type === "multi" && selected && styles.optionChipTextSelected,
                              ]}
                            >
                              {humanizeOption(option)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {activeSlot.type === "multi" ? (
                      <Pressable
                        accessibilityLabel="onboarding-multi-submit"
                        style={[
                          styles.multiSubmitButton,
                          (selectedOptions.length === 0 || interactionsDisabled) && styles.multiSubmitButtonDisabled,
                        ]}
                        disabled={selectedOptions.length === 0 || interactionsDisabled}
                        onPress={() => void handleMultiOptionSubmit()}
                      >
                        <Text style={styles.multiSubmitButtonText}>
                          {sending ? "Saving…" : `Continue with ${selectedOptions.length} selected`}
                        </Text>
                      </Pressable>
                    ) : null}
                  </GlassCard>
                ) : null}

                {profileReadyVisible ? (
                  <GlassCard style={styles.doneCard}>
                    <Text style={styles.doneTitle}>
                      {completionState === "complete_synced"
                        ? "Starter profile ready"
                        : completionState === "sync_failed"
                          ? "Sync needed"
                          : "Syncing profile"}
                    </Text>
                    <Text style={styles.doneText}>
                      {completionState === "complete_synced"
                        ? "You can improve this later in chat."
                        : completionState === "sync_failed"
                          ? "Your answers are saved locally, but backend sync failed. Retry sync before continuing."
                          : "Your answers are saved locally. Waiting for backend confirmation…"}
                    </Text>

                    {completionState === "sync_failed" ? (
                      <Pressable
                        accessibilityLabel="onboarding-retry-sync-button"
                        style={styles.doneButton}
                        onPress={() => void retrySync()}
                      >
                        <Text style={styles.doneButtonText}>{sending ? "Retrying…" : "Retry sync"}</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityLabel="onboarding-continue-button"
                        style={[
                          styles.doneButton,
                          completionState !== "complete_synced" && styles.doneButtonDisabled,
                        ]}
                        disabled={completionState !== "complete_synced"}
                        onPress={continueToApp}
                      >
                        <Text style={styles.doneButtonText}>
                          {completionState === "complete_synced" ? "Continue to app" : "Syncing…"}
                        </Text>
                      </Pressable>
                    )}
                  </GlassCard>
                ) : null}
              </ScrollView>
            )}
          </View>

          {!profileReadyVisible ? (
            <GlassCard style={styles.composerCard}>
              <Text style={styles.composerHint}>
                {sessionReplyLanguage === "ta"
                  ? "அல்லது உங்கள் சொற்களில் பதில் எழுதலாம்…"
                  : "Or answer in your own words…"}
              </Text>
              <View style={styles.composerRow}>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder={sessionReplyLanguage === "ta" ? "உங்களைப் பற்றி பதில் சொல்லுங்கள்…" : "Reply naturally…"}
                  placeholderTextColor={Brand.textMuted}
                  style={styles.input}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  style={[styles.sendButton, (!input.trim() || sending) && styles.sendButtonDisabled]}
                  disabled={!input.trim() || sending}
                  onPress={() => void handleSend()}
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
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
  optionsCard: {
    padding: 16,
    gap: 12,
  },
  optionsTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: Brand.text,
  },
  optionsSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: Brand.textMuted,
  },
  chipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  optionChip: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: "rgba(135,70,40,0.14)",
  },
  optionChipSelected: {
    backgroundColor: Brand.bronze,
    borderColor: Brand.bronze,
  },
  optionChipText: {
    fontSize: 14,
    fontWeight: "700",
    color: Brand.text,
  },
  optionChipTextSelected: {
    color: "#fff",
  },
  multiSubmitButton: {
    marginTop: 2,
    borderRadius: 14,
    backgroundColor: Brand.bronze,
    paddingHorizontal: 16,
    paddingVertical: 13,
    alignItems: "center",
  },
  multiSubmitButtonDisabled: {
    opacity: 0.5,
  },
  multiSubmitButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
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
  doneButtonDisabled: {
    opacity: 0.5,
  },
  doneButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },
  composerCard: {
    padding: 10,
    gap: 8,
  },
  composerHint: {
    fontSize: 12,
    color: Brand.textMuted,
    paddingHorizontal: 4,
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
