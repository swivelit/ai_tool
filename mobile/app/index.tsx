import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { createProfileOnBackend, getProfile } from "@/lib/account";
import { apiPost } from "@/lib/api";

type Stage = "welcome" | "identity" | "details" | "questions";

type Question = {
  id: string;
  question: string;
  options: string[];
};

const QUESTIONS: Question[] = [
  {
    id: "planning_style",
    question: "How do you usually plan your day?",
    options: [
      "I plan everything clearly",
      "I keep a rough plan",
      "I decide as the day goes",
      "It depends on my mood",
    ],
  },
  {
    id: "reminder_style",
    question: "What type of reminders help you most?",
    options: [
      "Direct and strict",
      "Friendly and motivating",
      "Short and simple",
      "Gentle and calm",
    ],
  },
  {
    id: "decision_speed",
    question: "When making decisions, what feels most like you?",
    options: [
      "I decide very quickly",
      "I think and then decide",
      "I ask others first",
      "I delay until necessary",
    ],
  },
  {
    id: "work_energy",
    question: "When do you feel most productive?",
    options: [
      "Early morning",
      "Late morning",
      "Afternoon",
      "Night time",
    ],
  },
  {
    id: "communication_preference",
    question: "How should the assistant speak with you?",
    options: [
      "Professional and clear",
      "Warm and friendly",
      "Short and practical",
      "Energetic and motivating",
    ],
  },
  {
    id: "stress_response",
    question: "When stress increases, what helps you most?",
    options: [
      "A step-by-step plan",
      "Encouragement and support",
      "Silence and space",
      "A quick action list",
    ],
  },
  {
    id: "goal_style",
    question: "How do you like to work toward goals?",
    options: [
      "Daily targets",
      "Weekly targets",
      "Only broad direction",
      "I need help staying consistent",
    ],
  },
  {
    id: "social_energy",
    question: "Which best matches your social style?",
    options: [
      "Very social",
      "Balanced",
      "Mostly private",
      "Depends on the people",
    ],
  },
  {
    id: "motivation_trigger",
    question: "What motivates you the most?",
    options: [
      "Progress and achievement",
      "Recognition and appreciation",
      "Peace of mind",
      "Responsibility to others",
    ],
  },
  {
    id: "learning_style",
    question: "How do you prefer to learn new things?",
    options: [
      "Detailed explanation",
      "Quick summary first",
      "Examples and practice",
      "Visual or real-life stories",
    ],
  },
  {
    id: "followup_style",
    question: "How often should the assistant check in with you?",
    options: [
      "Frequently",
      "A few times a day",
      "Only when needed",
      "Very rarely",
    ],
  },
  {
    id: "problem_solving",
    question: "When something goes wrong, what do you prefer first?",
    options: [
      "A practical solution",
      "A calm explanation",
      "A list of options",
      "Reassurance and support",
    ],
  },
  {
    id: "routine_preference",
    question: "What kind of routine suits you best?",
    options: [
      "Highly structured",
      "Mostly structured",
      "Flexible routine",
      "No fixed routine",
    ],
  },
  {
    id: "tone_when_tired",
    question: "When you are tired, how should the assistant respond?",
    options: [
      "Be very gentle",
      "Be brief and clear",
      "Push me a little",
      "Just give the essentials",
    ],
  },
  {
    id: "assistant_role",
    question: "What role do you want this assistant to play for you?",
    options: [
      "Planner and organizer",
      "Companion and motivator",
      "Productivity coach",
      "General helper",
    ],
  },
];

export default function IndexScreen() {
  const { refresh, updateName } = useAssistant();

  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);

  const [stage, setStage] = useState<Stage>("welcome");
  const [questionIndex, setQuestionIndex] = useState(0);

  const [userName, setUserName] = useState("");
  const [assistantName, setAssistantName] = useState("J AI");
  const [place, setPlace] = useState("");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [profession, setProfession] = useState("");
  const [mainFocus, setMainFocus] = useState("");

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const profile = await getProfile();
        if (!active) return;

        if (profile?.userId) {
          router.replace("/(tabs)");
          return;
        }
      } finally {
        if (active) setBooting(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const currentQuestion = QUESTIONS[questionIndex];
  const currentAnswer = answers[currentQuestion?.id || ""];
  const answeredCount = useMemo(
    () => Object.values(answers).filter(Boolean).length,
    [answers]
  );
  const progress = useMemo(() => {
    const base = stage === "welcome" ? 0.1 : stage === "identity" ? 0.25 : stage === "details" ? 0.45 : 0.6;
    if (stage !== "questions") return base;
    return Math.min(1, 0.6 + (answeredCount / QUESTIONS.length) * 0.4);
  }, [stage, answeredCount]);

  function goNextFromIdentity() {
    if (!userName.trim()) {
      setErrorText("Please enter your name.");
      return;
    }
    if (!assistantName.trim()) {
      setErrorText("Please enter the app name.");
      return;
    }
    setErrorText("");
    setStage("details");
  }

  function goNextFromDetails() {
    if (!place.trim()) {
      setErrorText("Please enter your place.");
      return;
    }
    if (!timezone.trim()) {
      setErrorText("Please enter your timezone.");
      return;
    }
    if (!profession.trim()) {
      setErrorText("Please enter your profession or role.");
      return;
    }
    if (!mainFocus.trim()) {
      setErrorText("Please enter your current main focus.");
      return;
    }
    setErrorText("");
    setStage("questions");
  }

  function pickOption(value: string) {
    setAnswers((prev) => ({
      ...prev,
      [currentQuestion.id]: value,
    }));
    setErrorText("");
  }

  function nextQuestion() {
    if (!currentAnswer) {
      setErrorText("Please choose one option to continue.");
      return;
    }
    setErrorText("");
    if (questionIndex >= QUESTIONS.length - 1) return;
    setQuestionIndex((prev) => prev + 1);
  }

  function previousQuestion() {
    setErrorText("");
    if (questionIndex <= 0) {
      setStage("details");
      return;
    }
    setQuestionIndex((prev) => prev - 1);
  }

  async function finishOnboarding() {
    if (!currentAnswer) {
      setErrorText("Please choose one option to continue.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");

      await updateName(assistantName.trim());

      const created = await createProfileOnBackend({
        name: userName.trim(),
        place: place.trim(),
        timezone: timezone.trim() || "Asia/Kolkata",
        assistantName: assistantName.trim(),
      });

      if (!created.userId) {
        throw new Error("Profile creation failed.");
      }

      const personalityAnswers: Record<string, string> = {
        "Name": userName.trim(),
        "Assistant name": assistantName.trim(),
        "Place": place.trim(),
        "Timezone": timezone.trim() || "Asia/Kolkata",
        "Profession / role": profession.trim(),
        "Current main focus": mainFocus.trim(),
      };

      for (const q of QUESTIONS) {
        personalityAnswers[q.question] = answers[q.id] || "";
      }

      await apiPost(`/users/${created.userId}/personality`, {
        answers: personalityAnswers,
      });

      try {
        await apiPost(`/users/${created.userId}/personality/generate-summary`, {});
      } catch {
        // summary generation should not block onboarding completion
      }

      await refresh();
      router.replace("/onboarding/questionnaire");
    } catch (e: any) {
      setErrorText(e?.message || "Failed to complete onboarding.");
    } finally {
      setBusy(false);
    }
  }

  if (booting) {
    return (
      <LinearGradient
        colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
        start={{ x: 0.08, y: 0.02 }}
        end={{ x: 0.88, y: 1 }}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="white" />
          <Text style={{ marginTop: 14, color: "rgba(255,255,255,0.75)", fontSize: 14 }}>
            Loading J AI...
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
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingHorizontal: 18,
              paddingTop: 16,
              paddingBottom: 32,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={headerRow}>
              <View style={{ flex: 1 }}>
                <Text style={title}>J AI</Text>
                <Text style={subtitle}>
                  Persona-aware Tamil assistant onboarding
                </Text>
              </View>

              <View style={headerBadge}>
                <Ionicons name="sparkles-outline" size={17} color="rgba(173,232,255,0.95)" />
              </View>
            </View>

            <View style={progressTrack}>
              <View style={[progressFill, { width: `${Math.max(8, progress * 100)}%` }]} />
            </View>

            {errorText ? (
              <View style={errorCard}>
                <Ionicons name="alert-circle-outline" size={16} color="#FFD8D8" />
                <Text style={errorTextStyle}>{errorText}</Text>
              </View>
            ) : null}

            {stage === "welcome" ? (
              <GlassCard style={{ marginTop: 18, borderRadius: 28 }}>
                <Text style={sectionTitle}>Welcome</Text>
                <Text style={sectionText}>
                  This flow collects your name, app name, some personal details, and
                  15 behaviour questions so the assistant can respond in a more personal way.
                </Text>

                <View style={infoRow}>
                  <Ionicons name="person-circle-outline" size={18} color="rgba(173,232,255,0.95)" />
                  <Text style={infoRowText}>Your identity and app name</Text>
                </View>

                <View style={infoRow}>
                  <Ionicons name="document-text-outline" size={18} color="rgba(173,232,255,0.95)" />
                  <Text style={infoRowText}>Your details and preferences</Text>
                </View>

                <View style={infoRow}>
                  <Ionicons name="help-circle-outline" size={18} color="rgba(173,232,255,0.95)" />
                  <Text style={infoRowText}>15 behaviour questions, 4 options each</Text>
                </View>

                <Pressable onPress={() => setStage("identity")} style={primaryBtn}>
                  <Text style={primaryBtnText}>Start onboarding</Text>
                </Pressable>
              </GlassCard>
            ) : null}

            {stage === "identity" ? (
              <GlassCard style={{ marginTop: 18, borderRadius: 28 }}>
                <Text style={sectionTitle}>Basic info</Text>
                <Text style={sectionText}>
                  First, tell us your name and what you want the app to be called.
                </Text>

                <Text style={label}>Your name</Text>
                <TextInput
                  value={userName}
                  onChangeText={setUserName}
                  placeholder="Hari"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <Text style={label}>App / assistant name</Text>
                <TextInput
                  value={assistantName}
                  onChangeText={setAssistantName}
                  placeholder="J AI"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <View style={buttonRow}>
                  <Pressable onPress={() => setStage("welcome")} style={ghostBtn}>
                    <Text style={ghostBtnText}>Back</Text>
                  </Pressable>

                  <Pressable onPress={goNextFromIdentity} style={primaryBtnHalf}>
                    <Text style={primaryBtnText}>Continue</Text>
                  </Pressable>
                </View>
              </GlassCard>
            ) : null}

            {stage === "details" ? (
              <GlassCard style={{ marginTop: 18, borderRadius: 28 }}>
                <Text style={sectionTitle}>Your details</Text>
                <Text style={sectionText}>
                  These help the assistant understand your context better.
                </Text>

                <Text style={label}>Place</Text>
                <TextInput
                  value={place}
                  onChangeText={setPlace}
                  placeholder="Cochin"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <Text style={label}>Timezone</Text>
                <TextInput
                  value={timezone}
                  onChangeText={setTimezone}
                  placeholder="Asia/Kolkata"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <Text style={label}>Profession / role</Text>
                <TextInput
                  value={profession}
                  onChangeText={setProfession}
                  placeholder="Founder / Manager / Student"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <Text style={label}>Current main focus</Text>
                <TextInput
                  value={mainFocus}
                  onChangeText={setMainFocus}
                  placeholder="Business growth / health / study / personal life"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={input}
                />

                <View style={buttonRow}>
                  <Pressable onPress={() => setStage("identity")} style={ghostBtn}>
                    <Text style={ghostBtnText}>Back</Text>
                  </Pressable>

                  <Pressable onPress={goNextFromDetails} style={primaryBtnHalf}>
                    <Text style={primaryBtnText}>Continue</Text>
                  </Pressable>
                </View>
              </GlassCard>
            ) : null}

            {stage === "questions" ? (
              <GlassCard style={{ marginTop: 18, borderRadius: 28 }}>
                <Text style={questionCount}>
                  Question {questionIndex + 1} / {QUESTIONS.length}
                </Text>
                <Text style={sectionTitle}>{currentQuestion.question}</Text>
                <Text style={sectionText}>
                  Choose the option that feels most like you.
                </Text>

                <View style={{ marginTop: 12 }}>
                  {currentQuestion.options.map((option) => {
                    const active = currentAnswer === option;
                    return (
                      <Pressable
                        key={option}
                        onPress={() => pickOption(option)}
                        style={[optionCard, active && optionCardActive]}
                      >
                        <View style={[radioDot, active && radioDotActive]} />
                        <Text style={[optionText, active && optionTextActive]}>
                          {option}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={buttonRow}>
                  <Pressable onPress={previousQuestion} style={ghostBtn}>
                    <Text style={ghostBtnText}>Back</Text>
                  </Pressable>

                  {questionIndex < QUESTIONS.length - 1 ? (
                    <Pressable onPress={nextQuestion} style={primaryBtnHalf}>
                      <Text style={primaryBtnText}>Next</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={finishOnboarding}
                      style={[primaryBtnHalf, busy && { opacity: 0.7 }]}
                      disabled={busy}
                    >
                      {busy ? (
                        <ActivityIndicator color="#041222" />
                      ) : (
                        <Text style={primaryBtnText}>Finish</Text>
                      )}
                    </Pressable>
                  )}
                </View>
              </GlassCard>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const headerRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const title = {
  color: "white",
  fontSize: 32,
  lineHeight: 38,
  fontWeight: "900" as const,
};

const subtitle = {
  marginTop: 6,
  color: "rgba(255,255,255,0.68)",
  fontSize: 14,
  lineHeight: 21,
};

const headerBadge = {
  width: 40,
  height: 40,
  borderRadius: 20,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const progressTrack = {
  marginTop: 16,
  height: 8,
  borderRadius: 999,
  backgroundColor: "rgba(255,255,255,0.10)",
  overflow: "hidden" as const,
};

const progressFill = {
  height: "100%" as const,
  borderRadius: 999,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const errorCard = {
  marginTop: 14,
  borderRadius: 16,
  paddingHorizontal: 12,
  paddingVertical: 10,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 8,
  backgroundColor: "rgba(255,92,92,0.18)",
  borderWidth: 1,
  borderColor: "rgba(255,160,160,0.25)",
};

const errorTextStyle = {
  flex: 1,
  color: "#FFE8E8",
  fontSize: 13,
  lineHeight: 19,
};

const sectionTitle = {
  color: "white",
  fontSize: 26,
  lineHeight: 32,
  fontWeight: "900" as const,
};

const sectionText = {
  marginTop: 8,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  lineHeight: 21,
};

const label = {
  marginTop: 16,
  marginBottom: 9,
  color: "rgba(255,255,255,0.92)",
  fontSize: 14,
  fontWeight: "800" as const,
};

const input = {
  height: 56,
  borderRadius: 18,
  paddingHorizontal: 16,
  color: "white",
  fontSize: 15,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const infoRow = {
  marginTop: 14,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
};

const infoRowText = {
  color: "rgba(255,255,255,0.85)",
  fontSize: 14,
  fontWeight: "700" as const,
};

const buttonRow = {
  marginTop: 22,
  flexDirection: "row" as const,
  gap: 10,
};

const ghostBtn = {
  flex: 1,
  minHeight: 52,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const ghostBtnText = {
  color: "rgba(255,255,255,0.90)",
  fontWeight: "900" as const,
  fontSize: 15,
};

const primaryBtn = {
  marginTop: 22,
  minHeight: 54,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const primaryBtnHalf = {
  flex: 1,
  minHeight: 52,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const primaryBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 15,
};

const questionCount = {
  color: "rgba(173,232,255,0.92)",
  fontSize: 13,
  fontWeight: "800" as const,
  marginBottom: 10,
};

const optionCard = {
  minHeight: 58,
  borderRadius: 18,
  paddingHorizontal: 14,
  paddingVertical: 14,
  marginBottom: 10,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 12,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const optionCardActive = {
  backgroundColor: "rgba(98,193,255,0.18)",
  borderColor: "rgba(123,218,255,0.38)",
};

const radioDot = {
  width: 18,
  height: 18,
  borderRadius: 9,
  borderWidth: 2,
  borderColor: "rgba(255,255,255,0.45)",
  backgroundColor: "transparent",
};

const radioDotActive = {
  borderColor: "rgba(173,232,255,0.98)",
  backgroundColor: "rgba(173,232,255,0.98)",
};

const optionText = {
  flex: 1,
  color: "rgba(255,255,255,0.90)",
  fontSize: 14,
  lineHeight: 20,
  fontWeight: "700" as const,
};

const optionTextActive = {
  color: "white",
};