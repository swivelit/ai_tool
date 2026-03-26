import React, { useMemo, useState } from "react";
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

const HIGHLIGHTS = [
  {
    icon: "person-outline" as const,
    title: "Made for you",
    copy: "Get everything ready in just a moment.",
  },
  {
    icon: "calendar-clear-outline" as const,
    title: "Stay organized",
    copy: "Everything you need to manage your day.",
  },
  {
    icon: "lock-closed-outline" as const,
    title: "Secure account access",
    copy: "A smooth and secure way to begin.",
  },
];

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
  const { signUpWithPassword, signInWithGoogle, googleConfigured, googleReady } =
    useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const isVeryCompact = width < 345 || height < 700;

  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 10 : 16);
  const bottomPadding = Math.max(insets.bottom + 28, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = isCompact ? 56 : 60;
  const buttonHeight = isCompact ? 54 : 58;

  const canSubmit = useMemo(() => {
    return (
      name.trim().length > 0 &&
      email.trim().length > 0 &&
      password.length > 0 &&
      confirmPassword.length > 0 &&
      !busy
    );
  }, [busy, confirmPassword, email, name, password]);

  async function handleSignup() {
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
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await signUpWithPassword(nextName, nextEmail, password);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Sign up failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    try {
      setBusy(true);
      setErrorText("");
      await signInWithGoogle();
    } catch (error: unknown) {
      setErrorText(
        error instanceof Error ? error.message : "Google sign-in failed."
      );
    } finally {
      setBusy(false);
    }
  }

  const passwordTone = passwordStrengthTone(password);
  const passwordLabel = passwordStrengthLabel(password);

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
              onPress={() => router.replace("/")}
              style={({ pressed }) => [
                styles.backButton,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
              <Text style={styles.backButtonText}>Back</Text>
            </Pressable>

            <View style={styles.headerBlock}>
              <View style={styles.titlePill}>
                <Ionicons
                  name="person-add-outline"
                  size={14}
                  color={Brand.bronze}
                />
                <Text style={styles.titlePillText}>Create your account</Text>
              </View>

              <Text
                style={[
                  styles.title,
                  {
                    fontSize: isVeryCompact ? 30 : isCompact ? 34 : 38,
                    lineHeight: isVeryCompact ? 36 : isCompact ? 39 : 44,
                  },
                ]}
              >
                Start here and make it yours.
              </Text>

              <Text style={styles.subtitle}>
                Sign up once and let your assistant take it from there.
              </Text>

              <View style={styles.metricRow}>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Quick start</Text>
                </View>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Clear validation</Text>
                </View>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Smooth experience</Text>
                </View>
              </View>
            </View>

            <GlassCard style={{ borderRadius: 30 }}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardTitle}>Create account</Text>
                  <Text style={styles.cardSubtitle}>
                    Sign up and keep going.
                  </Text>
                </View>

                <View style={styles.cardBadge}>
                  <Ionicons
                    name="sparkles-outline"
                    size={14}
                    color={Brand.bronze}
                  />
                  <Text style={styles.cardBadgeText}>New</Text>
                </View>
              </View>

              {errorText ? (
                <View style={styles.errorCard}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={16}
                    color="#fff4ef"
                  />
                  <Text style={styles.errorText}>{errorText}</Text>
                </View>
              ) : null}

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
                    onChangeText={(value) => {
                      setName(value);
                      if (errorText) setErrorText("");
                    }}
                    placeholder="Hari"
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
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
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
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
                    onChangeText={(value) => {
                      setPassword(value);
                      if (errorText) setErrorText("");
                    }}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    placeholder="Minimum 6 characters"
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="next"
                  />
                  <Pressable
                    onPress={() => setShowPassword((prev) => !prev)}
                    style={styles.visibilityBtn}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
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
                    onChangeText={(value) => {
                      setConfirmPassword(value);
                      if (errorText) setErrorText("");
                    }}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Re-enter password"
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={handleSignup}
                  />
                  <Pressable
                    onPress={() =>
                      setShowConfirmPassword((prev) => !prev)
                    }
                    style={styles.visibilityBtn}
                  >
                    <Ionicons
                      name={
                        showConfirmPassword ? "eye-off-outline" : "eye-outline"
                      }
                      size={18}
                      color={Brand.cocoa}
                    />
                  </Pressable>
                </View>
              </View>

              <View style={styles.infoBanner}>
                <Ionicons
                  name="checkmark-circle-outline"
                  size={16}
                  color={Brand.success}
                />
                <Text style={styles.infoBannerText}>
                  Next, we will help you personalize your assistant.
                </Text>
              </View>

              <Pressable
                onPress={handleSignup}
                disabled={!canSubmit}
                style={({ pressed }) => [
                  styles.buttonShell,
                  pressed && styles.pressed,
                  !canSubmit && styles.disabled,
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
                        Create account
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

              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or continue with</Text>
                <View style={styles.dividerLine} />
              </View>

              <Pressable
                onPress={handleGoogle}
                disabled={busy || !googleReady || !googleConfigured}
                style={({ pressed }) => [
                  styles.googleButton,
                  pressed && styles.pressed,
                  (busy || !googleReady || !googleConfigured) && styles.disabled,
                  { minHeight: buttonHeight },
                ]}
              >
                <Ionicons name="logo-google" size={18} color={Brand.ink} />
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </Pressable>

              {!googleConfigured ? (
                <Text style={styles.helperText}>
                  Add your EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID in your env file
                  to enable Google sign-in.
                </Text>
              ) : null}

              <View style={styles.highlightList}>
                {HIGHLIGHTS.map((item) => (
                  <View key={item.title} style={styles.highlightRow}>
                    <View style={styles.highlightIconWrap}>
                      <Ionicons
                        name={item.icon}
                        size={16}
                        color={Brand.bronze}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.highlightTitle}>{item.title}</Text>
                      <Text style={styles.highlightCopy}>{item.copy}</Text>
                    </View>
                  </View>
                ))}
              </View>

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
    backgroundColor: "rgba(255,255,255,0.55)",
  },

  leftGlow: {
    position: "absolute",
    top: 250,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.28)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -70,
    left: -20,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.35)",
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
    backgroundColor: "rgba(255,255,255,0.62)",
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
    backgroundColor: "rgba(255,255,255,0.58)",
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
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  cardBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
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
    color: "#fff4ef",
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
    backgroundColor: "rgba(255,255,255,0.72)",
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
    backgroundColor: "rgba(255,255,255,0.80)",
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
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  highlightIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
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