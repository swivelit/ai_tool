import React, { useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { getProfile, submitQuestionnaire, generateDailyCheckins } from "@/lib/account";
import { scheduleReminder } from "@/lib/reminders";

export default function Questionnaire() {
  const [workStart, setWorkStart] = useState("09:30");
  const [workEnd, setWorkEnd] = useState("18:30");
  const [sleep, setSleep] = useState("23:30");
  const [wake, setWake] = useState("07:30");
  const [dailyHabits, setDailyHabits] = useState("Gym, Water, Reading");

  async function finish() {
    const prof = await getProfile();
    if (!prof?.userId) return Alert.alert("Profile missing", "Please create profile again.");

    const payload = { workStart, workEnd, sleep, wake, dailyHabits };
    await submitQuestionnaire(prof.userId, payload);

    // Generate today's check-ins and schedule them on device
    const out = await generateDailyCheckins(prof.userId);

    for (const c of out.checkins) {
      const [hh, mm] = c.when.split(":").map(Number);
      const when = new Date();
      when.setHours(hh, mm, 0, 0);
      if (when.getTime() > Date.now() + 30_000) {
        await scheduleReminder(c.title, c.message, when);
      }
    }

    router.replace("/(tabs)");
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

        <Pressable onPress={finish} style={btn}>
          <Text style={{ color: "white", fontWeight: "900" }}>Finish & Schedule Check-ins</Text>
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
