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

export default function ForgotPasswordScreen() {
  const { requestPasswordResetOtp, confirmPasswordResetOtp } = useAuth();
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
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 10 : 16);
  const bottomPadding = Math.max(insets.bottom + 28, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = isCompact ? 56 : 60;
  const buttonHeight = isCompact ? 54 : 58;

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
      setErrorText("Please enter a valid email address.");
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
      setErrorText("Please enter a valid email address.");
      return;
    }

    if (!/^\d{6}$/.test(normalizedOtp)) {
      setErrorText("Enter the 6-digit code from your email.");
      return;
    }

    if (newPassword.length < 6) {
      setErrorText("New password should be at least 6 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorText("Passwords do not match.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await confirmPasswordResetOtp(nextEmail, normalizedOtp, newPassword);
      setSuccessText("Password updated. Please log in with your new password.");
      setTimeout(() => router.replace("/auth/login"), 900);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Password reset failed.");
    } finally {
      setBusy(false);
    }
  }

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
          <View style={{ width: "100%", alignSelf: "center", maxWidth: contentMaxWidth }}>
            <Pressable
              onPress={() => router.replace("/auth/login")}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
              <Text style={styles.backButtonText}>Back</Text>
            </Pressable>

            <View style={styles.headerBlock} />

            <GlassCard style={{ borderRadius: 30 }}>
              <Text style={styles.cardTitle}>Reset password</Text>

              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle-outline" size={16} color="#f7fbff" />
                  <Text style={styles.errorText}>{errorText}</Text>
                </View>
              ) : null}

              {successText ? (
                <View style={styles.successCard}>
                  <Ionicons name="checkmark-circle-outline" size={16} color={Brand.ink} />
                  <Text style={styles.successText}>{successText}</Text>
                </View>
              ) : null}

              <View style={{ marginTop: errorText || successText ? 16 : 18 }}>
                <Text style={styles.label}>Email</Text>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons name="mail-outline" size={16} color={Brand.bronze} />
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
                    placeholderTextColor="rgba(226, 238, 255, 0.46)"
                    style={styles.input}
                    editable={!busy && stage === "email"}
                    returnKeyType="go"
                    onSubmitEditing={handleSendOtp}
                  />
                </View>
              </View>

              {stage === "email" ? (
                <Pressable
                  onPress={handleSendOtp}
                  disabled={!canSend}
                  testID="forgot-password-send-otp-button"
                  accessibilityLabel="forgot-password-send-otp-button"
                  style={({ pressed }) => [
                    styles.buttonShell,
                    pressed && styles.pressed,
                    !canSend && styles.disabled,
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
                        <Text style={styles.primaryButtonText}>Send reset code</Text>
                        <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                      </>
                    )}
                  </LinearGradient>
                </Pressable>
              ) : (
                <>
                  <View style={styles.infoBanner}>
                    <Ionicons name="mail-unread-outline" size={16} color={Brand.bronze} />
                    <Text style={styles.infoBannerText}>
                      If an account exists for this email, a reset code was sent.
                    </Text>
                  </View>

                  <View style={{ marginTop: 16 }}>
                    <Text style={styles.label}>Reset code</Text>
                    <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                      <View style={styles.inputIconWrap}>
                        <Ionicons name="keypad-outline" size={16} color={Brand.bronze} />
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
                        placeholderTextColor="rgba(226, 238, 255, 0.46)"
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

                  <Text style={styles.cooldownText}>
                    {cooldownRemaining > 0
                      ? `You can request another code in ${cooldownRemaining}s.`
                      : "You can request another code if needed."}
                  </Text>

                  <Pressable
                    onPress={handleConfirmReset}
                    disabled={!canConfirm}
                    testID="forgot-password-confirm-button"
                    accessibilityLabel="forgot-password-confirm-button"
                    style={({ pressed }) => [
                      styles.buttonShell,
                      pressed && styles.pressed,
                      !canConfirm && styles.disabled,
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
                          <Text style={styles.primaryButtonText}>Reset password</Text>
                          <Ionicons name="checkmark" size={18} color={Brand.ink} />
                        </>
                      )}
                    </LinearGradient>
                  </Pressable>
                </>
              )}
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
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
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputShell, { minHeight: inputHeight }]}>
        <View style={styles.inputIconWrap}>
          <Ionicons name="shield-checkmark-outline" size={16} color={Brand.bronze} />
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
          placeholder="Minimum 6 characters"
          placeholderTextColor="rgba(226, 238, 255, 0.46)"
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
          <Ionicons name={visibility.iconName} size={18} color={Brand.cocoa} />
        </Pressable>
      </View>
    </View>
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
  cardTitle: {
    color: Brand.ink,
    fontSize: 24,
    fontWeight: "900",
  },
  errorCard: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: Brand.danger,
  },
  errorText: {
    flex: 1,
    color: "#f7fbff",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  successCard: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: Brand.success,
  },
  successText: {
    flex: 1,
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  label: {
    marginBottom: 8,
    color: Brand.cocoa,
    fontSize: 13,
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
  cooldownText: {
    marginTop: 12,
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
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.55,
  },
});
