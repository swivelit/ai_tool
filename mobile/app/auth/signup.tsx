import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
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

function passwordStrengthTone(value: string) {
  if (!value || value.length < 6) return Brand.danger;
  if (value.length < 9) return Brand.bronze;
  return Brand.success;
}

export default function SignupScreen() {
  const { requestSignupOtp, completeSignupWithOtp } = useAuth();

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

  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 10 : 16);
  const bottomPadding = Math.max(insets.bottom + 28, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = isCompact ? 56 : 60;
  const buttonHeight = isCompact ? 54 : 58;

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
      setErrorText("Please fill all fields.");
      return;
    }

    if (nextName.length < 2) {
      setErrorText("Please enter a valid name.");
      return;
    }

    if (!emailLooksValid(nextEmail)) {
      setErrorText("Please enter a valid email address.");
      return;
    }

    if (password.length < 6) {
      setErrorText("Password should be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorText("Passwords do not match.");
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
      setErrorText("Enter the 6-digit code from your email.");
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

  const passwordTone = passwordStrengthTone(password);
  const passwordLabel = passwordStrengthLabel(password);
  const passwordVisibility = getPasswordVisibilityProps(showPassword);
  const confirmPasswordVisibility = getPasswordVisibilityProps(showConfirmPassword);

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="light" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

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
          <View
            style={{
              width: "100%",
              alignSelf: "center",
              maxWidth: contentMaxWidth,
            }}
          >
            <Pressable
              onPress={() => router.replace("/auth/login")}
              style={({ pressed }) => [
                styles.backButton,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
              <Text style={styles.backButtonText}>Back</Text>
            </Pressable>

            <View style={styles.headerBlock}>

            </View>

            <GlassCard style={{ borderRadius: 30 }}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardTitle}>Create account</Text>
                </View>
              </View>

              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={16}
                    color="#f7fbff"
                  />
                  <Text style={styles.errorText}>{errorText}</Text>
                </View>
              ) : null}

              {stage === "details" ? (
                <>
              <View style={{ marginTop: errorText ? 16 : 18 }}>
                <Text style={styles.label}>Name</Text>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons
                      name="person-outline"
                      size={16}
                      color={Brand.bronze}
                    />
                  </View>
                  <TextInput
                    value={name}
                    testID="signup-name-input"
                    accessibilityLabel="signup-name-input"
                    onChangeText={(value) => {
                      setName(value);
                      if (errorText) setErrorText("");
                    }}
                    placeholder="your name"
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="next"
                  />
                </View>
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Email</Text>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons
                      name="mail-outline"
                      size={16}
                      color={Brand.bronze}
                    />
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
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="next"
                  />
                </View>
              </View>

              <View style={{ marginTop: 16 }}>
                <View style={styles.labelRow}>
                  <Text style={styles.label}>Password</Text>
                  <Text style={[styles.passwordHint, { color: passwordTone }]}>
                    {passwordLabel}
                  </Text>
                </View>

                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons
                      name="shield-checkmark-outline"
                      size={16}
                      color={Brand.bronze}
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
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
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
                      color={Brand.cocoa}
                    />
                  </Pressable>
                </View>
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Confirm password</Text>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons
                      name="key-outline"
                      size={16}
                      color={Brand.bronze}
                    />
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
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={handleSendOtp}
                  />
                  <Pressable
                    onPress={() =>
                      setShowConfirmPassword((prev) => !prev)
                    }
                    style={styles.visibilityBtn}
                    accessibilityRole="button"
                    accessibilityLabel={confirmPasswordVisibility.accessibilityLabel}
                    accessibilityHint={confirmPasswordVisibility.accessibilityHint}
                    hitSlop={10}
                  >
                    <Ionicons
                      name={confirmPasswordVisibility.iconName}
                      size={18}
                      color={Brand.cocoa}
                    />
                  </Pressable>
                </View>
              </View>

                </>
              ) : (
                <>
                  <View style={styles.infoBanner}>
                    <Ionicons
                      name="mail-unread-outline"
                      size={16}
                      color={Brand.bronze}
                    />
                    <Text style={styles.infoBannerText}>
                      We sent a 6-digit code to {email.trim()}.
                    </Text>
                  </View>

                  <View style={{ marginTop: 16 }}>
                    <Text style={styles.label}>OTP code</Text>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons
                          name="keypad-outline"
                          size={16}
                          color={Brand.bronze}
                        />
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
                        placeholderTextColor="rgba(226, 238, 255, 0.46)"
                        style={styles.input}
                        editable={!busy}
                        returnKeyType="go"
                        onSubmitEditing={handleCompleteSignup}
                      />
                    </View>
                  </View>

                  <View style={styles.otpActionRow}>
                    <Pressable
                      onPress={() => {
                        setStage("details");
                        setOtp("");
                        setErrorText("");
                      }}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.secondaryAction,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Ionicons name="create-outline" size={15} color={Brand.cocoa} />
                      <Text style={styles.secondaryActionText}>Edit details</Text>
                    </Pressable>

                    <Pressable
                      onPress={handleResendOtp}
                      disabled={busy || cooldownRemaining > 0}
                      testID="signup-resend-otp-button"
                      accessibilityLabel="signup-resend-otp-button"
                      style={({ pressed }) => [
                        styles.secondaryAction,
                        pressed && styles.pressed,
                        (busy || cooldownRemaining > 0) && styles.disabled,
                      ]}
                    >
                      <Ionicons name="refresh-outline" size={15} color={Brand.cocoa} />
                      <Text style={styles.secondaryActionText}>Resend code</Text>
                    </Pressable>
                  </View>

                  <Text style={styles.cooldownText}>
                    {cooldownRemaining > 0
                      ? `You can resend in ${cooldownRemaining}s.`
                      : "You can resend the code now."}
                  </Text>
                </>
              )}

              <Pressable
                onPress={stage === "details" ? handleSendOtp : handleCompleteSignup}
                disabled={stage === "details" ? !canSendOtp : !canComplete}
                testID={stage === "details" ? "signup-send-otp-button" : "signup-complete-button"}
                accessibilityLabel={stage === "details" ? "signup-send-otp-button" : "signup-complete-button"}
                style={({ pressed }) => [
                  styles.buttonShell,
                  pressed && styles.pressed,
                  (stage === "details" ? !canSendOtp : !canComplete) && styles.disabled,
                ]}
              >
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.primaryButton, { minHeight: buttonHeight }]}
                >
                  {busy ? (
                    <ActivityIndicator color={Brand.ink} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>
                        {stage === "details" ? "Send OTP" : "Verify and create account"}
                      </Text>
                      <Ionicons
                        name="arrow-forward"
                        size={18}
                        color={Brand.ink}
                      />
                    </>
                  )}
                </LinearGradient>
              </Pressable>

              <View style={styles.footerRow}>
                <Text style={styles.footerCopy}>Already have an account?</Text>
                <Pressable onPress={() => router.replace("/auth/login")}>
                  <Text style={styles.footerLink}>Login</Text>
                </Pressable>
              </View>
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  topGlow: {
    position: "absolute",
    top: -80,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },

  leftGlow: {
    position: "absolute",
    top: 250,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -70,
    left: -20,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  backButton: {
    alignSelf: "flex-start",
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  backButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  headerBlock: {
    marginTop: 18,
    marginBottom: 18,
  },

  titlePill: {
    alignSelf: "flex-start",
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },

  titlePillText: {
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

  metricRow: {
    marginTop: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  metricChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  cardTitle: {
    color: Brand.ink,
    fontSize: 24,
    fontWeight: "900",
  },

  cardSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  cardBadge: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  cardBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
  },

  errorCard: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(244, 90, 90, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(244, 90, 90, 0.34)",
  },

  errorText: {
    flex: 1,
    color: "#f7fbff",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },

  labelRow: {
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  label: {
    marginBottom: 8,
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
  },

  passwordHint: {
    fontSize: 12,
    fontWeight: "800",
  },

  inputShell: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
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
    color: Brand.ink,
    fontSize: 15,
    paddingRight: 10,
  },

  visibilityBtn: {
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },

  infoBanner: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: "rgba(111, 140, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(111, 140, 94, 0.18)",
  },

  infoBannerText: {
    flex: 1,
    color: Brand.ink,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  otpActionRow: {
    marginTop: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  secondaryAction: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 13,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },

  secondaryActionText: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "900",
  },

  cooldownText: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  buttonShell: {
    marginTop: 22,
    borderRadius: 18,
    overflow: "hidden",
  },

  primaryButton: {
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
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  dividerRow: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Brand.lineStrong,
  },

  dividerText: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  googleButton: {
    marginTop: 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  googleButtonText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  devCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
    gap: 10,
  },

  devCardHeader: {
    gap: 10,
  },

  devCardBadge: {
    alignSelf: "flex-start",
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  devCardBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
  },

  devCardTitle: {
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  devCardCopy: {
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  devCredentialRow: {
    gap: 4,
  },

  devCredentialLabel: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  devCredentialValue: {
    color: Brand.ink,
    fontSize: 13,
    fontWeight: "800",
  },

  devHint: {
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  devButton: {
    marginTop: 2,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },

  devButtonText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  helperText: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  highlightList: {
    marginTop: 18,
    gap: 12,
  },

  highlightRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  highlightIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(87, 222, 255, 0.10)",
  },

  highlightTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  highlightCopy: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  footerRow: {
    marginTop: 20,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },

  footerCopy: {
    color: Brand.muted,
    fontSize: 13,
    fontWeight: "700",
  },

  footerLink: {
    color: Brand.bronze,
    fontSize: 13,
    fontWeight: "900",
  },

  disabled: {
    opacity: 0.6,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});
