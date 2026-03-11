import React, { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { apiGet, API_BASE } from "@/lib/api";

type Routine = {
  wake_time: string;
  sleep_time: string;
  work_start?: string | null;
  work_end?: string | null;
  daily_habits?: string | null;
};

export default function RoutineScreen() {
  const { userId, profile } = useAssistant();

  const [routine, setRoutine] = useState<Routine>({
    wake_time: "07:30",
    sleep_time: "23:30",
    work_start: "09:30",
    work_end: "18:30",
    daily_habits: "Gym, Water, Reading",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (!userId) {
        if (mounted) setLoading(false);
        return;
      }

      try {
        const data = await apiGet<Routine>(`/users/${userId}/daily-routine`);
        if (mounted && data) {
          setRoutine({
            wake_time: data.wake_time || "07:30",
            sleep_time: data.sleep_time || "23:30",
            work_start: data.work_start || "09:30",
            work_end: data.work_end || "18:30",
            daily_habits: data.daily_habits || "",
          });
        }
      } catch {
        // keep defaults when no routine exists yet
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [userId]);

  function validateHHMM(v: string) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test((v || "").trim());
  }

  async function saveRoutine() {
    if (!userId) {
      Alert.alert("Profile missing", "Please finish onboarding first.");
      return;
    }

    if (!validateHHMM(routine.wake_time) || !validateHHMM(routine.sleep_time)) {
      Alert.alert("Invalid time", "Wake time and sleep time must be in HH:MM format.");
      return;
    }

    if (routine.work_start?.trim() && !validateHHMM(routine.work_start)) {
      Alert.alert("Invalid time", "Work start must be in HH:MM format.");
      return;
    }

    if (routine.work_end?.trim() && !validateHHMM(routine.work_end)) {
      Alert.alert("Invalid time", "Work end must be in HH:MM format.");
      return;
    }

    try {
      setSaving(true);

      const payload = {
        wake_time: routine.wake_time.trim(),
        sleep_time: routine.sleep_time.trim(),
        work_start: routine.work_start?.trim() || null,
        work_end: routine.work_end?.trim() || null,
        daily_habits: routine.daily_habits?.trim() || null,
      };

      const res = await fetch(`${API_BASE}/users/${userId}/daily-routine`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Could not save routine");
      }

      Alert.alert("Saved", "Your routine has been updated.");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not save routine.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <LinearGradient
      colors={["#020816", "#04132D", "#0B3D86"]}
      start={{ x: 0.12, y: 0.04 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 110 }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={screenTitle}>Routine</Text>
          <Text style={screenSub}>
            Keep your assistant aligned with your real day.
          </Text>

          <GlassCard style={{ marginTop: 18, borderRadius: 24 }}>
            <Text style={cardTitle}>Account</Text>
            <Text style={accountLine}>Name: {profile?.name || "Not set"}</Text>
            <Text style={accountLine}>Place: {profile?.place || "Not set"}</Text>
            <Text style={accountLine}>Timezone: {profile?.timezone || "Asia/Kolkata"}</Text>
          </GlassCard>

          <GlassCard style={{ marginTop: 14, borderRadius: 24 }}>
            <Text style={cardTitle}>Daily rhythm</Text>

            <Field
              label="Wake time"
              value={routine.wake_time}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, wake_time: v }))}
              placeholder="07:30"
            />

            <Field
              label="Sleep time"
              value={routine.sleep_time}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, sleep_time: v }))}
              placeholder="23:30"
            />

            <Field
              label="Work start"
              value={routine.work_start || ""}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_start: v }))}
              placeholder="09:30"
            />

            <Field
              label="Work end"
              value={routine.work_end || ""}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_end: v }))}
              placeholder="18:30"
            />

            <Field
              label="Daily habits"
              value={routine.daily_habits || ""}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, daily_habits: v }))}
              placeholder="Gym, Water, Reading"
              multiline
              height={90}
            />
          </GlassCard>

          <Pressable
            onPress={saveRoutine}
            disabled={saving || loading}
            style={[saveBtn, (saving || loading) && { opacity: 0.65 }]}
          >
            <Text style={saveBtnText}>
              {loading ? "Loading..." : saving ? "Saving..." : "Save routine"}
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  height = 52,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
  height?: number;
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
        style={[
          fieldInput,
          {
            height,
            textAlignVertical: multiline ? "top" : "center",
            paddingTop: multiline ? 14 : 0,
          },
        ]}
      />
    </View>
  );
}

const screenTitle = {
  color: "white",
  fontSize: 30,
  fontWeight: "900" as const,
};

const screenSub = {
  marginTop: 6,
  color: "rgba(255,255,255,0.62)",
  fontSize: 14,
};

const cardTitle = {
  color: "rgba(255,255,255,0.96)",
  fontSize: 16,
  fontWeight: "900" as const,
};

const accountLine = {
  marginTop: 8,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
};

const fieldLabel = {
  color: "rgba(255,255,255,0.82)",
  fontWeight: "800" as const,
  fontSize: 13,
  marginBottom: 8,
};

const fieldInput = {
  borderRadius: 18,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const saveBtn = {
  marginTop: 18,
  height: 56,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(110,199,255,0.96)",
};

const saveBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 15,
};