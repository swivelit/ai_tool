import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Screen } from "@/components/ui";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Radius, Spacing, Type, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { apiGet, apiPut } from "@/lib/api";
import { getProfileForFirebaseUid } from "@/lib/account";

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

function validateHHMM(v: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test((v || "").trim());
}


export default function SettingsModal() {
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const {
    user,
    signOutUser,
    deleteCurrentAccount,
    linkPasswordForCurrentUser,
    passwordLinked,
  } = useAuth();

  const {
    userId,
    name,
    profile,
    refresh,
  } = useAssistant();

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

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [linkingPassword, setLinkingPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isCompactSettingsLayout = width < 390;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const bottomPadding = Math.max(insets.bottom + 28, 28);

  const accountName = useMemo(
    () => resolvedProfile?.name || profile?.name || "Not set",
    [resolvedProfile, profile?.name]
  );

  const targetUserId =
    resolvedUserId || userId || profile?.userId || resolvedProfile?.userId || null;

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
        const localProfile = await getProfileForFirebaseUid(user?.uid, user?.email);
        if (!alive) return;

        const nextUserId = userId || profile?.userId || localProfile?.userId || null;
        const nextProfile =
          profile?.firebaseUid && user?.uid && profile.firebaseUid === user.uid
            ? profile
            : localProfile || profile || null;

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
  }, [profile, user?.email, user?.uid, userId]);

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
        // Keep defaults if backend routine is unavailable.
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

  async function handleSignOut() {
    if (signingOut) return;

    Alert.alert("Sign out", "Do you want to sign out from this account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        onPress: async () => {
          try {
            setSigningOut(true);
            await signOutUser();
            // Do not call refresh() here.
            // Do not call router.replace("/") here.
            // Root app/_layout.tsx RouteGate should handle the redirect.
          } catch (error: any) {
            showNotice("Sign out failed", error?.message || "Failed to sign out.");
          } finally {
            setSigningOut(false);
          }
        },
      },
    ]);
  }

  async function confirmDeleteAccount() {
    if (deleting) return;

    Alert.alert(
      "Delete account",
      "This will permanently delete your login and all app data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              setDeleting(true);
              await deleteCurrentAccount(targetUserId || undefined);
              // Do not call refresh() here.
              // Do not call router.replace("/") here.
              // Root app/_layout.tsx RouteGate should handle the redirect.
            } catch (error: any) {
              showNotice("Delete failed", error?.message || "Failed to delete account.");
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  async function handleAddPasswordLogin() {
    if (linkingPassword) return;

    if (!user?.email) {
      showNotice(
        "Email missing",
        "This account does not have an email address to attach a password to."
      );
      return;
    }

    if (passwordLinked) {
      showNotice("Already linked", "Password login is already on.");
      return;
    }

    if (password.trim().length < 6) {
      showNotice("Invalid password", "Password should be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      showNotice("Password mismatch", "Password and confirm password must match.");
      return;
    }

    try {
      setLinkingPassword(true);
      await linkPasswordForCurrentUser(
        password.trim(),
        accountName !== "Not set" ? accountName : undefined
      );
      setPassword("");
      setConfirmPassword("");
      await refresh();
      showNotice(
        "Password login added",
        "You can now log in with this email and password without using Google."
      );
    } catch (error: any) {
      showNotice(
        "Couldn’t add password login",
        error?.message || "Failed to link password login."
      );
    } finally {
      setLinkingPassword(false);
    }
  }

  async function saveRoutine() {
    if (!resolvedUserId) {
      showNotice(
        "Profile missing",
        "Your profile is not complete yet. Please finish setup first.",
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
      setSavingRoutine(true);

      const payload = {
        wake_time: routine.wake_time.trim(),
        sleep_time: routine.sleep_time.trim(),
        work_start: routine.work_start?.trim() || null,
        work_end: routine.work_end?.trim() || null,
        daily_habits: routine.daily_habits?.trim() || null,
      };

      await apiPut(`/users/${resolvedUserId}/daily-routine`, payload);

      await refresh();
      showNotice("Routine saved", "Your daily routine was updated successfully.");
    } catch (error: any) {
      showNotice("Save failed", error?.message || "Could not save routine.");
    } finally {
      setSavingRoutine(false);
    }
  }

  return (
    <Screen safeArea={false} style={styles.page}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            paddingTop: topPadding,
            paddingHorizontal: horizontalPadding,
            paddingBottom: bottomPadding,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.topBar}>
            <Pressable style={styles.topIconBtn} onPress={() => router.back()}>
              <Ionicons name="sparkles-outline" size={18} color={t.cocoa} />
            </Pressable>

            <View style={styles.topCenter}>
              <Text style={styles.topTitle}>Settings</Text>
            </View>
          </View>

          <GlassCard style={{ borderRadius: 28, marginTop: 14 }}>
            <View style={styles.sectionHeaderRow}>
              <View>
                <Text style={styles.sectionTitle}>Customise</Text>
              </View>
            </View>

            <Pressable
              onPress={() => router.push("/customise")}
              style={({ pressed }) => [styles.accountHeroCard, pressed && styles.pressed]}
            >
              <View style={styles.accountAvatar}>
                <Ionicons name="color-palette-outline" size={22} color={t.ink} />
              </View>

              <View style={styles.accountHeroContent}>
                <Text style={styles.accountName}>{`Customise (${name || "Elli"})`}</Text>
              </View>

              <Ionicons name="chevron-forward" size={18} color={t.cocoa} />
            </Pressable>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Account</Text>

            <View style={styles.accountHeroCard}>
              <View style={styles.accountAvatar}>
                <Text style={styles.accountAvatarText}>
                  {(accountName || "U").trim().charAt(0).toUpperCase()}
                </Text>
              </View>

              <View style={styles.accountHeroContent}>
                <Text style={styles.accountName}>{accountName}</Text>
                <Text style={styles.accountEmail} numberOfLines={isCompactSettingsLayout ? 2 : 1}>
                  {user?.email || "No email attached"}
                </Text>
              </View>
            </View>

            {!passwordLinked ? (
              <>
                <Field
                  label="New password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Minimum 6 characters"
                  secureTextEntry
                  icon="shield-checkmark-outline"
                />

                <Field
                  label="Confirm password"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Repeat password"
                  secureTextEntry
                  icon="key-outline"
                />

                <Pressable
                  onPress={handleAddPasswordLogin}
                  disabled={linkingPassword}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    linkingPassword && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {linkingPassword ? (
                    <ActivityIndicator color={t.ink} />
                  ) : (
                    <>
                      <Ionicons
                        name="shield-checkmark-outline"
                        size={16}
                        color={t.ink}
                      />
                      <Text style={styles.secondaryButtonText}>
                        Add email/password login
                      </Text>
                    </>
                  )}
                </Pressable>
              </>
            ) : null}
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Routine</Text>

            <View style={styles.twoColRow}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Wake time"
                  value={routine.wake_time}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, wake_time: v }))}
                  placeholder="07:30"
                  icon="sunny-outline"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Sleep time"
                  value={routine.sleep_time}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, sleep_time: v }))}
                  placeholder="23:30"
                  icon="moon-outline"
                />
              </View>
            </View>

            <View style={styles.twoColRow}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Work start"
                  value={routine.work_start || ""}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_start: v }))}
                  placeholder="09:30"
                  icon="briefcase-outline"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Work end"
                  value={routine.work_end || ""}
                  onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_end: v }))}
                  placeholder="18:30"
                  icon="flag-outline"
                />
              </View>
            </View>

            <Field
              label="Daily habits"
              value={routine.daily_habits || ""}
              onChangeText={(v) => setRoutine((prev) => ({ ...prev, daily_habits: v }))}
              placeholder="Gym, Water, Reading"
              multiline
              height={104}
              icon="leaf-outline"
            />

            <Pressable
              onPress={saveRoutine}
              disabled={savingRoutine || loading}
              style={({ pressed }) => [
                styles.primaryButtonShell,
                (savingRoutine || loading) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <LinearGradient
                colors={t.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {savingRoutine || loading ? (
                  <ActivityIndicator color={t.ink} />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>Save routine</Text>
                    <Ionicons name="checkmark" size={16} color={t.ink} />
                  </>
                )}
              </LinearGradient>
            </Pressable>
          </GlassCard>

          <GlassCard style={{ borderRadius: 28, marginTop: 16, marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Account</Text>

            <Pressable
              onPress={handleSignOut}
              disabled={signingOut}
              style={({ pressed }) => [
                styles.dangerGhostButton,
                signingOut && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {signingOut ? (
                <ActivityIndicator color={t.cocoa} />
              ) : (
                <>
                  <Ionicons name="log-out-outline" size={16} color={t.cocoa} />
                  <Text style={styles.dangerGhostButtonText}>Sign out</Text>
                </>
              )}
            </Pressable>

            <Pressable
              onPress={confirmDeleteAccount}
              disabled={deleting}
              style={({ pressed }) => [
                styles.dangerButton,
                deleting && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {deleting ? (
                <ActivityIndicator color="#f7fbff" />
              ) : (
                <>
                  <Ionicons name="trash-outline" size={16} color="#f7fbff" />
                  <Text style={styles.dangerButtonText}>Delete account permanently</Text>
                </>
              )}
            </Pressable>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal transparent visible={!!notice} animationType="fade" onRequestClose={closeNotice}>
        <View style={styles.noticeOverlay}>
          <GlassCard style={{ borderRadius: 28 }}>
            <View style={styles.noticeIconWrap}>
              <Ionicons name="information-circle" size={22} color={t.bronze} />
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
    </Screen>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  height = 56,
  secureTextEntry = false,
  icon,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
  height?: number;
  secureTextEntry?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldShell, { minHeight: height }]}>
        <View style={styles.fieldIconWrap}>
          <Ionicons name={icon} size={16} color={t.bronze} />
        </View>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.placeholder}
          multiline={multiline}
          secureTextEntry={secureTextEntry}
          autoCapitalize="none"
          style={[
            styles.fieldInput,
            {
              minHeight: height,
              textAlignVertical: multiline ? "top" : "center",
              paddingTop: multiline ? 14 : 0,
            },
          ]}
        />
      </View>
    </View>
  );
}

function createStyles(t: Palette) {
  return StyleSheet.create({
  page: {
    flex: 1,
  },

  topBar: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topIconBtn: {
    width: 42,
    height: 42,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  topCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
  },

  topCaption: {
    ...Type.overline,
    color: t.muted,
    textTransform: "uppercase",
  },

  topTitle: {
    ...Type.subheading,
    marginTop: Spacing.xxs,
    color: t.ink,
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroPillText: {
    color: t.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroStatusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroStatusText: {
    color: t.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroTitle: {
    marginTop: 18,
    color: t.ink,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 10,
    color: t.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  metricIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  metricLabel: {
    marginTop: 12,
    color: t.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  metricValue: {
    marginTop: 8,
    color: t.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  heroInsightCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroInsightBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroInsightBadgeText: {
    color: t.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  heroInsightTitle: {
    marginTop: 14,
    color: t.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  heroInsightText: {
    marginTop: 6,
    color: t.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    ...Type.heading,
    color: t.ink,
  },

  sectionSubtitle: {
    ...Type.caption,
    marginTop: Spacing.xs,
    color: t.muted,
    lineHeight: 19,
    maxWidth: 260,
  },

  sectionBadge: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  dangerBadge: {
    backgroundColor: "rgba(255, 138, 138, 0.10)",
    borderColor: "rgba(255, 138, 138, 0.18)",
  },

  sectionBadgeText: {
    color: t.cocoa,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },

  dangerBadgeText: {
    color: t.danger,
  },

  fieldLabel: {
    color: t.cocoa,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
  },

  fieldShell: {
    borderRadius: 18,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
    flexDirection: "row",
    alignItems: "flex-start",
    overflow: "hidden",
  },

  fieldIconWrap: {
    width: 46,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
  },

  fieldInput: {
    flex: 1,
    paddingRight: 14,
    color: t.ink,
    fontSize: 15,
  },

  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  choiceCard: {
    flex: 1,
    minWidth: 140,
    borderRadius: 22,
    padding: 14,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  choiceCardActive: {
    backgroundColor: t.accentSoft,
    borderColor: t.accentSoft,
  },

  choiceCardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
  },

  choiceCardTitle: {
    marginTop: 12,
    color: t.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  choiceCardTitleActive: {
    color: t.ink,
  },

  choiceCardHelper: {
    marginTop: 5,
    color: t.muted,
    fontSize: 12,
    lineHeight: 18,
  },


  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  helperInlineText: {
    marginTop: 4,
    color: t.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  trainingInlineHint: {
    marginTop: 10,
    color: t.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  trainingScreen: {
    flex: 1,
  },

  trainingHeaderBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  trainingHeaderButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  trainingHeaderButtonPlaceholder: {
    width: 42,
    height: 42,
  },

  trainingHeaderTitle: {
    color: t.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  trainingHeroShell: {
    borderRadius: 30,
  },

  trainingHeroEyebrow: {
    color: t.bronze,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },

  trainingHeroTitle: {
    marginTop: 10,
    color: t.ink,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "900",
  },

  trainingHeroText: {
    marginTop: 10,
    color: t.muted,
    fontSize: 14,
    lineHeight: 21,
  },

  trainingStatusCardLarge: {
    marginTop: 18,
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.surface,
    alignItems: "center",
  },

  trainingStatusPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  trainingStatusPillActive: {
    backgroundColor: t.accentSoft,
    borderColor: t.accentSoft,
  },

  trainingStatusPillSuccess: {
    backgroundColor: "rgba(223,240,214,0.95)",
    borderColor: "rgba(111,140,94,0.28)",
  },

  trainingStatusPillError: {
    backgroundColor: t.surface,
    borderColor: "rgba(255, 138, 138,0.26)",
  },

  trainingStatusPillText: {
    color: t.ink,
    fontSize: 12,
    fontWeight: "900",
  },

  trainingMicHero: {
    marginTop: 18,
    marginBottom: 8,
  },

  trainingMicOuter: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  trainingMicOuterActive: {
    backgroundColor: t.accentSoft,
    borderColor: t.accentSoft,
  },

  trainingMicOuterSuccess: {
    backgroundColor: "rgba(223,240,214,0.86)",
    borderColor: "rgba(111,140,94,0.24)",
  },

  trainingMicOuterError: {
    backgroundColor: t.surface,
    borderColor: "rgba(255, 138, 138,0.22)",
  },

  trainingMicInner: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
  },

  trainingMicInnerActive: {
    backgroundColor: t.surface,
  },

  trainingMicInnerSuccess: {
    backgroundColor: "rgba(125,226,173,0.14)",
  },

  trainingMicInnerError: {
    backgroundColor: t.surface,
  },

  trainingStatusTitleLarge: {
    marginTop: 8,
    color: t.ink,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "900",
    textAlign: "center",
  },

  trainingStatusTextLarge: {
    marginTop: 8,
    color: t.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },

  trainingMeterTrack: {
    width: "100%",
    height: 12,
    borderRadius: 999,
    backgroundColor: t.surface,
    overflow: "hidden",
    marginTop: 18,
  },

  trainingMeterFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: t.caramel,
  },

  trainingMeterCaption: {
    marginTop: 8,
    color: t.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  trainingActionRow: {
    marginTop: 18,
    width: "100%",
    gap: 12,
  },

  trainingPrimaryButtonShell: {
    borderRadius: 18,
    overflow: "hidden",
  },

  trainingPrimaryButton: {
    minHeight: 56,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  trainingSecondaryButton: {
    minHeight: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },

  trainingInfoShell: {
    borderRadius: 26,
    marginTop: 14,
  },

  trainingInfoTitle: {
    color: t.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  trainingTranscriptValueLarge: {
    marginTop: 10,
    color: t.ink,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "800",
  },

  trainingTranscriptPlaceholder: {
    color: t.muted,
    fontWeight: "700",
  },

  trainingErrorBanner: {
    marginTop: 14,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: "rgba(255, 138, 138,0.22)",
  },

  trainingErrorBannerText: {
    flex: 1,
    color: t.danger,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "700",
  },

  trainingChecklist: {
    marginTop: 10,
    gap: 10,
  },

  trainingChecklistItem: {
    color: t.muted,
    fontSize: 14,
    lineHeight: 21,
  },

  trainingChecklistStrong: {
    color: t.ink,
    fontWeight: "900",
  },

  trainingResultCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.line,
    backgroundColor: t.surface,
    padding: 12,
  },

  trainingResultLabel: {
    color: t.muted,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  trainingResultValue: {
    marginTop: 6,
    color: t.ink,
    fontSize: 15,
    fontWeight: "800",
  },

  trainingSamplesTitle: {
    color: t.ink,
    fontSize: 13,
    fontWeight: "900",
  },

  sampleWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },

  samplePill: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  samplePillText: {
    color: t.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  primaryButtonShell: {
    borderRadius: 18,
    overflow: "hidden",
    marginTop: 22,
  },

  primaryButton: {
    minHeight: 54,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#57deff",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },

  primaryButtonText: {
    color: t.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  secondaryButton: {
    minHeight: 52,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },

  secondaryButtonText: {
    color: t.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  disabled: {
    opacity: 0.6,
  },

  pressed: {
    opacity: 0.94,
    transform: [{ scale: 0.995 }],
  },

  accountHeroCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  accountHeroContent: {
    flex: 1,
    minWidth: 0,
  },

  accountAvatar: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  accountAvatarText: {
    color: t.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  accountName: {
    color: t.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  accountEmail: {
    marginTop: 4,
    color: t.cocoa,
    fontSize: 13,
    fontWeight: "700",
  },

  accountMeta: {
    marginTop: 4,
    color: t.muted,
    fontSize: 12,
    fontWeight: "600",
  },

  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 16,
  },

  infoCard: {
    width: "48%",
    minWidth: 150,
    minHeight: 106,
    borderRadius: 20,
    padding: 14,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  infoCardFullWidth: {
    width: "100%",
    minWidth: "100%",
  },

  infoCardIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  infoCardLabel: {
    marginTop: 12,
    color: t.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  infoCardValue: {
    marginTop: 8,
    color: t.ink,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
  },

  inlineStatusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  statusChip: {
    minHeight: 38,
    maxWidth: "100%",
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
  },

  statusChipPositive: {
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  statusChipNeutral: {
    backgroundColor: t.surface,
    borderColor: t.line,
  },

  statusChipText: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "800",
  },

  helperPanel: {
    marginTop: 16,
    borderRadius: 18,
    padding: 14,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  helperPanelTitle: {
    color: t.cocoa,
    fontSize: 13,
    fontWeight: "900",
  },

  helperPanelText: {
    marginTop: 6,
    color: t.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  successBanner: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  successBannerText: {
    flex: 1,
    color: t.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },

  routinePreviewCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: t.line,
  },

  timelineRow: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 10,
  },

  timelinePoint: {
    flex: 1,
    alignItems: "center",
  },

  timelinePointIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  timelinePointLabel: {
    marginTop: 10,
    color: t.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  timelinePointValue: {
    marginTop: 6,
    color: t.ink,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
  },

  timelineDivider: {
    width: 1,
    marginVertical: 6,
    backgroundColor: t.accentSoft,
  },

  twoColRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  habitSummaryRow: {
    marginTop: 16,
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },

  miniStatCard: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 96,
    borderRadius: 20,
    padding: 12,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  miniStatIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  miniStatValue: {
    marginTop: 10,
    color: t.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  miniStatLabel: {
    marginTop: 4,
    color: t.muted,
    fontSize: 11,
    fontWeight: "700",
  },

  dangerGhostButton: {
    minHeight: 50,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },

  dangerGhostButtonText: {
    color: t.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  dangerButton: {
    minHeight: 52,
    marginTop: 12,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: t.danger,
  },

  dangerButtonText: {
    color: "#f7fbff",
    fontSize: 14,
    fontWeight: "900",
  },

  noticeOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
    backgroundColor: t.scrim,
  },

  noticeIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  noticeTitle: {
    marginTop: 14,
    color: t.ink,
    fontSize: 22,
    fontWeight: "900",
  },

  noticeMessage: {
    marginTop: 10,
    color: t.muted,
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
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },

  noticeSecondaryText: {
    color: t.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  noticePrimaryBtn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2857d7",
  },

  noticePrimaryText: {
    color: t.ink,
    fontSize: 14,
    fontWeight: "900",
  },
  });
}
