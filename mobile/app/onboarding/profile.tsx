import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import {
  createProfileOnBackend,
  getProfileForFirebaseUid,
  saveProfile,
} from "@/lib/account";
import { setAssistantName } from "@/lib/storage";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";

type NoticeState = {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimaryPress?: () => void;
} | null;

export default function ProfileScreen() {
  const { name: currentAssistantName, profile, refresh } = useAssistant();
  const { user } = useAuth();

  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [assistantName, setAssistantNameInput] = useState(currentAssistantName || "Elli");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const provider = useMemo(() => {
    if (user?.providerData?.some((item) => item.providerId === "google.com")) {
      return "google" as const;
    }
    return "password" as const;
  }, [user?.providerData]);

  useEffect(() => {
    setName(user?.displayName || profile?.name || "");
    setPlace(profile?.place || "");
  }, [profile?.name, profile?.place, user?.displayName]);

  useEffect(() => {
    if (currentAssistantName) {
      setAssistantNameInput(currentAssistantName);
    }
  }, [currentAssistantName]);

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

  async function saveProfileAndContinue() {
    if (busy) return;

    if (!user) {
      showNotice(
        "Login required",
        "Please login again and then continue."
      );
      return;
    }

    if (!name.trim()) {
      showNotice(
        "Name required",
        "Please enter your name."
      );
      return;
    }

    if (!assistantName.trim()) {
      showNotice(
        "Assistant name required",
        "Please enter an assistant name."
      );
      return;
    }

    try {
      setBusy(true);

      const normalizedProfile = {
        firebaseUid: user.uid,
        firebaseEmailVerified: user.emailVerified,
        email: user.email || "",
        avatarUrl: user.photoURL || undefined,
        authProvider: provider,
        name: name.trim(),
        place: place.trim(),
        assistantName: assistantName.trim(),
        timezone: "Asia/Kolkata",
        questionnaireCompleted: false,
      } as const;

      await setAssistantName(normalizedProfile.assistantName);

      const existingProfile =
        profile?.firebaseUid === user.uid && profile?.userId
          ? profile
          : await getProfileForFirebaseUid(user.uid);

      if (existingProfile?.userId) {
        await saveProfile({
          ...existingProfile,
          ...normalizedProfile,
          userId: existingProfile.userId,
          questionnaireCompleted: existingProfile.questionnaireCompleted ?? false,
        });
      } else {
        await createProfileOnBackend(normalizedProfile);
      }

      await refresh();
      router.replace("/onboarding/questionnaire");
    } catch (error: any) {
      showNotice(
        "Couldn’t save profile",
        error?.message || "Failed to save profile."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 18, justifyContent: "center" }}>
        <Text style={{ color: "white", fontSize: 30, fontWeight: "900" }}>
          Complete your profile
        </Text>

        <Text style={{ color: "rgba(255,255,255,0.65)", marginTop: 8, lineHeight: 22 }}>
          Your login is ready. Add a few profile details so {assistantName || "Elli"} can
          personalize the app.
        </Text>

        <Text style={label}>Email</Text>
        <View style={readonlyBox}>
          <Text style={{ color: "rgba(255,255,255,0.88)", fontSize: 15 }}>
            {user?.email || "-"}
          </Text>
        </View>

        <Text style={label}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Text style={label}>Place</Text>
        <TextInput
          value={place}
          onChangeText={setPlace}
          placeholder="Place (optional)"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Text style={label}>Assistant name</Text>
        <TextInput
          value={assistantName}
          onChangeText={setAssistantNameInput}
          placeholder="Elli"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Pressable
          onPress={saveProfileAndContinue}
          style={[btn, busy && { opacity: 0.7 }]}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={{ color: "white", fontWeight: "900" }}>Continue</Text>
          )}
        </Pressable>

        {notice ? (
          <View style={noticeOverlay}>
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
      </SafeAreaView>
    </LinearGradient>
  );
}

const label = {
  marginTop: 14,
  marginBottom: 8,
  color: "rgba(255,255,255,0.92)",
  fontSize: 14,
  fontWeight: "800" as const,
};

const input = {
  height: 54,
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
};

const readonlyBox = {
  minHeight: 54,
  borderRadius: 16,
  paddingHorizontal: 14,
  alignItems: "flex-start" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
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