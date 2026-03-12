import React from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";

export default function LandingScreen() {
  const { user } = useAuth();

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 18, paddingVertical: 18 }}>
        <View style={headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={title}>J AI</Text>
            <Text style={subtitle}>Your persona-aware daily AI companion</Text>
          </View>

          <View style={badge}>
            <Ionicons name="sparkles-outline" size={18} color="rgba(173,232,255,0.95)" />
          </View>
        </View>

        <GlassCard style={{ marginTop: 22, borderRadius: 28 }}>
          <Text style={heroTitle}>Login or create your account</Text>
          <Text style={heroText}>
            Use email and password or continue with Google. After login, we’ll finish your profile
            and routine setup.
          </Text>

          <View style={{ marginTop: 18, gap: 12 }}>
            <Feature icon="mail-outline" text="Email and password sign up" />
            <Feature icon="logo-google" text="Google sign-in" />
            <Feature
              icon="shield-checkmark-outline"
              text="Firebase keeps the session logged in"
            />
          </View>

          <Pressable onPress={() => router.push("/auth/login")} style={primaryBtn}>
            <Text style={primaryBtnText}>{user ? "Continue" : "Login"}</Text>
          </Pressable>

          {!user ? (
            <Pressable onPress={() => router.push("/auth/signup")} style={secondaryBtn}>
              <Text style={secondaryBtnText}>Create account</Text>
            </Pressable>
          ) : null}
        </GlassCard>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Feature({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={featureRow}>
      <Ionicons name={icon} size={18} color="rgba(173,232,255,0.95)" />
      <Text style={featureText}>{text}</Text>
    </View>
  );
}

const headerRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const title = {
  color: "white",
  fontSize: 32,
  lineHeight: 38,
  fontWeight: "900" as const,
};

const subtitle = {
  marginTop: 6,
  color: "rgba(255,255,255,0.68)",
  fontSize: 14,
  lineHeight: 21,
};

const badge = {
  width: 42,
  height: 42,
  borderRadius: 21,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const heroTitle = {
  color: "white",
  fontSize: 28,
  lineHeight: 34,
  fontWeight: "900" as const,
};

const heroText = {
  marginTop: 10,
  color: "rgba(255,255,255,0.72)",
  fontSize: 14,
  lineHeight: 21,
};

const featureRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
};

const featureText = {
  color: "rgba(255,255,255,0.88)",
  fontSize: 14,
  fontWeight: "700" as const,
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

const secondaryBtn = {
  marginTop: 12,
  minHeight: 54,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const secondaryBtnText = {
  color: "white",
  fontWeight: "900" as const,
  fontSize: 15,
};