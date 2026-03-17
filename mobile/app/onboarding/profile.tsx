import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  createProfileOnBackend,
  getProfileForFirebaseUid,
  saveProfile,
} from "@/lib/account";
import { setAssistantName } from "@/lib/storage";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";

type NoticeState = {
  title: string;
  message: string;
  primaryLabel?: string;
  onPrimaryPress?: () => void;
} | null;

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { name: currentAssistantName, profile, refresh, settings } = useAssistant();
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
        replyLanguage: settings.languageMode,
      } as const;

      await setAssistantName(normalizedProfile.assistantName);

      const existingProfile =
        profile?.firebaseUid === user.uid && profile?.userId
          ? profile
          : await getProfileForFirebaseUid(user.uid, user.email);

      const upsertedProfile = await createProfileOnBackend({
        ...existingProfile,
        ...normalizedProfile,
        userId: existingProfile?.userId,
        questionnaireCompleted: existingProfile?.questionnaireCompleted ?? false,
      });

      await saveProfile(upsertedProfile);

      await refresh();
      router.replace("/onboarding/questionnaire");
    } catch (error: any) {
      showNotice("Couldn’t save profile", error?.message || "Failed to save profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={styles.page}
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
            <View style={styles.heroPill}>
              <Ionicons name="person-circle-outline" size={14} color={Brand.bronze} />
              <Text style={styles.heroPillText}>Profile setup</Text>
            </View>

            <Text
              style={[
                styles.title,
                {
                  fontSize: isVerySmallPhone ? 28 : isSmallPhone ? 31 : 34,
                  lineHeight: isVerySmallPhone ? 34 : isSmallPhone ? 37 : 40,
                },
              ]}
            >
              Complete your profile
            </Text>

            <Text style={styles.subtitle}>
              Your login is ready. Add a few details so {assistantName || "Elli"} can personalize
              the experience from the start.
            </Text>

            <GlassCard style={{ borderRadius: 28, marginTop: 18 }}>
              <View style={styles.progressWrap}>
                <Text style={styles.progressLabel}>Step 1 of 2</Text>
                <Text style={styles.progressValue}>Profile</Text>
              </View>

              <FieldLabel label="Email" />
              <View style={[styles.readonlyBox, { minHeight: isSmallPhone ? 52 : 56 }]}>
                <Ionicons name="mail-outline" size={16} color={Brand.bronze} />
                <Text style={styles.readonlyText}>{user?.email || "-"}</Text>
              </View>

              <FieldLabel label="Your name" />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                placeholderTextColor="rgba(124, 99, 80, 0.52)"
                style={[styles.input, { height: isSmallPhone ? 52 : 56 }]}
                editable={!busy}
              />

              <FieldLabel label="Place" />
              <TextInput
                value={place}
                onChangeText={setPlace}
                placeholder="Place (optional)"
                placeholderTextColor="rgba(124, 99, 80, 0.52)"
                style={[styles.input, { height: isSmallPhone ? 52 : 56 }]}
                editable={!busy}
              />

              <FieldLabel label="Assistant name" />
              <TextInput
                value={assistantName}
                onChangeText={setAssistantNameInput}
                placeholder="Elli"
                placeholderTextColor="rgba(124, 99, 80, 0.52)"
                style={[styles.input, { height: isSmallPhone ? 52 : 56 }]}
                editable={!busy}
              />

              <View style={styles.tipCard}>
                <Ionicons name="sparkles-outline" size={16} color={Brand.bronze} />
                <Text style={styles.tipText}>
                  You can change the assistant name later in Settings.
                </Text>
              </View>

              <Pressable
                onPress={saveProfileAndContinue}
                style={({ pressed }) => [
                  styles.buttonShell,
                  pressed && styles.pressed,
                  busy && styles.disabled,
                ]}
                disabled={busy}
              >
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.primaryButton, { minHeight: isSmallPhone ? 54 : 58 }]}
                >
                  {busy ? (
                    <ActivityIndicator color={Brand.ink} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Continue</Text>
                      <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                    </>
                  )}
                </LinearGradient>
              </Pressable>
            </GlassCard>
          </View>
        </ScrollView>

        <Modal transparent visible={!!notice} animationType="fade" onRequestClose={closeNotice}>
          <View style={styles.noticeOverlay}>
            <GlassCard style={{ borderRadius: 28 }}>
              <View style={styles.noticeIconWrap}>
                <Ionicons name="information-circle" size={22} color={Brand.bronze} />
              </View>

              <Text style={styles.noticeTitle}>{notice?.title}</Text>
              <Text style={styles.noticeMessage}>{notice?.message}</Text>

              <View style={styles.noticeActions}>
                <Pressable onPress={closeNotice} style={styles.noticeSecondaryBtn}>
                  <Text style={styles.noticeSecondaryText}>Close</Text>
                </Pressable>

                {notice?.primaryLabel ? (
                  <Pressable
                    onPress={notice.onPrimaryPress || closeNotice}
                    style={styles.noticePrimaryBtn}
                  >
                    <Text style={styles.noticePrimaryText}>{notice.primaryLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            </GlassCard>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <Text style={styles.label}>{label}</Text>;
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 240,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  heroPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 16,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  progressWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },

  progressLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  progressValue: {
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "900",
  },

  label: {
    marginTop: 16,
    marginBottom: 8,
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
  },

  input: {
    borderRadius: 18,
    paddingHorizontal: 14,
    color: Brand.ink,
    fontSize: 15,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  readonlyBox: {
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  readonlyText: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "600",
  },

  tipCard: {
    marginTop: 16,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  tipText: {
    flex: 1,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  buttonShell: {
    borderRadius: 18,
    overflow: "hidden",
    marginTop: 22,
  },

  primaryButton: {
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  disabled: {
    opacity: 0.7,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },

  noticeOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
    backgroundColor: "rgba(72, 46, 18, 0.18)",
  },

  noticeIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  noticeTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 22,
    fontWeight: "900",
  },

  noticeMessage: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  noticeActions: {
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },

  noticeSecondaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  noticeSecondaryText: {
    color: Brand.cocoa,
    fontWeight: "800",
    fontSize: 14,
  },

  noticePrimaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#efbf7c",
  },

  noticePrimaryText: {
    color: Brand.ink,
    fontWeight: "900",
    fontSize: 14,
  },
});