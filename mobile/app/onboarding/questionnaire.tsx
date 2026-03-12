import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
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
import { getProfile, submitQuestionnaire, generateDailyCheckins } from "@/lib/account";
import {
  ensureNotificationsReady,
  scheduleReminder,
  cancelAllReminders,
} from "@/lib/reminders";

type DialogState = {
  visible: boolean;
  title: string;
  message: string;
  kind?: "info" | "error" | "success";
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
};

const initialDialog: DialogState = {
  visible: false,
  title: "",
  message: "",
  kind: "info",
  primaryLabel: "OK",
};

export default function Questionnaire() {
  const { profile, userId, refresh } = useAssistant();

  const [workStart, setWorkStart] = useState("09:30");
  const [workEnd, setWorkEnd] = useState("18:30");
  const [sleep, setSleep] = useState("23:30");
  const [wake, setWake] = useState("07:30");
  const [dailyHabits, setDailyHabits] = useState("Gym, Water, Reading");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(initialDialog);

  useEffect(() => {
    void refresh();
  }, []);

  function validateHHMM(v: string) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test((v || "").trim());
  }

  function showDialog(next: Omit<DialogState, "visible">) {
    setDialog({
      ...initialDialog,
      ...next,
      visible: true,
    });
  }

  function hideDialog(after?: () => void) {
    setDialog((prev) => ({ ...prev, visible: false }));
    if (after) {
      setTimeout(after, 120);
    }
  }

  async function resolveUserId() {
    if (userId) return userId;
    if (profile?.userId) return profile.userId;

    await refresh();

    const localProfile = await getProfile();
    return localProfile?.userId;
  }

  async function finish() {
    if (busy) return;

    if (![workStart, workEnd, sleep, wake].every(validateHHMM)) {
      showDialog({
        title: "Invalid time",
        message: "Please use HH:MM format, for example 07:30.",
        kind: "error",
        primaryLabel: "OK",
      });
      return;
    }

    try {
      setBusy(true);

      const resolvedUserId = await resolveUserId();

      if (!resolvedUserId) {
        showDialog({
          title: "Profile missing",
          message:
            "Your account session is missing. Please create your profile again to continue.",
          kind: "error",
          primaryLabel: "Create profile",
          secondaryLabel: "Close",
          onPrimary: () => router.replace("/onboarding/profile"),
        });
        return;
      }

      const payload = {
        workStart: workStart.trim(),
        workEnd: workEnd.trim(),
        sleep: sleep.trim(),
        wake: wake.trim(),
        dailyHabits: dailyHabits.trim(),
      };

      await submitQuestionnaire(resolvedUserId, payload);

      const ok = await ensureNotificationsReady();

      if (!ok) {
        showDialog({
          title: "Notifications disabled",
          message:
            "Your routine is saved. Enable notifications to receive check-ins, or continue using the app without them.",
          kind: "info",
          primaryLabel: "Continue",
          onPrimary: () => router.replace("/(tabs)"),
        });
        return;
      }

      await cancelAllReminders();

      const out = await generateDailyCheckins(resolvedUserId);
      let scheduledCount = 0;
      const now = Date.now();

      for (const c of out.checkins || []) {
        try {
          if (!c?.when || !validateHHMM(c.when)) continue;

          const [hh, mm] = c.when.split(":").map(Number);
          const when = new Date();
          when.setHours(hh, mm, 0, 0);

          if (when.getTime() <= now + 30_000) {
            when.setDate(when.getDate() + 1);
          }

          await scheduleReminder(c.title, c.message, when);
          scheduledCount += 1;
        } catch (err) {
          console.warn("Failed to schedule check-in", c, err);
        }
      }

      showDialog({
        title: "All set",
        message: `Scheduled ${scheduledCount} check-ins for your day.`,
        kind: "success",
        primaryLabel: "Continue",
        onPrimary: () => router.replace("/(tabs)"),
      });
    } catch (e: any) {
      showDialog({
        title: "Something went wrong",
        message: e?.message || "Failed to finish onboarding.",
        kind: "error",
        primaryLabel: "OK",
      });
    } finally {
      setBusy(false);
    }
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
              paddingTop: 12,
              paddingBottom: 32,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={headerRow}>
              <Text style={title}>Daily routine</Text>

              <View style={headerBadge}>
                <Ionicons
                  name="sparkles-outline"
                  size={16}
                  color="rgba(173,232,255,0.95)"
                />
              </View>
            </View>

            <Text style={subtitle}>We’ll use this to create smart check-ins.</Text>

            <GlassCard style={{ marginTop: 22, borderRadius: 26 }}>
              <Field
                label="Work start (HH:MM)"
                value={workStart}
                onChangeText={setWorkStart}
              />

              <Field
                label="Work end (HH:MM)"
                value={workEnd}
                onChangeText={setWorkEnd}
              />

              <Field
                label="Wake time"
                value={wake}
                onChangeText={setWake}
              />

              <Field
                label="Sleep time"
                value={sleep}
                onChangeText={setSleep}
              />

              <Field
                label="Daily habits (comma separated)"
                value={dailyHabits}
                onChangeText={setDailyHabits}
                multiline
                height={88}
                placeholder="Gym, Water, Reading"
              />
            </GlassCard>

            <Pressable
              onPress={finish}
              style={[finishBtn, busy && { opacity: 0.72 }]}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#041222" />
              ) : (
                <Text style={finishBtnText}>Finish & Schedule Check-ins</Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>

        <Modal
          transparent
          visible={dialog.visible}
          animationType="fade"
          onRequestClose={() => hideDialog()}
        >
          <View style={modalBackdrop}>
            <Pressable
              style={{ position: "absolute", inset: 0 }}
              onPress={() => hideDialog()}
            />

            <GlassCard style={modalCard}>
              <View
                style={[
                  modalIconWrap,
                  dialog.kind === "error"
                    ? modalIconError
                    : dialog.kind === "success"
                    ? modalIconSuccess
                    : modalIconInfo,
                ]}
              >
                <Ionicons
                  name={
                    dialog.kind === "error"
                      ? "alert-circle"
                      : dialog.kind === "success"
                      ? "checkmark-circle"
                      : "information-circle"
                  }
                  size={26}
                  color="white"
                />
              </View>

              <Text style={modalTitle}>{dialog.title}</Text>
              <Text style={modalMessage}>{dialog.message}</Text>

              <View style={modalActions}>
                {dialog.secondaryLabel ? (
                  <Pressable
                    onPress={() => hideDialog(dialog.onSecondary)}
                    style={[modalBtn, modalBtnGhost]}
                  >
                    <Text style={modalGhostText}>{dialog.secondaryLabel}</Text>
                  </Pressable>
                ) : null}

                <Pressable
                  onPress={() => hideDialog(dialog.onPrimary)}
                  style={[
                    modalBtn,
                    modalBtnPrimary,
                    !dialog.secondaryLabel && { flex: 1 },
                  ]}
                >
                  <Text style={modalPrimaryText}>{dialog.primaryLabel || "OK"}</Text>
                </Pressable>
              </View>
            </GlassCard>
          </View>
        </Modal>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Field({
  label,
  value,
  onChangeText,
  multiline = false,
  height = 58,
  placeholder = "HH:MM",
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
  height?: number;
  placeholder?: string;
}) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={fieldLabel}>{label}</Text>

      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.35)"
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        style={[
          fieldInput,
          {
            height,
            paddingTop: multiline ? 14 : 0,
          },
        ]}
      />
    </View>
  );
}

const headerRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const title = {
  color: "white",
  fontSize: 31,
  lineHeight: 37,
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

const fieldLabel = {
  color: "rgba(255,255,255,0.90)",
  fontWeight: "800" as const,
  fontSize: 14,
  marginBottom: 10,
};

const fieldInput = {
  borderRadius: 18,
  paddingHorizontal: 16,
  color: "white",
  fontSize: 15,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const finishBtn = {
  marginTop: 18,
  minHeight: 58,
  borderRadius: 20,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.16)",
};

const finishBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 17,
};

const modalBackdrop = {
  flex: 1,
  paddingHorizontal: 18,
  justifyContent: "center" as const,
  backgroundColor: "rgba(0,0,0,0.42)",
};

const modalCard = {
  borderRadius: 28,
  paddingHorizontal: 18,
  paddingTop: 18,
  paddingBottom: 16,
};

const modalIconWrap = {
  width: 54,
  height: 54,
  borderRadius: 27,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  marginBottom: 14,
};

const modalIconInfo = {
  backgroundColor: "rgba(63,171,255,0.92)",
};

const modalIconError = {
  backgroundColor: "rgba(255,98,98,0.92)",
};

const modalIconSuccess = {
  backgroundColor: "rgba(63,205,138,0.92)",
};

const modalTitle = {
  color: "white",
  fontSize: 22,
  fontWeight: "900" as const,
};

const modalMessage = {
  marginTop: 10,
  color: "rgba(255,255,255,0.76)",
  fontSize: 14,
  lineHeight: 21,
};

const modalActions = {
  flexDirection: "row" as const,
  gap: 10,
  marginTop: 18,
};

const modalBtn = {
  minHeight: 48,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  paddingHorizontal: 16,
};

const modalBtnGhost = {
  flex: 1,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const modalBtnPrimary = {
  flex: 1,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const modalGhostText = {
  color: "rgba(255,255,255,0.90)",
  fontWeight: "900" as const,
};

const modalPrimaryText = {
  color: "#041222",
  fontWeight: "900" as const,
};