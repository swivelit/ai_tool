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
  const maxFormWidth = Math.min(width - horizontalPadding * 2, 560);

  const provider = useMemo(() => {
    if (user?.providerData?.some((item) => item.providerId === "google.com")) {
      return "google" as const;
    }
    return "password" as const;
  }, [user?.providerData]);

  const providerLabel = provider === "google" ? "Google sign-in" : "Email & password";
  const profileCompletion = useMemo(() => {
    let score = 25;
    if (name.trim()) score += 25;
    if (assistantName.trim()) score += 25;
    if (place.trim()) score += 15;
    if (user?.email) score += 10;
    return `${Math.min(score, 100)}%`;
  }, [assistantName, name, place, user?.email]);

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

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
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
            <View style={styles.topBar}>
              <View style={styles.topBarPill}>
                <Ionicons name="layers-outline" size={14} color={Brand.bronze} />
                <Text style={styles.topBarPillText}>Let’s begin</Text>
              </View>

              <Pressable
                onPress={() => router.replace("/")}
                style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
              >
                <Ionicons name="close-outline" size={18} color={Brand.cocoa} />
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.heroPill}>
                  <Ionicons name="person-circle-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroPillText}>Profile setup</Text>
                </View>

                <View style={styles.heroStatusChip}>
                  <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroStatusText}>Step 1 of 2</Text>
                </View>
              </View>

              <Text
                style={[
                  styles.title,
                  {
                    fontSize: isVerySmallPhone ? 28 : isSmallPhone ? 31 : 36,
                    lineHeight: isVerySmallPhone ? 34 : isSmallPhone ? 37 : 42,
                  },
                ]}
              >
                Complete your profile to get started.
              </Text>

              <Text style={styles.subtitle}>
                Tell {assistantName || "Elli"} a little about you to make 
                every response more useful.
              </Text>

              <View style={styles.metricRow}>
                <MetricCard label="Progress" value={profileCompletion} icon="flash-outline" />
                <MetricCard label="Timezone" value="IST" icon="earth-outline" />
                <MetricCard label="Language" value={settings.languageMode.toUpperCase()} icon="language-outline" />
              </View>

              <LinearGradient
                colors={["rgba(255,255,255,0.84)", "rgba(255,239,210,0.66)"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.previewCard}
              >
                <View style={styles.previewBadge}>
                  <Ionicons name="sparkles" size={14} color={Brand.bronze} />
                  <Text style={styles.previewBadgeText}>How it will sound</Text>
                </View>

                <Text style={styles.previewTitle}>{assistantName.trim() || "Elli"}</Text>
                <Text style={styles.previewText}>
                  “Hi {name.trim() || "there"}, I am ready to help with your day.”
                </Text>
              </LinearGradient>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Account</Text>
                  <Text style={styles.sectionSubtitle}>
                    Your account information is ready to go.
                  </Text>
                </View>
                <SectionPill label="Secure" />
              </View>

              <View style={styles.infoGrid}>
                <ReadonlyInfoCard
                  label="Email"
                  value={user?.email || "-"}
                  icon="mail-outline"
                />
                <ReadonlyInfoCard
                  label="Sign-in"
                  value={providerLabel}
                  icon={provider === "google" ? "logo-google" : "key-outline"}
                />
                <ReadonlyInfoCard
                  label="Timezone"
                  value="Asia/Kolkata"
                  icon="time-outline"
                />
                <ReadonlyInfoCard
                  label="Reply mode"
                  value={settings.languageMode === "ta" ? "Tamil" : "English"}
                  icon="chatbubble-ellipses-outline"
                />
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Personal details</Text>
                  <Text style={styles.sectionSubtitle}>
                    This information helps personalize your experience.
                  </Text>
                </View>
                <SectionPill label="Required" />
              </View>

              <FieldLabel label="Your name" />
              <InputField
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                icon="person-outline"
                editable={!busy}
                compact={isSmallPhone}
              />

              <FieldLabel label="Place" />
              <InputField
                value={place}
                onChangeText={setPlace}
                placeholder="City, area, or place (optional)"
                icon="location-outline"
                editable={!busy}
                compact={isSmallPhone}
              />

              <FieldLabel label="Assistant name" />
              <InputField
                value={assistantName}
                onChangeText={setAssistantNameInput}
                placeholder="Elli"
                icon="sparkles-outline"
                editable={!busy}
                compact={isSmallPhone}
              />

              <View style={styles.tipCard}>
                <View style={styles.tipIconWrap}>
                  <Ionicons name="bulb-outline" size={16} color={Brand.bronze} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tipTitle}>Quick tip</Text>
                  <Text style={styles.tipText}>
                    Pick a name you will enjoy using. You can update it anytime.
                  </Text>
                </View>
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
                      <Text style={styles.primaryButtonText}>Save and continue</Text>
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

function SectionPill({ label }: { label: string }) {
  return (
    <View style={styles.sectionPill}>
      <Text style={styles.sectionPillText}>{label}</Text>
    </View>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function ReadonlyInfoCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.infoCard}>
      <View style={styles.infoIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function InputField({
  value,
  onChangeText,
  placeholder,
  icon,
  editable,
  compact,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  icon: keyof typeof Ionicons.glyphMap;
  editable: boolean;
  compact: boolean;
}) {
  return (
    <View style={[styles.inputShell, { minHeight: compact ? 52 : 56 }]}>
      <View style={styles.inputIconWrap}>
        <Ionicons name={icon} size={16} color={Brand.bronze} />
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(124, 99, 80, 0.52)"
        style={styles.input}
        editable={editable}
      />
    </View>
  );
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

  topBar: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topBarPill: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topBarPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
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

  heroStatusChip: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricRow: {
    marginTop: 20,
    flexDirection: "row",
    gap: 10,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  metricValue: {
    marginTop: 12,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  metricLabel: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  previewCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  previewTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  previewText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 255,
  },

  sectionPill: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sectionPillText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },

  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 18,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 106,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  infoLabel: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  infoValue: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
  },

  label: {
    marginTop: 16,
    marginBottom: 8,
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
  },

  inputShell: {
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },

  inputIconWrap: {
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },

  input: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    paddingRight: 14,
  },

  tipCard: {
    marginTop: 16,
    borderRadius: 20,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  tipIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  tipTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  tipText: {
    marginTop: 4,
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
    shadowColor: "#d4934f",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
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