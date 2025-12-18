import React, { useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable, Alert, ActivityIndicator } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { getProfile, submitQuestionnaire, generateDailyCheckins } from "@/lib/account";
import { ensureNotificationsReady, scheduleReminder, cancelAllReminders } from "@/lib/reminders";

export default function Questionnaire() {
  const [workStart, setWorkStart] = useState("09:30");
  const [workEnd, setWorkEnd] = useState("18:30");
  const [sleep, setSleep] = useState("23:30");
  const [wake, setWake] = useState("07:30");
  const [dailyHabits, setDailyHabits] = useState("Gym, Water, Reading");
  const [busy, setBusy] = useState(false);

  function validateHHMM(v: string) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
    return !!m;
  }

  async function finish() {
    if (busy) return;

    // quick validation
    if (![workStart, workEnd, sleep, wake].every(validateHHMM)) {
      Alert.alert("Invalid time", "Please use HH:MM format (e.g. 07:30).");
      return;
    }

    try {
      setBusy(true);

      const prof = await getProfile();
      if (!prof?.userId) {
        Alert.alert("Profile missing", "Please create profile again.");
        return;
      }

      // 1) Save questionnaire
      const payload = { workStart, workEnd, sleep, wake, dailyHabits };
      await submitQuestionnaire(prof.userId, payload);

      // 2) Notification permission + Android channel
      const ok = await ensureNotificationsReady();
      if (!ok) {
        Alert.alert(
          "Notifications disabled",
          "Enable notifications to receive check-ins. You can still use the app without them."
        );
      }

      // 3) Re-generate check-ins and schedule them
      // optional: clear old ones to avoid duplicates
      await cancelAllReminders();

      const out = await generateDailyCheckins(prof.userId);

      let scheduledCount = 0;
      const now = Date.now();

      for (const c of out.checkins || []) {
        if (!c?.when || !validateHHMM(c.when)) continue;

        const [hh, mm] = c.when.split(":").map(Number);
        const when = new Date();
        when.setHours(hh, mm, 0, 0);

        // if time already passed today, schedule it for tomorrow
        if (when.getTime() <= now + 30_000) {
          when.setDate(when.getDate() + 1);
        }

        await scheduleReminder(c.title, c.message, when);
        scheduledCount += 1;
      }

      // 4) Tell user something happened + navigate immediately
      Alert.alert("All set ✅", `Scheduled ${scheduledCount} check-ins.`);
      router.replace("/(tabs)");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to finish onboarding");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 18 }}>
        <Text style={{ color: "white", fontSize: 26, fontWeight: "900" }}>Daily routine</Text>
        <Text style={{ color: "rgba(255,255,255,0.65)", marginTop: 8 }}>
          We’ll use this to create smart check-ins.
        </Text>

        <Row label="Work start (HH:MM)" value={workStart} setValue={setWorkStart} />
        <Row label="Work end (HH:MM)" value={workEnd} setValue={setWorkEnd} />
        <Row label="Wake time" value={wake} setValue={setWake} />
        <Row label="Sleep time" value={sleep} setValue={setSleep} />
        <Row label="Daily habits (comma separated)" value={dailyHabits} setValue={setDailyHabits} />

        <Pressable onPress={finish} style={[btn, busy && { opacity: 0.6 }]} disabled={busy}>
          {busy ? <ActivityIndicator /> : <Text style={{ color: "white", fontWeight: "900" }}>Finish & Schedule Check-ins</Text>}
        </Pressable>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Row({ label, value, setValue }: any) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={{ color: "rgba(255,255,255,0.75)", fontWeight: "800" }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="HH:MM"
        placeholderTextColor="rgba(255,255,255,0.35)"
        style={input}
      />
    </View>
  );
}

const input = {
  marginTop: 8,
  height: 52,
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
};

const btn = {
  marginTop: 18,
  height: 54,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(34,211,238,0.22)",
  borderWidth: 1,
  borderColor: "rgba(34,211,238,0.35)",
};
