import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
      assistantName: profile?.assistantName || localProfile?.assistantName || assistantLabel || "Elli",
      timezone: "Asia/Kolkata",
      questionnaireCompleted: profile?.questionnaireCompleted ?? localProfile?.questionnaireCompleted ?? false,
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
      <LinearGradient
        colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
        start={{ x: 0.08, y: 0.02 }}
        end={{ x: 0.88, y: 1 }}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingHorizontal: 18,
          }}
        >
          <ActivityIndicator size="large" color="white" />
          <Text style={{ marginTop: 14, color: "rgba(255,255,255,0.74)" }}>
            Loading your questionnaire...
          </Text>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: horizontalPadding,
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={headerRow}>
            <View style={{ flex: 1, paddingRight: 14 }}>
              <Text
                style={[
                  title,
                  {
                    fontSize: isVerySmallPhone ? 26 : isSmallPhone ? 28 : 30,
                    lineHeight: isVerySmallPhone ? 32 : isSmallPhone ? 34 : 36,
                  },
                ]}
              >
                Complete your personality profile
              </Text>
              <Text
                style={[
                  subtitle,
                  {
                    fontSize: isSmallPhone ? 13 : 14,
                    lineHeight: isSmallPhone ? 20 : 21,
                  },
                ]}
              >
                Answer these {questions.length} questions so {assistantLabel || "Elli"} can
                respond in a way that fits you better.
              </Text>
            </View>

            <View style={headerBadge}>
              <Ionicons name="sparkles-outline" size={16} color="rgba(173,232,255,0.95)" />
            </View>
          </View>

          <View style={[progressWrap, { marginTop: isSmallPhone ? 14 : 18 }]}>
            <Text style={progressText}>
              {answeredCount}/{questions.length} answered
            </Text>
          </View>

          {!questions.length ? (
            <View style={emptyCard}>
              <Text style={emptyTitle}>No questions available</Text>
              <Text style={emptyText}>
                The questionnaire loaded, but no questions were returned from the API.
              </Text>

              <Pressable onPress={reloadQuestions} style={submitBtn}>
                <Text style={submitBtnText}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            questions.map((question, index) => {
              const selected = answers[question.id] || [];
              const helperText =
                question.type === "multi"
                  ? `Choose up to ${question.max_choices || 1}`
                  : "Choose 1 option";

              return (
                <View key={question.id} style={[card, { marginTop: isSmallPhone ? 12 : 14 }]}>
                  <Text style={questionIndex}>Question {index + 1}</Text>
                  <Text
                    style={[
                      questionText,
                      {
                        fontSize: isSmallPhone ? 17 : 19,
                        lineHeight: isSmallPhone ? 24 : 27,
                      },
                    ]}
                  >
                    {question.prompt}
                  </Text>
                  <Text style={helper}>{helperText}</Text>

                  <View style={{ marginTop: 14 }}>
                    {question.options.map((option) => {
                      const active = selected.includes(option);

                      return (
                        <Pressable
                          key={option}
                          onPress={() => toggleOption(question, option)}
                          style={[
                            optionBtn,
                            { minHeight: isSmallPhone ? 50 : 52 },
                            active && optionBtnActive,
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
                            color={active ? "#041222" : "rgba(255,255,255,0.92)"}
                          />
                          <Text
                            style={[
                              optionText,
                              { fontSize: isSmallPhone ? 13 : 14, lineHeight: isSmallPhone ? 19 : 20 },
                              active && optionTextActive,
                            ]}
                          >
                            {formatOptionLabel(option)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })
          )}

          {!!questions.length && (
            <Pressable
              onPress={submit}
              style={[
                submitBtn,
                { marginTop: isSmallPhone ? 18 : 20, minHeight: isSmallPhone ? 54 : 58 },
                saving && { opacity: 0.72 },
              ]}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#041222" />
              ) : (
                <Text style={[submitBtnText, { fontSize: isSmallPhone ? 15 : 17 }]}>
                  Save answers and continue
                </Text>
              )}
            </Pressable>
          )}
        </ScrollView>

        {notice ? (
          <View
            style={[
              noticeOverlay,
              {
                paddingTop: insets.top + 20,
                paddingBottom: Math.max(insets.bottom + 20, 20),
              },
            ]}
          >
            <View style={noticeCard}>
              <View style={noticeIconWrap}>
                <Ionicons name="information-circle" size={22} color="rgba(173,232,255,0.98)" />
              </View>

              <Text style={noticeTitle}>{notice.title}</Text>
              <Text style={noticeMessage}>{notice.message}</Text>

              <View style={noticeActions}>
                <Pressable onPress={closeNotice} style={noticeSecondaryBtn}>
                  <Text style={noticeSecondaryText}>Close</Text>
                </Pressable>

                {notice.primaryLabel ? (
                  <Pressable
                    onPress={notice.onPrimaryPress || closeNotice}
                    style={noticePrimaryBtn}
                  >
                    <Text style={noticePrimaryText}>{notice.primaryLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </LinearGradient>
  );
}

const headerRow = {
  flexDirection: "row" as const,
  alignItems: "flex-start" as const,
  justifyContent: "space-between" as const,
};

const title = {
  color: "white",
  fontWeight: "900" as const,
};

const subtitle = {
  marginTop: 8,
  color: "rgba(255,255,255,0.68)",
};

const headerBadge = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const progressWrap = {
  marginBottom: 6,
};

const progressText = {
  color: "rgba(173,232,255,0.95)",
  fontSize: 13,
  fontWeight: "800" as const,
};

const card = {
  borderRadius: 24,
  paddingHorizontal: 16,
  paddingVertical: 18,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const questionIndex = {
  color: "rgba(173,232,255,0.95)",
  fontSize: 12,
  fontWeight: "900" as const,
  letterSpacing: 0.4,
  textTransform: "uppercase" as const,
};

const questionText = {
  marginTop: 10,
  color: "white",
  fontWeight: "800" as const,
};

const helper = {
  marginTop: 8,
  color: "rgba(255,255,255,0.62)",
  fontSize: 13,
};

const optionBtn = {
  borderRadius: 18,
  paddingHorizontal: 14,
  paddingVertical: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  marginBottom: 10,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const optionBtnActive = {
  backgroundColor: "rgba(98,193,255,0.96)",
  borderColor: "rgba(255,255,255,0.18)",
};

const optionText = {
  flex: 1,
  marginLeft: 10,
  color: "rgba(255,255,255,0.92)",
  fontWeight: "700" as const,
};

const optionTextActive = {
  color: "#041222",
};

const submitBtn = {
  borderRadius: 20,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.16)",
};

const submitBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
};

const emptyCard = {
  marginTop: 14,
  borderRadius: 24,
  paddingHorizontal: 18,
  paddingVertical: 20,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const emptyTitle = {
  color: "white",
  fontSize: 22,
  fontWeight: "900" as const,
};

const emptyText = {
  marginTop: 10,
  color: "rgba(255,255,255,0.70)",
  fontSize: 14,
  lineHeight: 21,
};

const noticeOverlay = {
  position: "absolute" as const,
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  paddingHorizontal: 20,
  justifyContent: "center" as const,
  backgroundColor: "rgba(1,7,19,0.58)",
};

const noticeCard = {
  borderRadius: 26,
  paddingHorizontal: 18,
  paddingVertical: 18,
  backgroundColor: "rgba(8,18,43,0.98)",
  borderWidth: 1,
  borderColor: "rgba(173,232,255,0.18)",
};

const noticeIconWrap = {
  width: 42,
  height: 42,
  borderRadius: 21,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(173,232,255,0.10)",
  borderWidth: 1,
  borderColor: "rgba(173,232,255,0.18)",
};

const noticeTitle = {
  marginTop: 14,
  color: "white",
  fontSize: 22,
  fontWeight: "900" as const,
};

const noticeMessage = {
  marginTop: 10,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  lineHeight: 22,
};

const noticeActions = {
  marginTop: 18,
  flexDirection: "row" as const,
  justifyContent: "flex-end" as const,
};

const noticeSecondaryBtn = {
  minHeight: 46,
  paddingHorizontal: 16,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const noticeSecondaryText = {
  color: "rgba(255,255,255,0.92)",
  fontWeight: "800" as const,
  fontSize: 14,
};

const noticePrimaryBtn = {
  marginLeft: 10,
  minHeight: 46,
  paddingHorizontal: 16,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.16)",
};

const noticePrimaryText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 14,
};