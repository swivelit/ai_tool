import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";

export default function LoginScreen() {
  const { signInWithPassword, signInWithGoogle, googleConfigured, googleReady } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");

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
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            <Pressable onPress={() => router.replace("/")} style={backBtn}>
              <Ionicons name="chevron-back" size={18} color="white" />
              <Text style={backBtnText}>Back</Text>
            </Pressable>

            <GlassCard style={{ marginTop: 18, borderRadius: 28 }}>
              <Text style={title}>Login</Text>
              <Text style={subtitle}>Welcome back. Sign in to continue using J AI.</Text>

              {errorText ? (
                <View style={errorCard}>
                  <Ionicons name="alert-circle-outline" size={16} color="#FFD8D8" />
                  <Text style={errorTextStyle}>{errorText}</Text>
                </View>
              ) : null}

              <Text style={label}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={input}
                editable={!busy}
              />

              <Text style={label}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Your password"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={input}
                editable={!busy}
              />

              <Pressable onPress={handleLogin} style={[primaryBtn, busy && disabledBtn]} disabled={busy}>
                {busy ? <ActivityIndicator color="#041222" /> : <Text style={primaryBtnText}>Login</Text>}
              </Pressable>

              <View style={dividerRow}>
                <View style={dividerLine} />
                <Text style={dividerText}>or</Text>
                <View style={dividerLine} />
              </View>

              <Pressable
                onPress={handleGoogle}
                disabled={busy || !googleReady || !googleConfigured}
                style={[googleBtn, (busy || !googleReady || !googleConfigured) && disabledBtn]}
              >
                <Ionicons name="logo-google" size={18} color="#041222" />
                <Text style={googleBtnText}>Continue with Google</Text>
              </Pressable>

              {!googleConfigured ? (
                <Text style={hintText}>
                  Add your EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID to .env to enable this button.
                </Text>
              ) : null}

              <Pressable onPress={() => router.replace("/auth/signup")} style={linkWrap}>
                <Text style={linkText}>New here? Create an account</Text>
              </Pressable>
            </GlassCard>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
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
  fontSize: 14,
};

const title = {
  color: "white",
  fontSize: 30,
  lineHeight: 36,
  fontWeight: "900" as const,
};

const subtitle = {
  marginTop: 8,
  color: "rgba(255,255,255,0.70)",
  fontSize: 14,
  lineHeight: 21,
};

const errorCard = {
  marginTop: 16,
  borderRadius: 16,
  paddingHorizontal: 12,
  paddingVertical: 10,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 8,
  backgroundColor: "rgba(255,92,92,0.18)",
  borderWidth: 1,
  borderColor: "rgba(255,160,160,0.25)",
};

const errorTextStyle = {
  flex: 1,
  color: "#FFE8E8",
  fontSize: 13,
  lineHeight: 19,
};

const label = {
  marginTop: 16,
  marginBottom: 9,
  color: "rgba(255,255,255,0.92)",
  fontSize: 14,
  fontWeight: "800" as const,
};

const input = {
  height: 56,
  borderRadius: 18,
  paddingHorizontal: 16,
  color: "white",
  fontSize: 15,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const primaryBtn = {
  marginTop: 22,
  minHeight: 54,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const primaryBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 15,
};

const dividerRow = {
  marginTop: 18,
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
  fontSize: 12,
  fontWeight: "700" as const,
};

const googleBtn = {
  marginTop: 18,
  minHeight: 54,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  flexDirection: "row" as const,
  gap: 10,
  backgroundColor: "rgba(255,255,255,0.94)",
};

const googleBtnText = {
  color: "#041222",
  fontWeight: "900" as const,
  fontSize: 15,
};

const disabledBtn = {
  opacity: 0.6,
};

const hintText = {
  marginTop: 10,
  color: "rgba(255,255,255,0.60)",
  fontSize: 12,
  lineHeight: 18,
};

const linkWrap = {
  marginTop: 18,
  alignItems: "center" as const,
};

const linkText = {
  color: "rgba(173,232,255,0.98)",
  fontSize: 14,
  fontWeight: "800" as const,
};