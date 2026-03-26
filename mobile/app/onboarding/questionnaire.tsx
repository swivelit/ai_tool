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

function getMaxAccessibleQuestionIndex(
  questions: PersonalityQuestion[],
  answers: Record<string, string[]>
) {
  if (!questions.length) return 0;

  const firstUnansweredIndex = questions.findIndex(
    (question) => !(answers[question.id] || []).length
  );

  if (firstUnansweredIndex === -1) {
    return Math.max(questions.length - 1, 0);
  }

  return firstUnansweredIndex;
}

function formatOptionLabel(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function questionHelper(question: PersonalityQuestion) {
  if (question.type === "multi") {
    return `Choose up to ${question.max_choices || 1} options, then continue`;
  }

  return "Choose one option to continue";
}

export default function QuestionnaireScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { profile, userId, refresh, name: assistantLabel } = useAssistant();
  const { user } = useAuth();

  const [questions, setQuestions] = useState<PersonalityQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 8 : 12);
  const bottomPadding = Math.max(insets.bottom + 28, 36);
  const titleSize = isVerySmallPhone ? 28 : isSmallPhone ? 31 : 36;

  function showNotice(
    title: string,
    message: string,
    primaryLabel?: string,
    onPrimaryPress?: () => void
  ) {
    setNotice({ title, message, primaryLabel, onPrimaryPress });
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
        setCurrentQuestionIndex(0);
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

  const totalSelected = useMemo(() => {
    return Object.values(answers).reduce((sum, current) => sum + current.length, 0);
  }, [answers]);

  const progress = questions.length ? answeredCount / questions.length : 0;

  const maxAccessibleIndex = useMemo(() => {
    return getMaxAccessibleQuestionIndex(questions, answers);
  }, [answers, questions]);

  useEffect(() => {
    setCurrentQuestionIndex((prev) => Math.min(prev, maxAccessibleIndex));
  }, [maxAccessibleIndex]);

  const currentQuestion = questions[currentQuestionIndex] || null;
  const selectedOptions = currentQuestion ? answers[currentQuestion.id] || [] : [];
  const currentAnswered = selectedOptions.length > 0;
  const canGoBack = currentQuestionIndex > 0;
  const isLastQuestion = questions.length > 0 && currentQuestionIndex === questions.length - 1;

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

  function toggleOption(question: PersonalityQuestion, option: string, questionIndex: number) {
    let nextAnswersSnapshot: Record<string, string[]> = answers;
    let shouldAutoAdvance = false;

    setAnswers((prev) => {
      const current = prev[question.id] || [];

      if (question.type === "single") {
        nextAnswersSnapshot = {
          ...prev,
          [question.id]: [option],
        };
        shouldAutoAdvance = true;
        return nextAnswersSnapshot;
      }

      const exists = current.includes(option);

      if (exists) {
        nextAnswersSnapshot = {
          ...prev,
          [question.id]: current.filter((item) => item !== option),
        };
        return nextAnswersSnapshot;
      }

      const maxChoices = question.max_choices || current.length + 1;

      if (current.length >= maxChoices) {
        showNotice(
          "Selection limit reached",
          `You can choose up to ${maxChoices} options for this question.`
        );
        nextAnswersSnapshot = prev;
        return prev;
      }

      nextAnswersSnapshot = {
        ...prev,
        [question.id]: [...current, option],
      };
      return nextAnswersSnapshot;
    });

    if (shouldAutoAdvance && questionIndex < questions.length - 1) {
      const nextAccessible = getMaxAccessibleQuestionIndex(questions, nextAnswersSnapshot);
      const nextIndex = Math.min(questionIndex + 1, nextAccessible);

      setTimeout(() => {
        setCurrentQuestionIndex((prev) => {
          if (prev !== questionIndex) return prev;
          return nextIndex;
        });
      }, 140);
    }
  }

  async function submit() {
    if (saving) return;

    const missing = questions.filter((question) => !(answers[question.id] || []).length);
    if (missing.length > 0) {
      showNotice(
        "Answer all questions",
        `You still have ${missing.length} unanswered question${missing.length > 1 ? "s" : ""}.`
      );
      setCurrentQuestionIndex(getMaxAccessibleQuestionIndex(questions, answers));
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
      setAnswers({});
      setCurrentQuestionIndex(0);
    } catch (error: any) {
      showNotice("Unable to load questions", error?.message || "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function goBack() {
    setCurrentQuestionIndex((prev) => Math.max(prev - 1, 0));
  }

  function goForward() {
    if (!currentQuestion) return;

    if (!currentAnswered) {
      showNotice(
        "Answer this question first",
        "Complete the current question to unlock the next one."
      );
      return;
    }

    if (isLastQuestion) {
      void submit();
      return;
    }

    setCurrentQuestionIndex((prev) => Math.min(prev + 1, maxAccessibleIndex));
  }

  const footerMessage = useMemo(() => {
    if (!currentQuestion) return "";

    if (isLastQuestion) {
      return currentAnswered
        ? "Last question complete. Save your answers and continue."
        : "Answer the final question to finish setup.";
    }

    if (currentQuestion.type === "multi") {
      return currentAnswered
        ? "Your selections are saved. Continue when you are ready."
        : "Choose one or more options, then continue to the next question.";
    }

    return currentAnswered
      ? "Answer saved. The next question is unlocked."
      : "Select one option to unlock the next question.";
  }, [currentAnswered, currentQuestion, isLastQuestion]);

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

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
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
        <View style={styles.topBar}>
          <View style={styles.topBarPill}>
            <Ionicons name="layers-outline" size={14} color={Brand.bronze} />
            <Text style={styles.topBarPillText}>Onboarding</Text>
          </View>

          <View style={styles.topBarStepChip}>
            <Text style={styles.topBarStepText}>Step 2 of 2</Text>
          </View>
        </View>

        <GlassCard style={styles.heroCard}>
          <View style={styles.heroHeaderRow}>
            <View style={styles.heroPill}>
              <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
              <Text style={styles.heroPillText}>Personality profile</Text>
            </View>

            <View style={styles.heroStatusChip}>
              <Ionicons
                name={answeredCount === questions.length ? "checkmark-circle" : "flash-outline"}
                size={14}
                color={answeredCount === questions.length ? Brand.success : Brand.bronze}
              />
              <Text style={styles.heroStatusText}>
                {answeredCount === questions.length ? "Ready" : "In progress"}
              </Text>
            </View>
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
            Help {assistantLabel || "Elli"} understand how you think and work.
          </Text>

          <Text style={styles.subtitle}>
            Questions now appear one by one. You can go back anytime, but upcoming questions stay
            locked until the current one is answered.
          </Text>

          <View style={styles.metricRow}>
            <MetricCard
              label="Answered"
              value={`${answeredCount}/${questions.length}`}
              icon="checkmark-done-outline"
            />
            <MetricCard label="Selections" value={String(totalSelected)} icon="albums-outline" />
            <MetricCard
              label="Completion"
              value={`${Math.round(progress * 100)}%`}
              icon="flash-outline"
            />
          </View>

          <LinearGradient
            colors={["rgba(255,255,255,0.84)", "rgba(255,239,210,0.66)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.progressCard}
          >
            <View style={styles.progressHeader}>
              <View>
                <Text style={styles.progressLabel}>Progress</Text>
                <Text style={styles.progressValue}>
                  Question {Math.min(currentQuestionIndex + 1, Math.max(questions.length, 1))} of{" "}
                  {questions.length}
                </Text>
              </View>

              <View style={styles.progressBadge}>
                <Text style={styles.progressBadgeText}>{Math.round(progress * 100)}%</Text>
              </View>
            </View>

            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(progress * 100, questions.length ? 4 : 0)}%` },
                ]}
              />
            </View>

            <Text style={styles.progressHelper}>
              Answer one question at a time. Use Back to review earlier answers.
            </Text>
          </LinearGradient>
        </GlassCard>

        {!questions.length ? (
          <GlassCard style={styles.emptyCard}>
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
        ) : currentQuestion ? (
          <>
            <GlassCard style={styles.questionCard}>
              <View style={styles.questionHeaderRow}>
                <View style={styles.questionHeaderTextWrap}>
                  <Text style={styles.questionIndex}>Question {currentQuestionIndex + 1}</Text>
                  <Text style={styles.questionText}>{currentQuestion.prompt}</Text>
                </View>

                <View
                  style={[
                    styles.questionStateChip,
                    currentAnswered && styles.questionStateChipDone,
                  ]}
                >
                  <Ionicons
                    name={currentAnswered ? "checkmark-circle" : "ellipse-outline"}
                    size={14}
                    color={currentAnswered ? Brand.success : Brand.cocoa}
                  />
                </View>
              </View>

              <View style={styles.questionMetaRow}>
                <View style={styles.questionTypeChip}>
                  <Text style={styles.questionTypeChipText}>
                    {currentQuestion.type === "multi" ? "Multiple choice" : "Single choice"}
                  </Text>
                </View>

                <Text style={styles.helper}>{questionHelper(currentQuestion)}</Text>
              </View>

              <View style={styles.optionList}>
                {currentQuestion.options.map((option) => {
                  const active = selectedOptions.includes(option);

                  return (
                    <Pressable
                      key={option}
                      onPress={() => toggleOption(currentQuestion, option, currentQuestionIndex)}
                      style={({ pressed }) => [
                        styles.optionBtn,
                        active && styles.optionBtnActive,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={[styles.optionIconWrap, active && styles.optionIconWrapActive]}>
                        <Ionicons
                          name={
                            currentQuestion.type === "multi"
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

                      <View style={styles.optionTextWrap}>
                        <Text style={[styles.optionText, active && styles.optionTextActive]}>
                          {formatOptionLabel(option)}
                        </Text>
                        <Text style={styles.optionSubtext}>
                          {active
                            ? "Selected"
                            : currentQuestion.type === "multi"
                            ? "Tap to add or remove"
                            : "Tap to choose"}
                        </Text>
                      </View>

                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={active ? Brand.ink : "rgba(124, 99, 80, 0.56)"}
                      />
                    </Pressable>
                  );
                })}
              </View>
            </GlassCard>

            <View style={styles.footerArea}>
              <GlassCard style={styles.footerCard}>
                <View style={styles.footerSummaryRow}>
                  <View style={styles.footerSummaryTextWrap}>
                    <Text style={styles.footerSummaryTitle}>
                      {isLastQuestion ? "Finish setup" : "Continue to the next question"}
                    </Text>
                    <Text style={styles.footerSummaryText}>{footerMessage}</Text>
                  </View>

                  <View style={styles.footerSummaryBadge}>
                    <Text style={styles.footerSummaryBadgeText}>
                      {currentQuestionIndex + 1}/{questions.length}
                    </Text>
                  </View>
                </View>

                <View style={styles.footerButtonsRow}>
                  <Pressable
                    onPress={goBack}
                    disabled={!canGoBack}
                    style={({ pressed }) => [
                      styles.backBtn,
                      !canGoBack && styles.backBtnDisabled,
                      pressed && canGoBack && styles.pressed,
                    ]}
                  >
                    <Ionicons
                      name="arrow-back"
                      size={16}
                      color={canGoBack ? Brand.cocoa : "rgba(124, 99, 80, 0.38)"}
                    />
                    <Text
                      style={[
                        styles.backBtnText,
                        !canGoBack && styles.backBtnTextDisabled,
                      ]}
                    >
                      Back
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={goForward}
                    disabled={saving || !currentAnswered}
                    style={({ pressed }) => [
                      styles.submitShell,
                      (saving || !currentAnswered) && styles.disabled,
                      pressed && currentAnswered && styles.pressed,
                    ]}
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
                          <Text style={styles.submitBtnText}>
                            {isLastQuestion ? "Save answers and continue" : "Continue"}
                          </Text>
                          <Ionicons
                            name={isLastQuestion ? "checkmark" : "arrow-forward"}
                            size={18}
                            color={Brand.ink}
                          />
                        </>
                      )}
                    </LinearGradient>
                  </Pressable>
                </View>
              </GlassCard>
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal transparent visible={!!notice} animationType="fade" onRequestClose={closeNotice}>
        <View style={styles.noticeOverlay}>
          <GlassCard style={styles.noticeCard}>
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

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
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
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  loaderText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: 220,
    backgroundColor: "rgba(255, 219, 166, 0.34)",
  },

  leftGlow: {
    position: "absolute",
    left: -90,
    top: "30%",
    width: 180,
    height: 180,
    borderRadius: 180,
    backgroundColor: "rgba(255, 232, 194, 0.28)",
  },

  bottomGlow: {
    position: "absolute",
    right: -70,
    bottom: -40,
    width: 220,
    height: 220,
    borderRadius: 220,
    backgroundColor: "rgba(239, 191, 124, 0.18)",
  },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  topBarPill: {
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

  topBarPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  topBarStepChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topBarStepText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroCard: {
    borderRadius: 32,
    marginTop: 14,
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroPill: {
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

  heroStatusChip: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricRow: {
    marginTop: 20,
    flexDirection: "row",
    gap: 10,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  metricValue: {
    marginTop: 12,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  metricLabel: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  progressCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
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
    marginTop: 4,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  progressBadge: {
    minWidth: 58,
    minHeight: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  progressBadgeText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "900",
  },

  progressTrack: {
    marginTop: 14,
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

  emptyCard: {
    borderRadius: 28,
    marginTop: 16,
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

  questionCard: {
    borderRadius: 28,
    marginTop: 16,
  },

  questionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  questionHeaderTextWrap: {
    flex: 1,
    paddingRight: 4,
  },

  questionIndex: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  questionText: {
    marginTop: 10,
    color: Brand.ink,
    fontSize: 19,
    lineHeight: 27,
    fontWeight: "800",
  },

  questionStateChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  questionStateChipDone: {
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  questionMetaRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
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

  helper: {
    color: Brand.muted,
    fontSize: 13,
    fontWeight: "700",
  },

  optionList: {
    marginTop: 14,
  },

  optionBtn: {
    minHeight: 60,
    borderRadius: 20,
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
    width: 36,
    height: 36,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  optionIconWrapActive: {
    backgroundColor: "rgba(255,255,255,0.82)",
  },

  optionTextWrap: {
    flex: 1,
    marginLeft: 12,
  },

  optionText: {
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },

  optionTextActive: {
    color: Brand.ink,
  },

  optionSubtext: {
    marginTop: 3,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  footerArea: {
    marginTop: 18,
  },

  footerCard: {
    borderRadius: 24,
  },

  footerSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  footerSummaryTextWrap: {
    flex: 1,
  },

  footerSummaryTitle: {
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  footerSummaryText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  footerSummaryBadge: {
    minWidth: 56,
    minHeight: 40,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.70)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.18)",
  },

  footerSummaryBadgeText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  footerButtonsRow: {
    marginTop: 16,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },

  backBtn: {
    minHeight: 56,
    minWidth: 112,
    paddingHorizontal: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  backBtnDisabled: {
    opacity: 0.55,
  },

  backBtnText: {
    color: Brand.cocoa,
    fontWeight: "900",
    fontSize: 14,
  },

  backBtnTextDisabled: {
    color: "rgba(124, 99, 80, 0.44)",
  },

  submitShell: {
    flex: 1,
    borderRadius: 18,
    overflow: "hidden",
  },

  submitBtn: {
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    shadowColor: "#d4934f",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
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

  noticeCard: {
    borderRadius: 28,
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