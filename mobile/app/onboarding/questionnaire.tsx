import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import {
  PersonalityAnswers,
  PersonalityQuestion,
  getPersonalityQuestions,
  getProfile,
  savePersonalityAnswers,
} from "@/lib/account";

export default function QuestionnaireScreen() {
  const { profile, userId, refresh } = useAssistant();

  const [questions, setQuestions] = useState<PersonalityQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoading(true);
        const nextQuestions = await getPersonalityQuestions();
        if (!alive) return;
        setQuestions(nextQuestions);
      } catch (error: any) {
        Alert.alert("Unable to load questions", error?.message || "Please try again.");
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    void refresh();
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

    await refresh();

    const localProfile = await getProfile();
    return localProfile?.userId;
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
        Alert.alert(
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
      Alert.alert(
        "Please answer all questions",
        `You still have ${missing.length} unanswered question${missing.length > 1 ? "s" : ""}.`
      );
      return;
    }

    try {
      setSaving(true);

      const resolvedUserId = await resolveUserId();
      if (!resolvedUserId) {
        Alert.alert(
          "Profile missing",
          "Your user session could not be found. Please complete your profile again.",
          [
            {
              text: "Go to profile",
              onPress: () => router.replace("/onboarding/profile"),
            },
          ]
        );
        return;
      }

      const payload: PersonalityAnswers = Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [key, value])
      );

      await savePersonalityAnswers(resolvedUserId, payload);
      await refresh();

      Alert.alert(
        "Profile questions saved",
        "Your personality profile is ready. Next, set your daily routine.",
        [
          {
            text: "Continue",
            onPress: () => router.replace("/(tabs)/routine"),
          },
        ]
      );
    } catch (error: any) {
      Alert.alert("Failed to save answers", error?.message || "Please try again.");
    } finally {
      setSaving(false);
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
        <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="white" />
          <Text style={{ marginTop: 14, color: "rgba(255,255,255,0.74)" }}>
            Loading your questionnaire...
          </Text>
        </SafeAreaView>
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
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 18,
            paddingTop: 12,
            paddingBottom: 36,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={headerRow}>
            <View style={{ flex: 1, paddingRight: 14 }}>
              <Text style={title}>Complete your personality profile</Text>
              <Text style={subtitle}>
                Answer these {questions.length} questions so the assistant can respond in a way
                that fits you better.
              </Text>
            </View>

            <View style={headerBadge}>
              <Ionicons name="sparkles-outline" size={16} color="rgba(173,232,255,0.95)" />
            </View>
          </View>

          <View style={progressWrap}>
            <Text style={progressText}>
              {answeredCount}/{questions.length} answered
            </Text>
          </View>

          {questions.map((question, index) => {
            const selected = answers[question.id] || [];
            const helperText =
              question.type === "multi"
                ? `Choose up to ${question.max_choices || 1}`
                : "Choose 1 option";

            return (
              <GlassCard key={question.id} style={card}>
                <Text style={questionIndex}>Question {index + 1}</Text>
                <Text style={questionText}>{question.prompt}</Text>
                <Text style={helper}>{helperText}</Text>

                <View style={optionsWrap}>
                  {question.options.map((option) => {
                    const active = selected.includes(option);

                    return (
                      <Pressable
                        key={option}
                        onPress={() => toggleOption(question, option)}
                        style={[optionBtn, active && optionBtnActive]}
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
                        <Text style={[optionText, active && optionTextActive]}>
                          {formatOptionLabel(option)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </GlassCard>
            );
          })}

          <Pressable
            onPress={submit}
            style={[submitBtn, saving && { opacity: 0.72 }]}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#041222" />
            ) : (
              <Text style={submitBtnText}>Save answers and continue</Text>
            )}
          </Pressable>
        </ScrollView>
      </SafeAreaView>
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
  fontSize: 30,
  lineHeight: 36,
  fontWeight: "900" as const,
};

const subtitle = {
  marginTop: 8,
  color: "rgba(255,255,255,0.68)",
  fontSize: 14,
  lineHeight: 21,
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
  marginTop: 18,
  marginBottom: 6,
};

const progressText = {
  color: "rgba(173,232,255,0.95)",
  fontSize: 13,
  fontWeight: "800" as const,
};

const card = {
  marginTop: 14,
  borderRadius: 26,
  paddingVertical: 18,
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
  fontSize: 19,
  lineHeight: 27,
  fontWeight: "800" as const,
};

const helper = {
  marginTop: 8,
  color: "rgba(255,255,255,0.62)",
  fontSize: 13,
};

const optionsWrap = {
  marginTop: 14,
  gap: 10,
};

const optionBtn = {
  minHeight: 52,
  borderRadius: 18,
  paddingHorizontal: 14,
  paddingVertical: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
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
  color: "rgba(255,255,255,0.92)",
  fontSize: 14,
  fontWeight: "700" as const,
  lineHeight: 20,
};

const optionTextActive = {
  color: "#041222",
};

const submitBtn = {
  marginTop: 20,
  minHeight: 58,
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
  fontSize: 17,
};