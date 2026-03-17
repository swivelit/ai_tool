import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import { apiGet, API_BASE } from "@/lib/api";
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function RoutineScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const {
    user,
    signOutUser,
    deleteCurrentAccount,
    linkPasswordForCurrentUser,
    passwordLinked,
    googleLinked,
  } = useAuth();

  const {
    userId,
    name,
    settings,
    profile,
    refresh,
    updateName,
    updateSettings,
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

  const [assistantNameInput, setAssistantNameInput] = useState(name || "Elli");
  const [tone, setTone] = useState<"pro" | "friendly">(settings.tone);
  const [languageMode, setLanguageMode] = useState<"en" | "ta">(settings.languageMode);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [linkingPassword, setLinkingPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const bottomPadding = Math.max(insets.bottom + 28, 28);
  const heroTitleSize = isVerySmallPhone ? 24 : isSmallPhone ? 28 : 31;
  const heroTitleLineHeight = heroTitleSize + 5;
  const metricCardHeight = clamp(height * 0.11, 78, 94);

  useEffect(() => {
    setAssistantNameInput(name || "Elli");
  }, [name]);

  useEffect(() => {
    setTone(settings.tone);
    setLanguageMode(settings.languageMode);
  }, [settings.languageMode, settings.tone]);

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

  const signInMethods = useMemo(() => {
    const methods: string[] = [];
    if (googleLinked) methods.push("Google");
    if (passwordLinked) methods.push("Email/password");
    return methods.length ? methods.join(", ") : "Not linked";
  }, [googleLinked, passwordLinked]);

  const targetUserId =
    resolvedUserId || userId || profile?.userId || resolvedProfile?.userId || null;

  const preferencesDirty =
    assistantNameInput.trim() !== (name || "Elli").trim() ||
    tone !== settings.tone ||
    languageMode !== settings.languageMode;

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
        // keep defaults
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
            await refresh();
            router.replace("/");
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
              await refresh();
              router.replace("/");
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
      showNotice("Already linked", "This account already supports email/password login.");
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

  async function savePreferences() {
    const trimmedName = assistantNameInput.trim();

    if (savingPreferences) return;

    if (trimmedName.length < 2) {
      showNotice("Invalid name", "Assistant name should be at least 2 characters.");
      return;
    }

    try {
      setSavingPreferences(true);

      if (trimmedName !== (name || "Elli").trim()) {
        await updateName(trimmedName);
      }

      if (tone !== settings.tone || languageMode !== settings.languageMode) {
        await updateSettings({
          tone,
          languageMode,
        });
      }

      await refresh();
      showNotice(
        "Preferences saved",
        "Your assistant preferences have been updated successfully."
      );
    } catch (error: any) {
      showNotice(
        "Save failed",
        error?.message || "Could not save assistant preferences."
      );
    } finally {
      setSavingPreferences(false);
    }
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
      setSavingRoutine(true);

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
      showNotice("Routine saved", "Your daily routine was updated successfully.");
    } catch (error: any) {
      showNotice("Save failed", error?.message || "Could not save routine.");
    } finally {
      setSavingRoutine(false);
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

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingTop: topPadding,
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomPadding,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topBar}>
          <Pressable style={styles.topIconBtn} onPress={() => router.replace("/(tabs)")}>
            <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
          </Pressable>

          <View style={styles.topCenter}>
            <Text style={styles.topCaption}>Workspace</Text>
            <Text style={styles.topTitle}>Settings</Text>
          </View>

          <Pressable style={styles.topIconBtn} onPress={handleSignOut} disabled={signingOut}>
            {signingOut ? (
              <ActivityIndicator size="small" color={Brand.cocoa} />
            ) : (
              <Ionicons name="log-out-outline" size={18} color={Brand.cocoa} />
            )}
          </Pressable>
        </View>

        <GlassCard style={{ borderRadius: 30, marginTop: 14 }}>
          <View style={styles.heroHeaderRow}>
            <View style={styles.heroPill}>
              <Ionicons name="settings-outline" size={14} color={Brand.bronze} />
              <Text style={styles.heroPillText}>Assistant control center</Text>
            </View>

            <View style={styles.heroStatusChip}>
              {loading ? (
                <ActivityIndicator size="small" color={Brand.bronze} />
              ) : (
                <Ionicons name="checkmark-circle" size={14} color={Brand.success} />
              )}
              <Text style={styles.heroStatusText}>{loading ? "Loading" : "Ready"}</Text>
            </View>
          </View>

          <Text
            style={[
              styles.heroTitle,
              {
                fontSize: heroTitleSize,
                lineHeight: heroTitleLineHeight,
              },
            ]}
          >
            Personalize the assistant, secure your account, and shape your daily routine.
          </Text>

          <Text style={styles.heroSubtitle}>
            Everything here is designed to feel cleaner, warmer, and more premium while keeping
            your real settings workflow intact.
          </Text>

          <View style={styles.metricRow}>
            <MetricCard label="Assistant" value={name || "Elli"} minHeight={metricCardHeight} />
            <MetricCard label="Language" value={languageMode === "ta" ? "Tamil" : "English"} minHeight={metricCardHeight} />
            <MetricCard label="Auth" value={googleLinked || passwordLinked ? "Linked" : "Basic"} minHeight={metricCardHeight} />
          </View>
        </GlassCard>

        <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Assistant preferences</Text>
              <Text style={styles.sectionSubtitle}>
                Fine-tune how your assistant looks and responds.
              </Text>
            </View>
            <View style={styles.sectionBadge}>
              <Text style={styles.sectionBadgeText}>Brand</Text>
            </View>
          </View>

          <Field
            label="Assistant name"
            value={assistantNameInput}
            onChangeText={setAssistantNameInput}
            placeholder="Elli"
          />

          <View style={{ marginTop: 18 }}>
            <Text style={styles.fieldLabel}>Tone</Text>
            <View style={styles.choiceRow}>
              <ChoiceChip
                label="Professional"
                active={tone === "pro"}
                onPress={() => setTone("pro")}
              />
              <ChoiceChip
                label="Friendly"
                active={tone === "friendly"}
                onPress={() => setTone("friendly")}
              />
            </View>
          </View>

          <View style={{ marginTop: 18 }}>
            <Text style={styles.fieldLabel}>Reply language</Text>
            <View style={styles.choiceRow}>
              <ChoiceChip
                label="Tamil"
                active={languageMode === "ta"}
                onPress={() => setLanguageMode("ta")}
              />
              <ChoiceChip
                label="English"
                active={languageMode === "en"}
                onPress={() => setLanguageMode("en")}
              />
            </View>
          </View>

          <Pressable
            onPress={savePreferences}
            disabled={savingPreferences || !preferencesDirty}
            style={({ pressed }) => [
              styles.primaryButtonShell,
              (!preferencesDirty || savingPreferences) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <LinearGradient
              colors={Brand.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.primaryButton}
            >
              {savingPreferences ? (
                <ActivityIndicator color={Brand.ink} />
              ) : (
                <>
                  <Text style={styles.primaryButtonText}>Save assistant preferences</Text>
                  <Ionicons name="sparkles" size={16} color={Brand.ink} />
                </>
              )}
            </LinearGradient>
          </Pressable>
        </GlassCard>

        <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Account & security</Text>
              <Text style={styles.sectionSubtitle}>
                Review linked sign-in methods and keep access secure.
              </Text>
            </View>
            <View style={styles.sectionBadge}>
              <Text style={styles.sectionBadgeText}>Secure</Text>
            </View>
          </View>

          <View style={styles.infoGrid}>
            <InfoCard label="Name" value={accountName} />
            <InfoCard label="Email" value={user?.email || "Not set"} />
            <InfoCard label="Place" value={accountPlace} />
            <InfoCard label="Timezone" value={accountTimezone} />
          </View>

          <View style={styles.inlineStatusRow}>
            <StatusChip
              icon="logo-google"
              label={googleLinked ? "Google linked" : "Google not linked"}
              positive={googleLinked}
            />
            <StatusChip
              icon="mail-outline"
              label={passwordLinked ? "Email/password linked" : "Email/password not linked"}
              positive={passwordLinked}
            />
          </View>

          <View style={styles.helperPanel}>
            <Text style={styles.helperPanelTitle}>Sign-in methods</Text>
            <Text style={styles.helperPanelText}>{signInMethods}</Text>
          </View>

          {!passwordLinked ? (
            <>
              <Field
                label="New password"
                value={password}
                onChangeText={setPassword}
                placeholder="Minimum 6 characters"
                secureTextEntry
              />

              <Field
                label="Confirm password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Repeat password"
                secureTextEntry
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
                  <ActivityIndicator color={Brand.ink} />
                ) : (
                  <>
                    <Ionicons name="shield-checkmark-outline" size={16} color={Brand.ink} />
                    <Text style={styles.secondaryButtonText}>Add email/password login</Text>
                  </>
                )}
              </Pressable>
            </>
          ) : (
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={18} color={Brand.success} />
              <Text style={styles.successBannerText}>
                This account already supports email/password login.
              </Text>
            </View>
          )}
        </GlassCard>

        <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Daily routine</Text>
              <Text style={styles.sectionSubtitle}>
                Shape reminders and planning around your real schedule.
              </Text>
            </View>
            <View style={styles.sectionBadge}>
              <Text style={styles.sectionBadgeText}>Routine</Text>
            </View>
          </View>

          <View style={styles.twoColRow}>
            <View style={{ flex: 1 }}>
              <Field
                label="Wake time"
                value={routine.wake_time}
                onChangeText={(v) => setRoutine((prev) => ({ ...prev, wake_time: v }))}
                placeholder="07:30"
              />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Field
                label="Sleep time"
                value={routine.sleep_time}
                onChangeText={(v) => setRoutine((prev) => ({ ...prev, sleep_time: v }))}
                placeholder="23:30"
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
              />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Field
                label="Work end"
                value={routine.work_end || ""}
                onChangeText={(v) => setRoutine((prev) => ({ ...prev, work_end: v }))}
                placeholder="18:30"
              />
            </View>
          </View>

          <Field
            label="Daily habits"
            value={routine.daily_habits || ""}
            onChangeText={(v) => setRoutine((prev) => ({ ...prev, daily_habits: v }))}
            placeholder="Gym, Water, Reading"
            multiline
            height={102}
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
              colors={Brand.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.primaryButton}
            >
              {savingRoutine || loading ? (
                <ActivityIndicator color={Brand.ink} />
              ) : (
                <>
                  <Text style={styles.primaryButtonText}>Save routine</Text>
                  <Ionicons name="checkmark" size={16} color={Brand.ink} />
                </>
              )}
            </LinearGradient>
          </Pressable>
        </GlassCard>

        <GlassCard style={{ borderRadius: 28, marginTop: 16, marginBottom: 10 }}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Danger zone</Text>
              <Text style={styles.sectionSubtitle}>
                Sensitive account actions live here.
              </Text>
            </View>
            <View style={[styles.sectionBadge, styles.dangerBadge]}>
              <Text style={[styles.sectionBadgeText, { color: Brand.danger }]}>Careful</Text>
            </View>
          </View>

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
              <ActivityIndicator color={Brand.cocoa} />
            ) : (
              <>
                <Ionicons name="log-out-outline" size={16} color={Brand.cocoa} />
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
              <ActivityIndicator color="#fff8f5" />
            ) : (
              <>
                <Ionicons name="trash-outline" size={16} color="#fff8f5" />
                <Text style={styles.dangerButtonText}>Delete account permanently</Text>
              </>
            )}
          </Pressable>
        </GlassCard>
      </ScrollView>

      <Modal
        transparent
        visible={!!notice}
        animationType="fade"
        onRequestClose={closeNotice}
      >
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
    </LinearGradient>
  );
}

function MetricCard({
  label,
  value,
  minHeight,
}: {
  label: string;
  value: string;
  minHeight: number;
}) {
  return (
    <View style={[styles.metricCard, { minHeight }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoCardLabel}>{label}</Text>
      <Text style={styles.infoCardValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function StatusChip({
  icon,
  label,
  positive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  positive: boolean;
}) {
  return (
    <View
      style={[
        styles.statusChip,
        positive ? styles.statusChipPositive : styles.statusChipNeutral,
      ]}
    >
      <Ionicons
        name={icon}
        size={14}
        color={positive ? Brand.success : Brand.cocoa}
      />
      <Text
        style={[
          styles.statusChipText,
          { color: positive ? Brand.success : Brand.cocoa },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function ChoiceChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceChip,
        active && styles.choiceChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.choiceChipText, active && styles.choiceChipTextActive]}>
        {label}
      </Text>
    </Pressable>
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
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
  height?: number;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(124, 99, 80, 0.52)"
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        style={[
          styles.fieldInput,
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
    width: 210,
    height: 210,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 270,
    height: 270,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
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
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },

  topCaption: {
    color: Brand.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },

  topTitle: {
    marginTop: 2,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
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
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
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
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroTitle: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 10,
    color: Brand.muted,
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
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    justifyContent: "space-between",
  },

  metricLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  metricValue: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  sectionBadge: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  dangerBadge: {
    backgroundColor: "rgba(185, 98, 72, 0.10)",
    borderColor: "rgba(185, 98, 72, 0.18)",
  },

  sectionBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },

  fieldLabel: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
  },

  fieldInput: {
    borderRadius: 18,
    paddingHorizontal: 14,
    color: Brand.ink,
    fontSize: 15,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  choiceChip: {
    minWidth: 110,
    height: 42,
    paddingHorizontal: 16,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.60)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  choiceChipActive: {
    backgroundColor: "rgba(255,229,180,0.82)",
    borderColor: "rgba(185,120,54,0.22)",
  },

  choiceChipText: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
  },

  choiceChipTextActive: {
    color: Brand.ink,
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

  secondaryButton: {
    minHeight: 52,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.80)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  secondaryButtonText: {
    color: Brand.ink,
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

  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 18,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 92,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoCardLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  infoCardValue: {
    marginTop: 8,
    color: Brand.ink,
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
    backgroundColor: "rgba(255,255,255,0.58)",
    borderColor: Brand.line,
  },

  statusChipText: {
    fontSize: 12,
    fontWeight: "800",
  },

  helperPanel: {
    marginTop: 16,
    borderRadius: 18,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  helperPanelTitle: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "900",
  },

  helperPanelText: {
    marginTop: 6,
    color: Brand.muted,
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
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },

  twoColRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  dangerGhostButton: {
    minHeight: 50,
    marginTop: 18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  dangerGhostButtonText: {
    color: Brand.cocoa,
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
    backgroundColor: Brand.danger,
  },

  dangerButtonText: {
    color: "#fff8f5",
    fontSize: 14,
    fontWeight: "900",
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
    fontSize: 14,
    fontWeight: "800",
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
    fontSize: 14,
    fontWeight: "900",
  },
});