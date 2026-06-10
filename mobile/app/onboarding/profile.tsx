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
import { Screen } from "@/components/ui";
import { Brand, Elevation, Radius, Spacing, Type } from "@/constants/theme";

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

  const provider = "password" as const;
  const providerLabel = user?.emailVerified ? "Email verified" : "Email & password";
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

      await setAssistantName(normalizedProfile.assistantName);
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
    <Screen safeArea={false} style={styles.page}>
      <StatusBar style="light" />

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
                onPress={() => router.replace("/auth/login")}
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
                Set up your profile
              </Text>

              <Text style={styles.subtitle}>
                Tell {assistantName || "Elli"} a little about you.
              </Text>

              <View style={styles.metricRow}>
                <MetricCard label="Progress" value={profileCompletion} icon="flash-outline" />
                <MetricCard label="Timezone" value="IST" icon="earth-outline" />
                <MetricCard label="Language" value={settings.languageMode.toUpperCase()} icon="language-outline" />
              </View>

              <LinearGradient
                colors={["rgba(40, 87, 215, 0.18)", "rgba(8, 11, 16, 0.55)"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.previewCard}
              >
                <View style={styles.previewBadge}>
                  <Ionicons name="sparkles" size={14} color={Brand.caramel} />
                  <Text style={styles.previewBadgeText}>How it will sound</Text>
                </View>

                <Text style={styles.previewTitle}>{assistantName.trim() || "Elli"}</Text>
                <Text style={styles.previewText}>
                  “Hi {name.trim() || "there"} — ready when you are.”
                </Text>
              </LinearGradient>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Account</Text>
                  <Text style={styles.sectionSubtitle}>Pulled from your account.</Text>
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
                  icon={user?.emailVerified ? "shield-checkmark-outline" : "key-outline"}
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
                  <Text style={styles.sectionSubtitle}>Helps personalize your replies.</Text>
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
                    Pick any name — you can change it later.
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
            <GlassCard style={{ borderRadius: Radius.xxl }}>
              <View style={styles.noticeIconWrap}>
                <Ionicons name="information-circle" size={22} color={Brand.caramel} />
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
    </Screen>
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
        placeholderTextColor="rgba(226, 238, 255, 0.42)"
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
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topBarPillText: {
    ...Type.caption,
    fontWeight: "700",
    color: Brand.cocoa,
  },

  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },

  heroPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    ...Type.caption,
    fontWeight: "700",
    color: Brand.cocoa,
  },

  heroStatusChip: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    ...Type.caption,
    fontWeight: "700",
    color: Brand.cocoa,
  },

  title: {
    marginTop: Spacing.lg,
    color: Brand.ink,
    fontWeight: "800",
    letterSpacing: -0.4,
  },

  subtitle: {
    ...Type.body,
    marginTop: Spacing.sm,
    color: Brand.muted,
  },

  metricRow: {
    marginTop: Spacing.xl,
    flexDirection: "row",
    gap: Spacing.sm,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.lg,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricIconWrap: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  metricValue: {
    ...Type.subheading,
    marginTop: Spacing.md,
    color: Brand.ink,
  },

  metricLabel: {
    ...Type.caption,
    fontWeight: "700",
    marginTop: Spacing.xs,
    color: Brand.muted,
  },

  previewCard: {
    marginTop: Spacing.lg,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(87, 222, 255, 0.18)",
  },

  previewBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadgeText: {
    ...Type.overline,
    color: Brand.cocoa,
  },

  previewTitle: {
    ...Type.subheading,
    marginTop: Spacing.md,
    color: Brand.ink,
  },

  previewText: {
    ...Type.caption,
    marginTop: Spacing.xs,
    color: Brand.muted,
    lineHeight: 20,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: Spacing.md,
  },

  sectionTitle: {
    ...Type.heading,
    color: Brand.ink,
  },

  sectionSubtitle: {
    ...Type.caption,
    marginTop: Spacing.xs,
    color: Brand.muted,
    maxWidth: 255,
  },

  sectionPill: {
    minHeight: 30,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sectionPillText: {
    ...Type.overline,
    color: Brand.cocoa,
  },

  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 106,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoIconWrap: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  infoLabel: {
    ...Type.caption,
    fontWeight: "700",
    marginTop: Spacing.md,
    color: Brand.muted,
  },

  infoValue: {
    ...Type.callout,
    fontWeight: "800",
    marginTop: Spacing.sm,
    color: Brand.ink,
  },

  label: {
    ...Type.caption,
    fontWeight: "700",
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
    color: Brand.cocoa,
  },

  inputShell: {
    borderRadius: Radius.md,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
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
    fontSize: Type.body.fontSize,
    paddingRight: Spacing.lg,
  },

  tipCard: {
    marginTop: Spacing.lg,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.md,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  tipIconWrap: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  tipTitle: {
    ...Type.callout,
    fontWeight: "800",
    color: Brand.ink,
  },

  tipText: {
    ...Type.caption,
    marginTop: Spacing.xs,
    color: Brand.muted,
  },

  buttonShell: {
    borderRadius: Radius.md,
    overflow: "hidden",
    marginTop: Spacing.xl,
  },

  primaryButton: {
    borderRadius: Radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    ...Elevation.glow,
  },

  primaryButtonText: {
    ...Type.subheading,
    color: Brand.ink,
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
    paddingHorizontal: Spacing.lg,
    backgroundColor: Brand.overlay,
  },

  noticeIconWrap: {
    width: 42,
    height: 42,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  noticeTitle: {
    ...Type.title,
    marginTop: Spacing.md,
    color: Brand.ink,
  },

  noticeMessage: {
    ...Type.body,
    marginTop: Spacing.sm,
    color: Brand.muted,
  },

  noticeActions: {
    marginTop: Spacing.lg,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: Spacing.sm,
  },

  noticeSecondaryBtn: {
    minHeight: 46,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  noticeSecondaryText: {
    ...Type.callout,
    fontWeight: "700",
    color: Brand.cocoa,
  },

  noticePrimaryBtn: {
    minHeight: 46,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.bronze,
  },

  noticePrimaryText: {
    ...Type.callout,
    fontWeight: "800",
    color: Brand.ink,
  },
});
