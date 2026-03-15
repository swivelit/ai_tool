import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { apiGet, API_BASE } from "@/lib/api";
import { getProfile } from "@/lib/account";

type Routine = {
  wake_time: string;
  sleep_time: string;
  work_start?: string | null;
  work_end?: string | null;
  daily_habits?: string | null;
};

type NoticeState = {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimaryPress?: () => void;
} | null;

export default function RoutineScreen() {
  const insets = useSafeAreaInsets();
  const { userId, profile, refresh } = useAssistant();

  const [resolvedUserId, setResolvedUserId] = useState<number | null>(
    userId || profile?.userId || null
  );
  const [resolvedProfile, setResolvedProfile] = useState(profile || null);

  const [routine, setRoutine] = useState<Routine>({
    wake_time: "07:30",
    sleep_time: "23:30",
    work_start: "09:30",
    work_end: "18:30",
    daily_habits: "Gym, Water, Reading",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const accountName = useMemo(
    () => resolvedProfile?.name || profile?.name || "Not set",
    [resolvedProfile, profile?.name]
  );

  const accountPlace = useMemo(
    () => resolvedProfile?.place || profile?.place || "Not set",
    [resolvedProfile, profile?.place]
  );

  const accountTimezone = useMemo(
    () => resolvedProfile?.timezone || profile?.timezone || "Asia/Kolkata",
    [resolvedProfile, profile?.timezone]
  );

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

    async function hydrateIdentity() {
      try {
        const localProfile = await getProfile();
        if (!alive) return;

        const nextUserId = userId || profile?.userId || localProfile?.userId || null;
        const nextProfile = profile || localProfile || null;

        setResolvedUserId(nextUserId);
        setResolvedProfile(nextProfile);
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    void hydrateIdentity();

    return () => {
      alive = false;
    };
  }, [userId, profile]);

  useEffect(() => {
    let mounted = true;

    async function loadRoutine() {
      if (!resolvedUserId) {
        if (mounted) {
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        const data = await apiGet<Routine>(`/users/${resolvedUserId}/daily-routine`);

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
        // keep defaults if routine does not exist yet
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void loadRoutine();

    return () => {
      mounted = false;
    };
  }, [resolvedUserId]);

  function validateHHMM(v: string) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test((v || "").trim());
  }

  async function saveRoutine() {
    if (!resolvedUserId) {
      showNotice(
        "Profile missing",
        "Your profile session is not ready yet. Please return to onboarding and complete the profile flow once.",
        "Go to profile",
        () => {
          closeNotice();
          router.replace("/onboarding/profile");
        }
      );
      return;
    }

    if (!validateHHMM(routine.wake_time) || !validateHHMM(routine.sleep_time)) {
      showNotice("Invalid time", "Wake time and sleep time must be in HH:MM format.");
      return;
    }

    if (routine.work_start?.trim() && !validateHHMM(routine.work_start)) {
      showNotice("Invalid time", "Work start must be in HH:MM format.");
      return;
    }

    if (routine.work_end?.trim() && !validateHHMM(routine.work_end)) {
      showNotice("Invalid time", "Work end must be in HH:MM format.");
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

      const res = await fetch(`${API_BASE}/users/${resolvedUserId}/daily-routine`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Could not save routine");
      }

      await refresh();

      router.replace("/(tabs)");
    } catch (e: any) {
      showNotice("Save failed", e?.message || "Could not save routine.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#76ACE4"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: Math.max(insets.bottom + 24, 30),
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={topBar}>
            <Pressable
              style={iconBtn}
              onPress={() => router.replace("/(tabs)")}
              hitSlop={10}
            >
              <Ionicons name="chevron-back" size={20} color="rgba(255,255,255,0.95)" />
            </Pressable>

            <View style={titleWrap}>
              <Text style={screenTitle} numberOfLines={1}>
                Setting
              </Text>
            </View>

            <View style={iconBtn}>
              <Ionicons name="settings-outline" size={18} color="rgba(255,255,255,0.82)" />
            </View>
          </View>

          <GlassCard style={{ marginTop: 18, borderRadius: 22 }}>
            <Text style={cardTitle}>Account</Text>
            <Text style={accountLine}>Name: {accountName}</Text>
            <Text style={accountLine}>Place: {accountPlace}</Text>
            <Text style={accountLine}>Timezone: {accountTimezone}</Text>
          </GlassCard>

          <GlassCard style={{ marginTop: 14, borderRadius: 22 }}>
            <Text style={cardTitle}>Daily routine</Text>

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
              height={92}
            />
          </GlassCard>

          <Pressable
            onPress={saveRoutine}
            disabled={saving || loading}
            style={[saveBtn, (saving || loading) && { opacity: 0.65 }]}
          >
            {saving || loading ? (
              <ActivityIndicator color="#041222" />
            ) : (
              <Text style={saveBtnText}>Save routine</Text>
            )}
          </Pressable>
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
                <Ionicons
                  name="information-circle"
                  size={22}
                  color="rgba(173,232,255,0.98)"
                />
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

const topBar = {
  minHeight: 44,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const titleWrap = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  paddingHorizontal: 12,
};

const iconBtn = {
  width: 40,
  height: 40,
  borderRadius: 20,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const screenTitle = {
  color: "white",
  fontSize: 24,
  fontWeight: "900" as const,
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
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const saveBtn = {
  marginTop: 18,
  height: 54,
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