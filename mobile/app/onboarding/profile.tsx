import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name: currentAssistantName, profile, refresh } = useAssistant();
  const { user } = useAuth();

  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [assistantName, setAssistantNameInput] = useState(currentAssistantName || "Elli");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 14);
  const bottomPadding = Math.max(insets.bottom + 24, 24);
  const maxFormWidth = Math.min(width - horizontalPadding * 2, 520);

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
      showNotice("Login required", "Please login again and then continue.");
      return;
    }

    if (!name.trim()) {
      showNotice("Name required", "Please enter your name.");
      return;
    }

    if (!assistantName.trim()) {
      showNotice("Assistant name required", "Please enter an assistant name.");
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
      showNotice("Couldn’t save profile", error?.message || "Failed to save profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: horizontalPadding,
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
            justifyContent: height > 760 ? "center" : "flex-start",
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: "100%", alignSelf: "center", maxWidth: maxFormWidth }}>
            <Text
              style={{
                color: "white",
                fontSize: isVerySmallPhone ? 26 : isSmallPhone ? 28 : 30,
                lineHeight: isVerySmallPhone ? 32 : isSmallPhone ? 34 : 36,
                fontWeight: "900",
              }}
            >
              Complete your profile
            </Text>

            <Text
              style={{
                color: "rgba(255,255,255,0.65)",
                marginTop: 8,
                lineHeight: isSmallPhone ? 21 : 22,
                fontSize: isSmallPhone ? 13 : 14,
              }}
            >
              Your login is ready. Add a few profile details so {assistantName || "Elli"} can
              personalize the app.
            </Text>

            <Text style={[label, { marginTop: isSmallPhone ? 16 : 18 }]}>Email</Text>
            <View style={[readonlyBox, { minHeight: isSmallPhone ? 52 : 54 }]}>
              <Text style={{ color: "rgba(255,255,255,0.88)", fontSize: isSmallPhone ? 14 : 15 }}>
                {user?.email || "-"}
              </Text>
            </View>

            <Text style={label}>Your name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={[input, { height: isSmallPhone ? 52 : 54 }]}
              editable={!busy}
            />

            <Text style={label}>Place</Text>
            <TextInput
              value={place}
              onChangeText={setPlace}
              placeholder="Place (optional)"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={[input, { height: isSmallPhone ? 52 : 54 }]}
              editable={!busy}
            />

            <Text style={label}>Assistant name</Text>
            <TextInput
              value={assistantName}
              onChangeText={setAssistantNameInput}
              placeholder="Elli"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={[input, { height: isSmallPhone ? 52 : 54 }]}
              editable={!busy}
            />

            <Pressable
              onPress={saveProfileAndContinue}
              style={[btn, { marginTop: isSmallPhone ? 16 : 18, height: isSmallPhone ? 52 : 54 }, busy && { opacity: 0.7 }]}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={{ color: "white", fontWeight: "900", fontSize: 15 }}>
                  Continue
                </Text>
              )}
            </Pressable>
          </View>
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
      </KeyboardAvoidingView>
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
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
};

const readonlyBox = {
  borderRadius: 16,
  paddingHorizontal: 14,
  alignItems: "flex-start" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const btn = {
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