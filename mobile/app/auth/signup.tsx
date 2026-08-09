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

import { GlassCard } from "@/components/Glass";
import { AppText, Button, Screen } from "@/components/ui";
import { useAuth } from "@/components/AuthProvider";
import { Radius, Spacing, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { getPasswordVisibilityProps } from "@/lib/authUi";

function emailLooksValid(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim());
}

function passwordStrengthLabel(value: string) {
  if (!value) return "Add a password";
  if (value.length < 6) return "Too short";
  if (value.length < 9) return "Okay";
  return "Strong";
}

function passwordStrengthTone(value: string, t: Palette) {
  if (!value || value.length < 6) return t.danger;
  if (value.length < 9) return t.caramel;
  return t.success;
}

export default function SignupScreen() {
  const { requestSignupOtp, completeSignupWithOtp } = useAuth();
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"details" | "otp">("details");
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;

  const horizontalPadding = isCompact ? Spacing.lg : Spacing.xl;
  const topPadding = insets.top + (isCompact ? Spacing.sm : Spacing.lg);
  const bottomPadding = Math.max(insets.bottom + Spacing.xxl, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = isCompact ? 56 : 60;

  const canSendOtp = useMemo(() => {
    return (
      name.trim().length > 0 &&
      email.trim().length > 0 &&
      password.length > 0 &&
      confirmPassword.length > 0 &&
      !busy
    );
  }, [busy, confirmPassword, email, name, password]);

  const canComplete = useMemo(() => otp.trim().length === 6 && !busy, [busy, otp]);

  useEffect(() => {
    if (cooldownRemaining <= 0) {
      return;
    }

    const timer = setInterval(() => {
      setCooldownRemaining((value) => Math.max(0, value - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownRemaining]);

  function validateDetails() {
    const nextName = name.trim();
    const nextEmail = email.trim();

    if (!nextName || !nextEmail || !password || !confirmPassword) {
      setErrorText("Fill in all fields.");
      return;
    }

    if (nextName.length < 2) {
      setErrorText("Enter your name.");
      return;
    }

    if (!emailLooksValid(nextEmail)) {
      setErrorText("That email doesn’t look right.");
      return;
    }

    if (password.length < 6) {
      setErrorText("Use at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorText("Those passwords don’t match.");
      return null;
    }

    return { nextName, nextEmail };
  }

  async function handleSendOtp() {
    const valid = validateDetails();
    if (!valid) return;

    try {
      setBusy(true);
      setErrorText("");
      const response = await requestSignupOtp(valid.nextEmail, valid.nextName);
      setCooldownRemaining(response.cooldown_seconds || 60);
      setStage("otp");
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Could not send OTP.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResendOtp() {
    if (cooldownRemaining > 0 || busy) return;

    const valid = validateDetails();
    if (!valid) return;

    try {
      setBusy(true);
      setErrorText("");
      const response = await requestSignupOtp(valid.nextEmail, valid.nextName);
      setCooldownRemaining(response.cooldown_seconds || 60);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Could not resend OTP.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteSignup() {
    const valid = validateDetails();
    if (!valid) return;

    const normalizedOtp = otp.trim();
    if (!/^\d{6}$/.test(normalizedOtp)) {
      setErrorText("Enter the 6-digit code we emailed you.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await completeSignupWithOtp(
        valid.nextName,
        valid.nextEmail,
        password,
        normalizedOtp
      );
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Sign up failed.");
    } finally {
      setBusy(false);
    }
  }

  const passwordTone = passwordStrengthTone(password, t);
  const passwordLabel = passwordStrengthLabel(password);
  const passwordVisibility = getPasswordVisibilityProps(showPassword);
  const confirmPasswordVisibility = getPasswordVisibilityProps(showConfirmPassword);

  return (
    <Screen safeArea={false}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
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
                SWICO
              </AppText>
              <AppText variant="title" style={styles.heroTitle}>
                Create account
              </AppText>
            </View>

            <GlassCard style={styles.card}>
              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle-outline" size={16} color={t.danger} />
                  <AppText variant="caption" style={styles.errorText}>
                    {errorText}
                  </AppText>
                </View>
              ) : null}

              {stage === "details" ? (
                <>
                  <View style={{ marginTop: errorText ? Spacing.lg : 0 }}>
                    <AppText variant="caption" color="muted" style={styles.label}>
                      Name
                    </AppText>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="person-outline" size={16} color={t.caramel} />
                      </View>
                      <TextInput
                        value={name}
                        testID="signup-name-input"
                        accessibilityLabel="signup-name-input"
                        onChangeText={(value) => {
                          setName(value);
                          if (errorText) setErrorText("");
                        }}
                        placeholder="Your name"
                        placeholderTextColor={t.placeholder}
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="next"
                      />
                    </View>
                  </View>

                  <View style={{ marginTop: Spacing.lg }}>
                    <AppText variant="caption" color="muted" style={styles.label}>
                      Email
                    </AppText>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="mail-outline" size={16} color={t.caramel} />
                      </View>
                      <TextInput
                        value={email}
                        testID="signup-email-input"
                        accessibilityLabel="signup-email-input"
                        onChangeText={(value) => {
                          setEmail(value);
                          if (errorText) setErrorText("");
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        autoComplete="email"
                        textContentType="emailAddress"
                        placeholder="you@example.com"
                        placeholderTextColor={t.placeholder}
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="next"
                      />
                    </View>
                  </View>

                  <View style={{ marginTop: Spacing.lg }}>
                    <View style={styles.labelRow}>
                      <AppText variant="caption" color="muted" style={styles.label}>
                        Password
                      </AppText>
                      <AppText variant="caption" style={{ color: passwordTone }}>
                        {passwordLabel}
                      </AppText>
                    </View>

                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons
                          name="shield-checkmark-outline"
                          size={16}
                          color={t.caramel}
                        />
                      </View>
                      <TextInput
                        value={password}
                        testID="signup-password-input"
                        accessibilityLabel="signup-password-input"
                        onChangeText={(value) => {
                          setPassword(value);
                          if (errorText) setErrorText("");
                        }}
                        secureTextEntry={passwordVisibility.secureTextEntry}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="new-password"
                        textContentType="newPassword"
                        placeholder="Minimum 6 characters"
                        placeholderTextColor={t.placeholder}
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="next"
                      />
                      <Pressable
                        onPress={() => setShowPassword((prev) => !prev)}
                        style={styles.visibilityBtn}
                        accessibilityRole="button"
                        accessibilityLabel={passwordVisibility.accessibilityLabel}
                        accessibilityHint={passwordVisibility.accessibilityHint}
                        hitSlop={10}
                      >
                        <Ionicons
                          name={passwordVisibility.iconName}
                          size={18}
                          color={t.cocoa}
                        />
                      </Pressable>
                    </View>
                  </View>

                  <View style={{ marginTop: Spacing.lg }}>
                    <AppText variant="caption" color="muted" style={styles.label}>
                      Confirm password
                    </AppText>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="key-outline" size={16} color={t.caramel} />
                      </View>
                      <TextInput
                        value={confirmPassword}
                        testID="signup-confirm-password-input"
                        accessibilityLabel="signup-confirm-password-input"
                        onChangeText={(value) => {
                          setConfirmPassword(value);
                          if (errorText) setErrorText("");
                        }}
                        secureTextEntry={confirmPasswordVisibility.secureTextEntry}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="Re-enter password"
                        placeholderTextColor={t.placeholder}
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="go"
                        onSubmitEditing={handleSendOtp}
                      />
                      <Pressable
                        onPress={() => setShowConfirmPassword((prev) => !prev)}
                        style={styles.visibilityBtn}
                        accessibilityRole="button"
                        accessibilityLabel={confirmPasswordVisibility.accessibilityLabel}
                        accessibilityHint={confirmPasswordVisibility.accessibilityHint}
                        hitSlop={10}
                      >
                        <Ionicons
                          name={confirmPasswordVisibility.iconName}
                          size={18}
                          color={t.cocoa}
                        />
                      </Pressable>
                    </View>
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.infoBanner}>
                    <Ionicons name="mail-unread-outline" size={16} color={t.caramel} />
                    <AppText variant="caption" style={styles.infoBannerText}>
                      Code sent to {email.trim()}.
                    </AppText>
                  </View>

                  <View style={{ marginTop: Spacing.lg }}>
                    <AppText variant="caption" color="muted" style={styles.label}>
                      Verification code
                    </AppText>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="keypad-outline" size={16} color={t.caramel} />
                      </View>
                      <TextInput
                        value={otp}
                        testID="signup-otp-input"
                        accessibilityLabel="signup-otp-input"
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
                        returnKeyType="go"
                        onSubmitEditing={handleCompleteSignup}
                      />
                    </View>
                  </View>

                  <View style={styles.otpActionRow}>
                    <Button
                      label="Edit details"
                      icon="create-outline"
                      variant="secondary"
                      size="sm"
                      fullWidth={false}
                      onPress={() => {
                        setStage("details");
                        setOtp("");
                        setErrorText("");
                      }}
                      disabled={busy}
                    />
                    <Button
                      label="Resend code"
                      icon="refresh-outline"
                      variant="secondary"
                      size="sm"
                      fullWidth={false}
                      onPress={handleResendOtp}
                      disabled={busy || cooldownRemaining > 0}
                      testID="signup-resend-otp-button"
                      accessibilityLabel="signup-resend-otp-button"
                    />
                  </View>

                  <AppText variant="caption" color="muted" style={styles.cooldownText}>
                    {cooldownRemaining > 0
                      ? `Resend available in ${cooldownRemaining}s.`
                      : "You can resend the code now."}
                  </AppText>
                </>
              )}

              <Button
                label={stage === "details" ? "Send OTP" : "Verify and create account"}
                iconRight="arrow-forward"
                onPress={stage === "details" ? handleSendOtp : handleCompleteSignup}
                loading={busy}
                disabled={stage === "details" ? !canSendOtp : !canComplete}
                size="lg"
                style={styles.submit}
                testID={stage === "details" ? "signup-send-otp-button" : "signup-complete-button"}
                accessibilityLabel={
                  stage === "details" ? "signup-send-otp-button" : "signup-complete-button"
                }
              />

              <View style={styles.footerRow}>
                <AppText variant="caption" color="muted">
                  Have an account?
                </AppText>
                <Pressable onPress={() => router.replace("/auth/login")}>
                  <AppText variant="caption" color="accent">
                    Sign in
                  </AppText>
                </Pressable>
              </View>
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
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
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: t.dangerSoft,
    borderWidth: 1,
    borderColor: t.danger,
  },
  errorText: {
    flex: 1,
    color: t.danger,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    alignItems: "center",
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
  otpActionRow: {
    marginTop: Spacing.lg,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
  },
  cooldownText: {
    marginTop: Spacing.md,
  },
  submit: {
    marginTop: Spacing.xl,
  },
  footerRow: {
    marginTop: Spacing.xl,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: Spacing.sm,
    flexWrap: "wrap",
  },
  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
  });
}
