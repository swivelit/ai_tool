import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";

export default function LoginScreen() {
  const { signInWithPassword, signInWithGoogle, googleConfigured, googleReady } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;

  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 16);
  const bottomPadding = Math.max(insets.bottom + 24, 24);
  const cardRadius = isSmallPhone ? 24 : 28;
  const inputHeight = isSmallPhone ? 52 : 56;
  const buttonHeight = isSmallPhone ? 52 : 54;
  const contentMaxWidth = Math.min(width - horizontalPadding * 2, 520);

  async function handleLogin() {
    if (!email.trim() || !password) {
      setErrorText("Please enter both email and password.");
      return;
    }

    try {
      setBusy(true);
      setErrorText("");
      await signInWithPassword(email, password);
    } catch (error: any) {
      setErrorText(error?.message || "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    try {
      setBusy(true);
      setErrorText("");
      await signInWithGoogle();
    } catch (error: any) {
      setErrorText(error?.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={{ flex: 1 }}
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
            <Pressable onPress={() => router.replace("/")} style={backBtn}>
              <Ionicons name="chevron-back" size={18} color="white" />
              <Text style={[backBtnText, { fontSize: isSmallPhone ? 13 : 14 }]}>Back</Text>
            </Pressable>

            <GlassCard
              style={{
                marginTop: isSmallPhone ? 16 : 18,
                borderRadius: cardRadius,
                width: "100%",
              }}
            >
              <Text
                style={{
                  color: "white",
                  fontSize: isVerySmallPhone ? 25 : isSmallPhone ? 27 : 30,
                  lineHeight: isVerySmallPhone ? 31 : isSmallPhone ? 33 : 36,
                  fontWeight: "900",
                }}
              >
                Login
              </Text>

              <Text
                style={{
                  marginTop: 8,
                  color: "rgba(255,255,255,0.70)",
                  fontSize: isSmallPhone ? 13 : 14,
                  lineHeight: isSmallPhone ? 20 : 21,
                }}
              >
                Welcome back. Sign in to continue using J AI.
              </Text>

              {errorText ? (
                <View
                  style={[
                    errorCard,
                    {
                      marginTop: isSmallPhone ? 14 : 16,
                      paddingHorizontal: isSmallPhone ? 10 : 12,
                      paddingVertical: isSmallPhone ? 9 : 10,
                      borderRadius: isSmallPhone ? 14 : 16,
                    },
                  ]}
                >
                  <Ionicons name="alert-circle-outline" size={16} color="#FFD8D8" />
                  <Text
                    style={{
                      flex: 1,
                      color: "#FFE8E8",
                      fontSize: isSmallPhone ? 12 : 13,
                      lineHeight: isSmallPhone ? 18 : 19,
                    }}
                  >
                    {errorText}
                  </Text>
                </View>
              ) : null}

              <Text
                style={[
                  label,
                  {
                    marginTop: isSmallPhone ? 14 : 16,
                    marginBottom: 9,
                    fontSize: isSmallPhone ? 13 : 14,
                  },
                ]}
              >
                Email
              </Text>

              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={[
                  input,
                  {
                    height: inputHeight,
                    borderRadius: isSmallPhone ? 16 : 18,
                    paddingHorizontal: 16,
                    fontSize: isSmallPhone ? 14 : 15,
                  },
                ]}
                editable={!busy}
              />

              <Text
                style={[
                  label,
                  {
                    marginTop: isSmallPhone ? 14 : 16,
                    marginBottom: 9,
                    fontSize: isSmallPhone ? 13 : 14,
                  },
                ]}
              >
                Password
              </Text>

              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Your password"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={[
                  input,
                  {
                    height: inputHeight,
                    borderRadius: isSmallPhone ? 16 : 18,
                    paddingHorizontal: 16,
                    fontSize: isSmallPhone ? 14 : 15,
                  },
                ]}
                editable={!busy}
              />

              <Pressable
                onPress={handleLogin}
                style={[
                  primaryBtn,
                  {
                    marginTop: isSmallPhone ? 20 : 22,
                    minHeight: buttonHeight,
                    borderRadius: isSmallPhone ? 16 : 18,
                  },
                  busy && disabledBtn,
                ]}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#041222" />
                ) : (
                  <Text style={[primaryBtnText, { fontSize: isSmallPhone ? 14 : 15 }]}>Login</Text>
                )}
              </Pressable>

              <View style={[dividerRow, { marginTop: isSmallPhone ? 16 : 18 }]}>
                <View style={dividerLine} />
                <Text style={[dividerText, { fontSize: isSmallPhone ? 11 : 12 }]}>or</Text>
                <View style={dividerLine} />
              </View>

              <Pressable
                onPress={handleGoogle}
                disabled={busy || !googleReady || !googleConfigured}
                style={[
                  googleBtn,
                  {
                    marginTop: isSmallPhone ? 16 : 18,
                    minHeight: buttonHeight,
                    borderRadius: isSmallPhone ? 16 : 18,
                  },
                  (busy || !googleReady || !googleConfigured) && disabledBtn,
                ]}
              >
                <Ionicons name="logo-google" size={18} color="#041222" />
                <Text style={[googleBtnText, { fontSize: isSmallPhone ? 14 : 15 }]}>
                  Continue with Google
                </Text>
              </Pressable>

              {!googleConfigured ? (
                <Text
                  style={{
                    marginTop: 10,
                    color: "rgba(255,255,255,0.60)",
                    fontSize: isSmallPhone ? 11 : 12,
                    lineHeight: isSmallPhone ? 17 : 18,
                  }}
                >
                  Add your EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID to .env to enable this button.
                </Text>
              ) : null}

              <Pressable
                onPress={() => router.replace("/auth/signup")}
                style={{ marginTop: isSmallPhone ? 16 : 18, alignItems: "center" }}
              >
                <Text
                  style={{
                    color: "rgba(173,232,255,0.98)",
                    fontSize: isSmallPhone ? 13 : 14,
                    fontWeight: "800",
                  }}
                >
                  New here? Create an account
                </Text>
              </Pressable>
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const backBtn = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
  alignSelf: "flex-start" as const,
};

const backBtnText = {
  color: "white",
  fontWeight: "800" as const,
};

const errorCard = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 8,
  backgroundColor: "rgba(255,92,92,0.18)",
  borderWidth: 1,
  borderColor: "rgba(255,160,160,0.25)",
};

const label = {
  color: "rgba(255,255,255,0.92)",
  fontWeight: "800" as const,
};

const input = {
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const primaryBtn = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const primaryBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
};

const dividerRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
};

const dividerLine = {
  flex: 1,
  height: 1,
  backgroundColor: "rgba(255,255,255,0.12)",
};

const dividerText = {
  color: "rgba(255,255,255,0.48)",
  fontWeight: "700" as const,
};

const googleBtn = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  flexDirection: "row" as const,
  gap: 10,
  backgroundColor: "rgba(255,255,255,0.94)",
};

const googleBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
};

const disabledBtn = {
  opacity: 0.6,
};