import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { AssistantProvider, useAssistant } from "@/components/AssistantProvider";
import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { getProfileForFirebaseUid } from "@/lib/account";

function BootScreen() {
  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.bootPage}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <GlassCard style={{ borderRadius: 28, minWidth: 240 }}>
        <View style={styles.bootCard}>
          <ActivityIndicator size="small" color={Brand.bronze} />
          <Text style={styles.bootTitle}>Loading J AI...</Text>
          <Text style={styles.bootText}>Setting things up.</Text>
        </View>
      </GlassCard>
    </LinearGradient>
  );
}

function RouteGate() {
  const segments = useSegments();
  const { user } = useAuth();
  const { profile } = useAssistant();
  const [gateLoading, setGateLoading] = useState(false);

  useEffect(() => {
    let alive = true;

    async function syncAndRoute() {
      const first = segments[0];
      const second = segments[1];

      const atRoot = segments.length === 0;
      const inTabs = first === "(tabs)";
      const inAuth = first === "auth";
      const inOnboarding = first === "onboarding";
      const atProfile = first === "onboarding" && second === "profile";
      const atQuestionnaire = first === "onboarding" && second === "questionnaire";
      const atSetup = first === "setup";

      try {
        if (!user) {
          if (!alive) return;

          setGateLoading(false);

          if (!inAuth && !atRoot) {
            router.replace("/");
          }

          return;
        }

        const providerProfile = profile?.firebaseUid === user.uid ? profile : null;

        if (!providerProfile) {
          setGateLoading(true);
        } else {
          setGateLoading(false);
        }

        const localProfile = providerProfile
          ? null
          : await getProfileForFirebaseUid(user.uid, user.email);

        if (!alive) return;

        const activeProfile = providerProfile || localProfile;
        const hasProfile = Boolean(activeProfile?.userId);
        const questionnaireCompleted = Boolean(activeProfile?.questionnaireCompleted);

        if (!hasProfile) {
          if (!atProfile) {
            router.replace("/onboarding/profile");
          }
          return;
        }

        if (!questionnaireCompleted) {
          if (!atQuestionnaire) {
            router.replace("/onboarding/questionnaire");
          }
          return;
        }

        if (inAuth || inOnboarding || atRoot) {
          router.replace("/(tabs)");
          return;
        }

        if (atSetup || inTabs) {
          return;
        }
      } finally {
        if (alive) {
          setGateLoading(false);
        }
      }
    }

    void syncAndRoute();

    return () => {
      alive = false;
    };
  }, [
    segments,
    user?.uid,
    user?.email,
    profile?.firebaseUid,
    profile?.userId,
    profile?.questionnaireCompleted,
  ]);

  if (user && gateLoading) {
    return <BootScreen />;
  }

  return null;
}

function AppShell() {
  const { loading: authLoading } = useAuth();
  const { loading: profileLoading } = useAssistant();

  if (authLoading || profileLoading) {
    return <BootScreen />;
  }

  return (
    <>
      <StatusBar style="dark" />
      <RouteGate />
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="onboarding/profile" />
        <Stack.Screen name="onboarding/questionnaire" />
        <Stack.Screen name="setup" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" />
        <Stack.Screen name="modal" options={{ presentation: "modal" }} />
      </Stack>
    </>
  );
}

function RootNavigator() {
  return (
    <AssistantProvider>
      <AppShell />
    </AssistantProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  bootPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  bootCard: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  bootTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  bootText: {
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 240,
    left: -80,
    width: 200,
    height: 200,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },
});