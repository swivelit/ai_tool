import React, { useMemo, useState } from "react";
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

export default function LoginScreen() {
  const { signInWithPassword } = useAuth();
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;

  const horizontalPadding = isCompact ? Spacing.lg : Spacing.xl;
  const topPadding = insets.top + (isCompact ? Spacing.sm : Spacing.lg);
  const bottomPadding = Math.max(insets.bottom + Spacing.xxl, 30);
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 540);
  const inputHeight = isCompact ? 56 : 60;

  const canSubmit = useMemo(
    () => email.trim().length > 0 && password.length > 0 && !busy,
    [busy, email, password]
  );
  const passwordVisibility = getPasswordVisibilityProps(showPassword);

  async function handleLogin() {
    const nextEmail = email.trim();

    if (!nextEmail || !password) {
      setErrorText("Enter your email and password.");
      return;
    }

    if (!emailLooksValid(nextEmail)) {
      setErrorText("That email doesn’t look right.");
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

  return (
    <Screen safeArea={false}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 12}
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
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.content, { maxWidth: contentMaxWidth }]}>
            <View style={styles.brandBlock}>
              <AppText variant="overline" color="accent">
                SWICO
              </AppText>
              <AppText variant="title" style={styles.heroTitle}>
                Welcome back
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

              <View style={{ marginTop: errorText ? Spacing.lg : 0 }}>
                <AppText variant="caption" color="muted" style={styles.label}>
                  Email
                </AppText>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons name="mail-outline" size={16} color={t.caramel} />
                  </View>
                  <TextInput
                    value={email}
                    testID="login-email-input"
                    accessibilityLabel="login-email-input"
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
                    editable={!busy}
                    returnKeyType="next"
                  />
                </View>
              </View>

              <View style={{ marginTop: Spacing.lg }}>
                <AppText variant="caption" color="muted" style={styles.label}>
                  Password
                </AppText>
                <View style={[styles.inputShell, { minHeight: inputHeight }]}>
                  <View style={styles.inputIconWrap}>
                    <Ionicons name="key-outline" size={16} color={t.caramel} />
                  </View>
                  <TextInput
                    value={password}
                    testID="login-password-input"
                    accessibilityLabel="login-password-input"
                    onChangeText={(value) => {
                      setPassword(value);
                      if (errorText) setErrorText("");
                    }}
                    secureTextEntry={passwordVisibility.secureTextEntry}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="password"
                    textContentType="password"
                    placeholder="Your password"
                    placeholderTextColor={t.placeholder}
                    style={styles.input}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
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

              <Pressable
                onPress={() => router.push("/auth/forgot-password" as any)}
                testID="forgot-password-link"
                accessibilityLabel="forgot-password-link"
                style={({ pressed }) => [
                  styles.forgotPasswordLink,
                  pressed && styles.pressed,
                ]}
              >
                <AppText variant="caption" color="accent">
                  Forgot password?
                </AppText>
              </Pressable>

              <Button
                label="Sign in"
                iconRight="arrow-forward"
                onPress={handleLogin}
                loading={busy}
                disabled={!canSubmit}
                size="lg"
                style={styles.submit}
                testID="login-submit-button"
                accessibilityLabel="login-submit-button"
              />

              <View style={styles.footerRow}>
                <AppText variant="caption" color="muted">
                  New here?
                </AppText>
                <Pressable onPress={() => router.replace("/auth/signup")}>
                  <AppText variant="caption" color="accent">
                    Create account
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

  brandBlock: {
    gap: Spacing.sm,
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

  forgotPasswordLink: {
    alignSelf: "flex-end",
    marginTop: Spacing.md,
    minHeight: 34,
    justifyContent: "center",
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
