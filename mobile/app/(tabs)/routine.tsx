import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, Alert } from "react-native";
import { useAssistant } from "@/components/AssistantProvider";

import Constants from "expo-constants";

const API = Constants.expoConfig?.extra?.apiUrl;

type Routine = {
  wake_time: string;
  sleep_time: string;
  work_start?: string;
  work_end?: string;
  daily_habits?: string;
};

export default function RoutineScreen() {
  const { userId } = useAssistant();

  const [routine, setRoutine] = useState<Routine>({
    wake_time: "07:30",
    sleep_time: "23:30",
    work_start: "",
    work_end: "",
    daily_habits: "",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) {
        setLoading(false);
        return;
    }

    fetch(`${API}/users/${userId}/daily-routine`)
        .then((r) => {
        if (r.status === 404) return null;
        return r.json();
        })
        .then((data) => {
        if (data) setRoutine(data);
        })
        .finally(() => setLoading(false));
    }, [userId]);

  async function saveRoutine() {
    if (!userId) return;

    setSaving(true);
    try {
        const payload = {
            wake_time: routine.wake_time,
            sleep_time: routine.sleep_time,
            work_start: routine.work_start?.trim() || null,
            work_end: routine.work_end?.trim() || null,
            daily_habits: routine.daily_habits?.trim() || null,
        };

        const res = await fetch(`${API}/users/${userId}/daily-routine`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(txt);
        }

        Alert.alert("Saved", "Your daily routine has been updated.");
    } catch (e) {
        Alert.alert("Error", "Could not save routine.");
    } finally {
        setSaving(false);
    }
  }


  if (loading) {
    return (
        <View style={{ flex: 1, backgroundColor: "#0B1020", padding: 20 }}>
         <Text style={{ color: "white" }}>Loading routine…</Text>
        </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#0B1020", padding: 20 }}>
      <Text style={label}>Wake up time</Text>
      <TextInput
        style={input}
        value={routine.wake_time}
        onChangeText={(v) => setRoutine({ ...routine, wake_time: v })}
        placeholder="07:30"
        placeholderTextColor="#6B7280"
      />

      <Text style={label}>Sleep time</Text>
      <TextInput
        style={input}
        value={routine.sleep_time}
        onChangeText={(v) => setRoutine({ ...routine, sleep_time: v })}
        placeholder="23:30"
        placeholderTextColor="#6B7280"
      />

      <Text style={label}>Work start</Text>
      <TextInput
        style={input}
        value={routine.work_start || ""}
        onChangeText={(v) => setRoutine({ ...routine, work_start: v })}
        placeholder="09:30"
        placeholderTextColor="#6B7280"
      />

      <Text style={label}>Work end</Text>
      <TextInput
        style={input}
        value={routine.work_end || ""}
        onChangeText={(v) => setRoutine({ ...routine, work_end: v })}
        placeholder="18:30"
        placeholderTextColor="#6B7280"
      />

      <Text style={label}>Daily habits</Text>
      <TextInput
        style={[input, { height: 80 }]}
        value={routine.daily_habits || ""}
        onChangeText={(v) => setRoutine({ ...routine, daily_habits: v })}
        placeholder="Meditation, walking, reading"
        placeholderTextColor="#6B7280"
        multiline
      />

      <Pressable
        onPress={saveRoutine}
        disabled={saving}
        style={{
          backgroundColor: "#22D3EE",
          padding: 16,
          borderRadius: 14,
          marginTop: 30,
          opacity: saving ? 0.6 : 1,
        }}
      >
        <Text style={{ textAlign: "center", fontWeight: "900", color: "#020617" }}>
          {saving ? "Saving…" : "Save Routine"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const label = {
  color: "rgba(255,255,255,0.85)",
  fontWeight: "700",
  marginTop: 18,
};

const input = {
  backgroundColor: "#020617",
  borderRadius: 12,
  padding: 14,
  marginTop: 6,
  color: "white",
};
