import React, { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Redirect, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { AssistantProvider, useAssistant } from "@/components/AssistantProvider";
import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { resolveDesiredRoute } from "@/lib/appBoot";

function BootScreen() {
  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.bootPage}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <GlassCard style={styles.bootCardShell}>
        <View style={styles.bootCard}>
          <ActivityIndicator size="small" color={Brand.bronze} />
          <Text style={styles.bootTitle}>Loading J AI...</Text>
          <Text style={styles.bootText}>Setting things up.</Text>
        </View>
      </GlassCard>
    </LinearGradient>
  );
}

function AppShell() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useAssistant();

  const activeProfile = useMemo(() => {
    if (!user) return null;
    if (!profile) return null;
    if (profile.firebaseUid && profile.firebaseUid !== user.uid) return null;
    return profile;
  }, [profile, user]);

  const targetRoute = useMemo(
    () =>
      resolveDesiredRoute({
        pathname,
        hasUser: Boolean(user),
        hasProfile: Boolean(activeProfile?.userId),
        questionnaireCompleted: Boolean(activeProfile?.questionnaireCompleted),
      }),
    [pathname, user, activeProfile?.userId, activeProfile?.questionnaireCompleted]
  );

  if (authLoading || profileLoading) {
    return <BootScreen />;
  }

  // Important:
  // Use declarative redirects here instead of router.replace() inside useEffect.
  // The previous imperative redirect loop is what caused:
  // "Maximum update depth exceeded" during account deletion / sign-out transitions.
  if (targetRoute) {
    return <Redirect href={targetRoute as any} />;
  }

  return (
    <View style={styles.appShell}>
      <StatusBar style="dark" />

      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="auth/login" />
        <Stack.Screen name="auth/signup" />
        <Stack.Screen name="onboarding/profile" />
        <Stack.Screen name="onboarding/questionnaire" />
        <Stack.Screen name="setup" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" />
        <Stack.Screen name="modal" options={{ presentation: "modal" }} />
      </Stack>
    </View>
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
  appShell: {
    flex: 1,
  },

  bootPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  bootCardShell: {
    borderRadius: 28,
    minWidth: 240,
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