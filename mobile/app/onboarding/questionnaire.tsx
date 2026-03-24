import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  PanResponder,
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
    return `Choose up to ${question.max_choices || 1}`;
  }

  return "Choose one";
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

  const trackX = useRef(new Animated.Value(0)).current;

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 8 : 12);
  const bottomPadding = Math.max(insets.bottom + 28, 36);
  const titleSize = isVerySmallPhone ? 28 : isSmallPhone ? 31 : 36;
  const carouselWidth = Math.max(width - horizontalPadding * 2, 1);

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

  const progress = questions.length ? answeredCount / questions.length : 0;

  const maxAccessibleIndex = useMemo(() => {
    return getMaxAccessibleQuestionIndex(questions, answers);
  }, [answers, questions]);

  useEffect(() => {
    setCurrentQuestionIndex((prev) => Math.min(prev, maxAccessibleIndex));
  }, [maxAccessibleIndex]);

  useEffect(() => {
    const toValue = -currentQuestionIndex * carouselWidth;

    Animated.timing(trackX, {
      toValue,
      duration: 360,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [carouselWidth, currentQuestionIndex, trackX]);

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

  function goToQuestion(nextIndex: number) {
    setCurrentQuestionIndex(Math.max(0, Math.min(nextIndex, maxAccessibleIndex)));
  }

  function bounceToCurrentQuestion() {
    Animated.spring(trackX, {
      toValue: -currentQuestionIndex * carouselWidth,
      tension: 82,
      friction: 11,
      useNativeDriver: true,
    }).start();
  }

  function goToPreviousQuestion() {
    if (!canGoBack) {
      bounceToCurrentQuestion();
      return;
    }

    setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
  }

  const swipeBackResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => {
          if (!canGoBack || saving) return false;

          const horizontalIntent =
            gestureState.dx > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
          return horizontalIntent;
        },
        onPanResponderMove: (_, gestureState) => {
          if (!canGoBack || saving) return;

          const dragX = Math.max(0, gestureState.dx);
          const easedDragX = Math.min(carouselWidth, dragX * 0.96);
          trackX.setValue(-currentQuestionIndex * carouselWidth + easedDragX);
        },
        onPanResponderRelease: (_, gestureState) => {
          if (!canGoBack || saving) {
            bounceToCurrentQuestion();
            return;
          }

          const shouldGoBack =
            gestureState.dx > carouselWidth * 0.22 || gestureState.vx > 0.55;

          if (shouldGoBack) {
            goToPreviousQuestion();
            return;
          }

          bounceToCurrentQuestion();
        },
        onPanResponderTerminate: () => {
          bounceToCurrentQuestion();
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [canGoBack, carouselWidth, currentQuestionIndex, saving, trackX]
  );

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
        shouldAutoAdvance = questionIndex < questions.length - 1;
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

    if (shouldAutoAdvance) {
      const nextAccessible = getMaxAccessibleQuestionIndex(questions, nextAnswersSnapshot);
      const nextIndex = Math.min(questionIndex + 1, nextAccessible);

      setTimeout(() => {
        setCurrentQuestionIndex((prev) => {
          if (prev !== questionIndex) return prev;
          return nextIndex;
        });
      }, 170);
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

    goToQuestion(currentQuestionIndex + 1);
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
        </View>

        <GlassCard style={styles.heroCard}>
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
            Help {assistantLabel || "Elli"} understand how you think and work.
          </Text>

          <Text style={styles.subtitle}>
            One question at a time. Clean, focused, and easy to move through.
          </Text>

          <View style={styles.progressHeader}>
            <Text style={styles.progressCaption}>
              Question {Math.min(currentQuestionIndex + 1, questions.length || 1)} of{" "}
              {questions.length}
            </Text>
            <Text style={styles.progressCaption}>
              {answeredCount}/{questions.length} answered
            </Text>
          </View>

          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.max(progress * 100, questions.length ? 6 : 0)}%` },
              ]}
            />
          </View>
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

            <Pressable
              onPress={reloadQuestions}
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
          </GlassCard>
        ) : currentQuestion ? (
          <>
            <View style={styles.carouselShell} {...swipeBackResponder.panHandlers}>
              <Animated.View
                style={[
                  styles.carouselTrack,
                  {
                    width: carouselWidth * questions.length,
                    transform: [{ translateX: trackX }],
                  },
                ]}
              >
                {questions.map((question, questionIndex) => {
                  const answerForQuestion = answers[question.id] || [];
                  const answered = answerForQuestion.length > 0;

                  return (
                    <View
                      key={question.id}
                      style={[
                        styles.slide,
                        {
                          width: carouselWidth,
                        },
                      ]}
                    >
                      <GlassCard style={styles.questionCard}>
                        <View style={styles.questionTopRow}>
                          <View style={styles.questionMetaPill}>
                            <Text style={styles.questionMetaPillText}>
                              {questionHelper(question)}
                            </Text>
                          </View>

                          <View style={styles.questionTopRight}>
                            <View style={styles.questionIndexPill}>
                              <Text style={styles.questionIndexPillText}>
                                {questionIndex + 1}/{questions.length}
                              </Text>
                            </View>

                            {answered ? (
                              <View style={styles.questionDoneChip}>
                                <Ionicons name="checkmark" size={13} color={Brand.success} />
                              </View>
                            ) : null}
                          </View>
                        </View>

                        <Text style={styles.questionText}>{question.prompt}</Text>

                        <View style={styles.optionList}>
                          {question.options.map((option) => {
                            const active = answerForQuestion.includes(option);

                            return (
                              <Pressable
                                key={option}
                                onPress={() => toggleOption(question, option, questionIndex)}
                                style={({ pressed }) => [
                                  styles.optionBtn,
                                  active && styles.optionBtnActive,
                                  pressed && styles.pressed,
                                ]}
                              >
                                <View
                                  style={[
                                    styles.optionIconWrap,
                                    active && styles.optionIconWrapActive,
                                  ]}
                                >
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

                                <Text
                                  style={[styles.optionText, active && styles.optionTextActive]}
                                >
                                  {formatOptionLabel(option)}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </GlassCard>
                    </View>
                  );
                })}
              </Animated.View>
            </View>

            {currentQuestion.type === "multi" || isLastQuestion ? (
              <View style={styles.footerActionWrap}>
                <Pressable
                  onPress={goForward}
                  disabled={saving || !currentAnswered}
                  style={({ pressed }) => [
                    styles.primaryBtnShell,
                    (saving || !currentAnswered) && styles.disabled,
                    pressed && currentAnswered && styles.pressed,
                  ]}
                >
                  <LinearGradient
                    colors={Brand.gradients.button}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.primaryBtn, { minHeight: isSmallPhone ? 54 : 58 }]}
                  >
                    {saving ? (
                      <ActivityIndicator color={Brand.ink} />
                    ) : (
                      <>
                        <Text style={styles.primaryBtnText}>
                          {isLastQuestion ? "Finish" : "Continue"}
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
            ) : null}
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
    justifyContent: "flex-start",
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

  heroCard: {
    borderRadius: 32,
    marginTop: 14,
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

  progressHeader: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  progressCaption: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  progressTrack: {
    marginTop: 10,
    height: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.66)",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#efbf7c",
  },

  emptyCard: {
    borderRadius: 28,
    marginTop: 18,
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

  carouselShell: {
    marginTop: 18,
    overflow: "hidden",
  },

  carouselTrack: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  slide: {
    flexShrink: 0,
  },

  questionCard: {
    borderRadius: 30,
  },

  questionTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  questionTopRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  questionMetaPill: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  questionMetaPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  questionIndexPill: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  questionIndexPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  questionDoneChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  questionText: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 22,
    lineHeight: 30,
    fontWeight: "800",
  },

  optionList: {
    marginTop: 18,
  },

  optionBtn: {
    minHeight: 60,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
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
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
  },

  optionIconWrapActive: {
    backgroundColor: "rgba(255,255,255,0.84)",
  },

  optionText: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "800",
  },

  optionTextActive: {
    color: Brand.ink,
  },

  footerActionWrap: {
    marginTop: 16,
  },

  primaryBtnShell: {
    borderRadius: 18,
    overflow: "hidden",
  },

  primaryBtn: {
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

  primaryBtnText: {
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