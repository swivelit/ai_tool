import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
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
  PersonalityAnswers,
  PersonalityQuestion,
  createProfileOnBackend,
  getPersonalityQuestions,
  getProfile,
  getProfileForFirebaseUid,
  markQuestionnaireCompleted,
  savePersonalityAnswers,
} from "@/lib/account";

type NoticeState = {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimaryPress?: () => void;
} | null;

export default function QuestionnaireScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { profile, userId, refresh, name: assistantLabel } = useAssistant();
  const { user } = useAuth();

  const [questions, setQuestions] = useState<PersonalityQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 8 : 12);
  const bottomPadding = Math.max(insets.bottom + 28, 36);
  const titleSize = isVerySmallPhone ? 28 : isSmallPhone ? 31 : 34;

  function showNotice(
    title: string,
    message: string,
    primaryLabel?: string,
    onPrimaryPress?: () => void
  ) {
    setNotice({
      title,
      message,
      primaryLabel,
      onPrimaryPress,
    });
  }

  function closeNotice() {
    setNotice(null);
  }

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoading(true);
        const nextQuestions = await getPersonalityQuestions();
        if (!alive) return;
        setQuestions(Array.isArray(nextQuestions) ? nextQuestions : []);
      } catch (error: any) {
        if (!alive) return;
        showNotice("Unable to load questions", error?.message || "Please try again.");
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      alive = false;
    };
  }, []);

  const answeredCount = useMemo(() => {
    return questions.reduce((count, question) => {
      const selected = answers[question.id] || [];
      return count + (selected.length > 0 ? 1 : 0);
    }, 0);
  }, [answers, questions]);

  const progress = questions.length ? answeredCount / questions.length : 0;

  async function resolveUserId() {
    if (userId) return userId;
    if (profile?.userId) return profile.userId;

    const localProfile = await getProfile();
    if (localProfile?.userId) return localProfile.userId;

    if (!user) return null;

    const localProfileForFirebaseUser = await getProfileForFirebaseUid(user.uid, user.email);
    if (localProfileForFirebaseUser?.userId) {
      return localProfileForFirebaseUser.userId;
    }

    const provider =
      user.providerData?.some((item) => item.providerId === "google.com")
        ? "google"
        : "password";

    const rebuiltProfile = await createProfileOnBackend({
      userId: profile?.userId || localProfile?.userId,
      firebaseUid: user.uid,
      firebaseEmailVerified: user.emailVerified,
      email: user.email || "",
      avatarUrl: user.photoURL || undefined,
      authProvider: provider,
      name: profile?.name || user.displayName || localProfile?.name || "User",
      place: profile?.place || localProfile?.place || "",
      assistantName:
        profile?.assistantName || localProfile?.assistantName || assistantLabel || "Elli",
      timezone: "Asia/Kolkata",
      questionnaireCompleted:
        profile?.questionnaireCompleted ?? localProfile?.questionnaireCompleted ?? false,
    });

    await refresh();
    return rebuiltProfile?.userId ?? null;
  }

  function toggleOption(question: PersonalityQuestion, option: string) {
    setAnswers((prev) => {
      const current = prev[question.id] || [];

      if (question.type === "single") {
        return {
          ...prev,
          [question.id]: [option],
        };
      }

      const exists = current.includes(option);

      if (exists) {
        return {
          ...prev,
          [question.id]: current.filter((item) => item !== option),
        };
      }

      const maxChoices = question.max_choices || current.length + 1;

      if (current.length >= maxChoices) {
        showNotice(
          "Selection limit reached",
          `You can choose up to ${maxChoices} options for this question.`
        );
        return prev;
      }

      return {
        ...prev,
        [question.id]: [...current, option],
      };
    });
  }

  function formatOptionLabel(value: string) {
    return value
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  async function submit() {
    if (saving) return;

    const missing = questions.filter((question) => !(answers[question.id] || []).length);
    if (missing.length > 0) {
      showNotice(
        "Answer all questions",
        `You still have ${missing.length} unanswered question${missing.length > 1 ? "s" : ""}.`
      );
      return;
    }

    try {
      setSaving(true);

      const resolvedUserId = await resolveUserId();

      if (!resolvedUserId) {
        showNotice(
          "Profile missing",
          "Your local user session could not be restored. Please go back and complete your profile once more.",
          "Go to profile",
          () => {
            closeNotice();
            router.replace("/onboarding/profile");
          }
        );
        return;
      }

      const payload: PersonalityAnswers = Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [key, value])
      );

      await savePersonalityAnswers(resolvedUserId, payload);
      await markQuestionnaireCompleted(true);
      await refresh();
      router.replace("/(tabs)/routine");
    } catch (error: any) {
      showNotice("Failed to save answers", error?.message || "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function reloadQuestions() {
    try {
      setLoading(true);
      const nextQuestions = await getPersonalityQuestions();
      setQuestions(Array.isArray(nextQuestions) ? nextQuestions : []);
    } catch (error: any) {
      showNotice("Unable to load questions", error?.message || "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <LinearGradient colors={Brand.gradients.page} style={styles.page}>
        <StatusBar style="dark" />
        <View style={styles.loaderPage}>
          <View style={styles.loaderCard}>
            <ActivityIndicator size="small" color={Brand.bronze} />
            <Text style={styles.loaderText}>Loading your questionnaire...</Text>
          </View>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroPill}>
          <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
          <Text style={styles.heroPillText}>Personality profile</Text>
        </View>

        <Text
          style={[
            styles.title,
            {
              fontSize: titleSize,
              lineHeight: titleSize + 6,
            },
          ]}
        >
          Help {assistantLabel || "Elli"} understand your style
        </Text>

        <Text style={styles.subtitle}>
          Answer these {questions.length} questions so replies can feel more natural, relevant, and
          personal to you.
        </Text>

        <GlassCard style={{ borderRadius: 28, marginTop: 18 }}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressLabel}>Progress</Text>
            <Text style={styles.progressValue}>
              {answeredCount}/{questions.length} answered
            </Text>
          </View>

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(progress * 100, 4)}%` }]} />
          </View>

          <Text style={styles.progressHelper}>
            Finish all questions to unlock the fully personalized assistant experience.
          </Text>
        </GlassCard>

        {!questions.length ? (
          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="help-circle-outline" size={24} color={Brand.bronze} />
            </View>
            <Text style={styles.emptyTitle}>No questions available</Text>
            <Text style={styles.emptyText}>
              The questionnaire loaded, but no questions were returned from the API.
            </Text>

            <Pressable onPress={reloadQuestions} style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
          </GlassCard>
        ) : (
          questions.map((question, index) => {
            const selected = answers[question.id] || [];
            const helperText =
              question.type === "multi"
                ? `Choose up to ${question.max_choices || 1}`
                : "Choose 1 option";

            return (
              <GlassCard key={question.id} style={{ borderRadius: 28, marginTop: 16 }}>
                <View style={styles.questionHeaderRow}>
                  <Text style={styles.questionIndex}>Question {index + 1}</Text>
                  <View style={styles.questionTypeChip}>
                    <Text style={styles.questionTypeChipText}>
                      {question.type === "multi" ? "Multiple choice" : "Single choice"}
                    </Text>
                  </View>
                </View>

                <Text style={styles.questionText}>{question.prompt}</Text>
                <Text style={styles.helper}>{helperText}</Text>

                <View style={{ marginTop: 14 }}>
                  {question.options.map((option) => {
                    const active = selected.includes(option);

                    return (
                      <Pressable
                        key={option}
                        onPress={() => toggleOption(question, option)}
                        style={({ pressed }) => [
                          styles.optionBtn,
                          active && styles.optionBtnActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={[styles.optionIconWrap, active && styles.optionIconWrapActive]}>
                          <Ionicons
                            name={
                              question.type === "multi"
                                ? active
                                  ? "checkbox"
                                  : "square-outline"
                                : active
                                  ? "radio-button-on"
                                  : "radio-button-off"
                            }
                            size={18}
                            color={active ? Brand.ink : Brand.cocoa}
                          />
                        </View>

                        <Text style={[styles.optionText, active && styles.optionTextActive]}>
                          {formatOptionLabel(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </GlassCard>
            );
          })
        )}

        {!!questions.length && (
          <Pressable
            onPress={submit}
            style={({ pressed }) => [
              styles.submitShell,
              saving && styles.disabled,
              pressed && styles.pressed,
            ]}
            disabled={saving}
          >
            <LinearGradient
              colors={Brand.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[styles.submitBtn, { minHeight: isSmallPhone ? 54 : 58 }]}
            >
              {saving ? (
                <ActivityIndicator color={Brand.ink} />
              ) : (
                <>
                  <Text style={styles.submitBtnText}>Save answers and continue</Text>
                  <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                </>
              )}
            </LinearGradient>
          </Pressable>
        )}
      </ScrollView>

      <Modal transparent visible={!!notice} animationType="fade" onRequestClose={closeNotice}>
        <View style={styles.noticeOverlay}>
          <GlassCard style={{ borderRadius: 28 }}>
            <View style={styles.noticeIconWrap}>
              <Ionicons name="information-circle" size={22} color={Brand.bronze} />
            </View>

            <Text style={styles.noticeTitle}>{notice?.title}</Text>
            <Text style={styles.noticeMessage}>{notice?.message}</Text>

            <View style={styles.noticeActions}>
              <Pressable onPress={closeNotice} style={styles.noticeSecondaryBtn}>
                <Text style={styles.noticeSecondaryText}>Close</Text>
              </Pressable>

              {notice?.primaryLabel ? (
                <Pressable
                  onPress={notice.onPrimaryPress || closeNotice}
                  style={styles.noticePrimaryBtn}
                >
                  <Text style={styles.noticePrimaryText}>{notice.primaryLabel}</Text>
                </Pressable>
              ) : null}
            </View>
          </GlassCard>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  loaderPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  loaderCard: {
    minHeight: 120,
    minWidth: 220,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  loaderText: {
    color: Brand.muted,
    fontSize: 14,
    fontWeight: "700",
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

  heroPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 16,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  progressLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  progressValue: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
  },

  progressTrack: {
    marginTop: 12,
    height: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#efbf7c",
  },

  progressHelper: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: "rgba(255,229,180,0.60)",
  },

  emptyTitle: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
  },

  emptyText: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
  },

  retryBtn: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  retryBtnText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  questionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  questionIndex: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  questionTypeChip: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  questionTypeChipText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
  },

  questionText: {
    marginTop: 12,
    color: Brand.ink,
    fontSize: 19,
    lineHeight: 27,
    fontWeight: "800",
  },

  helper: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 13,
  },

  optionBtn: {
    minHeight: 54,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.60)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  optionBtnActive: {
    backgroundColor: "rgba(255,229,180,0.84)",
    borderColor: "rgba(185,120,54,0.22)",
  },

  optionIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  optionIconWrapActive: {
    backgroundColor: "rgba(255,255,255,0.82)",
  },

  optionText: {
    flex: 1,
    marginLeft: 10,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
  },

  optionTextActive: {
    color: Brand.ink,
  },

  submitShell: {
    borderRadius: 18,
    overflow: "hidden",
    marginTop: 20,
  },

  submitBtn: {
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
  },

  submitBtnText: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 15,
  },

  disabled: {
    opacity: 0.72,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },

  noticeOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
    backgroundColor: "rgba(72, 46, 18, 0.18)",
  },

  noticeIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  noticeTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 22,
    fontWeight: "900",
  },

  noticeMessage: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  noticeActions: {
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },

  noticeSecondaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  noticeSecondaryText: {
    color: Brand.cocoa,
    fontWeight: "800",
    fontSize: 14,
  },

  noticePrimaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#efbf7c",
  },

  noticePrimaryText: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 14,
  },
});