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

const BENEFITS = [
  {
    icon: "shield-checkmark-outline" as const,
    title: "Secure access",
    copy: "Built for secure and easy access.",
  },
  {
    icon: "sparkles-outline" as const,
    title: "Your control center",
    copy: "Step back into your assistant in seconds.",
  },
  {
    icon: "time-outline" as const,
    title: "Fast re-entry",
    copy: "Built for speed and simplicity.",
  },
];

function emailLooksValid(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim());
}

export default function LoginScreen() {
  const { signInWithPassword, signInWithGoogle, googleConfigured, googleReady } =
    useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [showPassword, setShowPassword] = useState(false);

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

  const canSubmit = useMemo(
    () => email.trim().length > 0 && password.length > 0 && !busy,
    [busy, email, password]
  );

  async function handleLogin() {
    const nextEmail = email.trim();

    if (!nextEmail || !password) {
      setErrorText("Please enter both email and password.");
      return;
    }

    if (!emailLooksValid(nextEmail)) {
      setErrorText("Please enter a valid email address.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await signInWithPassword(nextEmail, password);
    } catch (error: unknown) {
      setErrorText(error instanceof Error ? error.message : "Login failed.");
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
                  name="lock-closed-outline"
                  size={14}
                  color={Brand.bronze}
                />
                <Text style={styles.titlePillText}>Secure access</Text>
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
                Good to see you again.
              </Text>

              <Text style={styles.subtitle}>
                Fast, simple, and secure from the start.
              </Text>

              <View style={styles.metricRow}>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Fast sign-in</Text>
                </View>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Secure flow</Text>
                </View>
                <View style={styles.metricChip}>
                  <Text style={styles.metricText}>Easy to use</Text>
                </View>
              </View>
            </View>

            <GlassCard style={{ borderRadius: 30 }}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardTitle}>Login</Text>
                  <Text style={styles.cardSubtitle}>
                    Return to your assistant.
                  </Text>
                </View>

                <View style={styles.cardBadge}>
                  <Ionicons
                    name="sparkles-outline"
                    size={14}
                    color={Brand.bronze}
                  />
                  <Text style={styles.cardBadgeText}>Ready</Text>
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
                    textContentType="username"
                    placeholder="you@example.com"
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="next"
                  />
                </View>
              </View>

              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>Password</Text>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons
                      name="key-outline"
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
                    autoComplete="password"
                    textContentType="password"
                    placeholder="Your password"
                    placeholderTextColor="rgba(124, 99, 80, 0.55)"
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
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

              <Pressable
                onPress={handleLogin}
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
                      <Text style={styles.primaryButtonText}>Login</Text>
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

              <View style={styles.benefitList}>
                {BENEFITS.map((item) => (
                  <View key={item.title} style={styles.benefitRow}>
                    <View style={styles.benefitIconWrap}>
                      <Ionicons
                        name={item.icon}
                        size={16}
                        color={Brand.bronze}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.benefitTitle}>{item.title}</Text>
                      <Text style={styles.benefitCopy}>{item.copy}</Text>
                    </View>
                  </View>
                ))}
              </View>

              <View style={styles.footerRow}>
                <Text style={styles.footerCopy}>Don’t have an account yet?</Text>
                <Pressable onPress={() => router.replace("/auth/signup")}>
                  <Text style={styles.footerLink}>Create account</Text>
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

  benefitList: {
    marginTop: 18,
    gap: 12,
  },

  benefitRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  benefitIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  benefitTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  benefitCopy: {
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