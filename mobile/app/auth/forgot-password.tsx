import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, Button, Screen } from "@/components/ui";
import { useAuth } from "@/components/AuthProvider";
import { Radius, Spacing, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { getPasswordVisibilityProps } from "@/lib/authUi";
import { hasValidPasswordLength, MIN_PASSWORD_LENGTH } from "@/lib/authValidation";

function emailLooksValid(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim());
}

export default function ForgotPasswordScreen() {
  const { requestPasswordResetOtp, confirmPasswordResetOtp } = useAuth();
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [stage, setStage] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isCompact = width < 370 || height < 760;
  const horizontalPadding = isCompact ? Spacing.lg : Spacing.xl;
  const topPadding = insets.top + (isCompact ? Spacing.sm : Spacing.lg);
  const bottomPadding = Math.max(insets.bottom + Spacing.xxl, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = 48;

  const newPasswordVisibility = getPasswordVisibilityProps(showNewPassword);
  const confirmPasswordVisibility = getPasswordVisibilityProps(showConfirmPassword);
  const canSend = useMemo(() => email.trim().length > 0 && !busy, [busy, email]);
  const canConfirm = useMemo(
    () =>
      otp.trim().length === 6 &&
      newPassword.length > 0 &&
      confirmPassword.length > 0 &&
      !busy,
    [busy, confirmPassword, newPassword, otp]
  );

  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const timer = setInterval(() => {
      setCooldownRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownRemaining]);

  async function handleSendOtp() {
    const nextEmail = email.trim();
    if (!emailLooksValid(nextEmail)) {
      setErrorText("That email doesn’t look right.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      setSuccessText("");
      const response = await requestPasswordResetOtp(nextEmail);
      setCooldownRemaining(response.cooldown_seconds || 60);
      setStage("reset");
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Could not send reset code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmReset() {
    const nextEmail = email.trim();
    const normalizedOtp = otp.trim();

    if (!emailLooksValid(nextEmail)) {
      setErrorText("That email doesn’t look right.");
      return;
    }

    if (!/^\d{6}$/.test(normalizedOtp)) {
      setErrorText("Enter the 6-digit code we emailed you.");
      return;
    }

    if (!hasValidPasswordLength(newPassword)) {
      setErrorText(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorText("Those passwords don’t match.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await confirmPasswordResetOtp(nextEmail, normalizedOtp, newPassword);
      setSuccessText("Password updated. Sign in to continue.");
      setTimeout(() => router.replace("/auth/login"), 900);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Password reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen safeArea={false}>
      <StatusBar style={isDark ? "light" : "dark"} />

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
            justifyContent: height > 780 ? "center" : "flex-start",
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.content, { maxWidth: contentMaxWidth }]}>
            <Pressable
              onPress={() => router.replace("/auth/login")}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-back" size={18} color={t.cocoa} />
              <AppText variant="callout" color="muted">
                Back
              </AppText>
            </Pressable>

            <View style={styles.brandBlock}>
              <AppText variant="overline" color="accent">
                ACCOUNT
              </AppText>
              <AppText variant="title" style={styles.heroTitle}>
                Reset password
              </AppText>
            </View>

            <View style={styles.card}>
              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle-outline" size={16} color={t.danger} />
                  <AppText variant="caption" style={styles.errorText}>
                    {errorText}
                  </AppText>
                </View>
              ) : null}

              {successText ? (
                <View style={styles.successCard}>
                  <Ionicons name="checkmark-circle-outline" size={16} color={t.success} />
                  <AppText variant="caption" style={styles.successText}>
                    {successText}
                  </AppText>
                </View>
              ) : null}

              <View style={{ marginTop: errorText || successText ? Spacing.lg : 0 }}>
                <AppText variant="caption" color="muted" style={styles.label}>
                  Email
                </AppText>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons name="mail-outline" size={16} color={t.caramel} />
                  </View>
                  <TextInput
                    value={email}
                    testID="forgot-password-email-input"
                    accessibilityLabel="forgot-password-email-input"
                    onChangeText={(value) => {
                      setEmail(value);
                      if (errorText) setErrorText("");
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    autoComplete="email"
                    textContentType="username"
                    placeholder="you@example.com"
                    placeholderTextColor={t.placeholder}
                    style={styles.input}
                    editable={!busy && stage === "email"}
                    returnKeyType="go"
                    onSubmitEditing={handleSendOtp}
                  />
                </View>
              </View>

              {stage === "email" ? (
                <Button
                  label="Send reset code"
                  iconRight="arrow-forward"
                  onPress={handleSendOtp}
                  loading={busy}
                  disabled={!canSend}
                  size="lg"
                  style={styles.submit}
                  testID="forgot-password-send-otp-button"
                  accessibilityLabel="forgot-password-send-otp-button"
                />
              ) : (
                <>
                  <View style={styles.infoBanner}>
                    <Ionicons name="mail-unread-outline" size={16} color={t.caramel} />
                    <AppText variant="caption" style={styles.infoBannerText}>
                      If that email has an account, a code is on its way.
                    </AppText>
                  </View>

                  <View style={{ marginTop: Spacing.lg }}>
                    <AppText variant="caption" color="muted" style={styles.label}>
                      Reset code
                    </AppText>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="keypad-outline" size={16} color={t.caramel} />
                      </View>
                      <TextInput
                        value={otp}
                        testID="forgot-password-otp-input"
                        accessibilityLabel="forgot-password-otp-input"
                        onChangeText={(value) => {
                          setOtp(value.replace(/\D/g, "").slice(0, 6));
                          if (errorText) setErrorText("");
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="number-pad"
                        textContentType="oneTimeCode"
                        placeholder="123456"
                        placeholderTextColor={t.placeholder}
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="next"
                      />
                    </View>
                  </View>

                  <PasswordField
                    label="New password"
                    value={newPassword}
                    onChangeText={(value) => {
                      setNewPassword(value);
                      if (errorText) setErrorText("");
                    }}
                    testID="forgot-password-new-password-input"
                    visibility={newPasswordVisibility}
                    onToggleVisibility={() => setShowNewPassword((value) => !value)}
                    editable={!busy}
                    inputHeight={inputHeight}
                  />

                  <PasswordField
                    label="Confirm password"
                    value={confirmPassword}
                    onChangeText={(value) => {
                      setConfirmPassword(value);
                      if (errorText) setErrorText("");
                    }}
                    testID="forgot-password-confirm-password-input"
                    visibility={confirmPasswordVisibility}
                    onToggleVisibility={() => setShowConfirmPassword((value) => !value)}
                    editable={!busy}
                    inputHeight={inputHeight}
                    onSubmitEditing={handleConfirmReset}
                  />

                  <AppText variant="caption" color="muted" style={styles.cooldownText}>
                    {cooldownRemaining > 0
                      ? `Request another code in ${cooldownRemaining}s.`
                      : "Need another code? Resend anytime."}
                  </AppText>

                  <Button
                    label="Reset password"
                    iconRight="checkmark"
                    onPress={handleConfirmReset}
                    loading={busy}
                    disabled={!canConfirm}
                    size="lg"
                    style={styles.submit}
                    testID="forgot-password-confirm-button"
                    accessibilityLabel="forgot-password-confirm-button"
                  />
                </>
              )}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function PasswordField({
  label,
  value,
  onChangeText,
  testID,
  visibility,
  onToggleVisibility,
  editable,
  inputHeight,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  testID: string;
  visibility: ReturnType<typeof getPasswordVisibilityProps>;
  onToggleVisibility: () => void;
  editable: boolean;
  inputHeight: number;
  onSubmitEditing?: () => void;
}) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={{ marginTop: Spacing.lg }}>
      <AppText variant="caption" color="muted" style={styles.label}>
        {label}
      </AppText>
      <View style={[styles.inputShell, { minHeight: inputHeight }]}>
        <View style={styles.inputIconWrap}>
          <Ionicons name="shield-checkmark-outline" size={16} color={t.caramel} />
        </View>
        <TextInput
          value={value}
          testID={testID}
          accessibilityLabel={testID}
          onChangeText={onChangeText}
          secureTextEntry={visibility.secureTextEntry}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
          placeholderTextColor={t.placeholder}
          style={styles.input}
          editable={editable}
          returnKeyType={onSubmitEditing ? "go" : "next"}
          onSubmitEditing={onSubmitEditing}
        />
        <Pressable
          onPress={onToggleVisibility}
          style={styles.visibilityBtn}
          accessibilityRole="button"
          accessibilityLabel={visibility.accessibilityLabel}
          accessibilityHint={visibility.accessibilityHint}
          hitSlop={10}
        >
          <Ionicons name={visibility.iconName} size={18} color={t.cocoa} />
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(t: Palette) {
  return StyleSheet.create({
  page: {
    flex: 1,
  },
  content: {
    width: "100%",
    alignSelf: "center",
  },
  backButton: {
    alignSelf: "flex-start",
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },
  brandBlock: {
    gap: Spacing.sm,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  heroTitle: {
    color: t.ink,
  },
  card: {
    borderRadius: Radius.xxl,
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: "rgba(255, 138, 138, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 138, 138, 0.32)",
  },
  errorText: {
    flex: 1,
    color: "#ffb9b9",
  },
  successCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: "rgba(125, 226, 173, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(125, 226, 173, 0.30)",
  },
  successText: {
    flex: 1,
    color: t.success,
    fontWeight: "700",
  },
  label: {
    marginBottom: Spacing.sm,
  },
  inputShell: {
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: t.lineStrong,
    backgroundColor: t.surface,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  inputIconWrap: {
    width: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    color: t.ink,
    fontSize: 15,
    paddingRight: Spacing.md,
  },
  visibilityBtn: {
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  infoBanner: {
    marginTop: Spacing.lg,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.sm,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: t.accentSoft,
    borderWidth: 1,
    borderColor: t.accentSoft,
  },
  infoBannerText: {
    flex: 1,
    color: t.ink,
  },
  cooldownText: {
    marginTop: Spacing.md,
  },
  submit: {
    marginTop: Spacing.xl,
  },
  pressed: {
    opacity: 0.78,
  },
  });
}
