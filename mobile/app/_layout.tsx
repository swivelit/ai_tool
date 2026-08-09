import React, { useEffect } from "react";
import { ActivityIndicator, LogBox, StyleSheet, Text, View } from "react-native";
import { Stack, router, usePathname, useRootNavigationState, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";
import { isAnyE2eEnvEnabled } from "@/lib/e2eMode";

if (isAnyE2eEnvEnabled()) {
  LogBox.ignoreAllLogs(true);
}

function BootScreen() {
  return <LinearGradient testID="boot-loading-screen" colors={Brand.gradients.page} style={styles.boot}>
    <ActivityIndicator color={Brand.caramel} />
    <Text style={styles.bootTitle}>Loading Swico...</Text>
    <Text style={styles.bootText}>Restoring your account.</Text>
  </LinearGradient>;
}

function AppShell() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const segments = useSegments();
  const navigation = useRootNavigationState();
  const isAuthPath = pathname.startsWith("/auth/");
  const inChat = String(segments[0] || "") === "(chat)";
  const isPublicPath = (pathname === "/" && !inChat) || isAuthPath;

  useEffect(() => {
    if (loading || !navigation?.key) return;
    if (user && !inChat) {
      router.replace("/(chat)");
    } else if (!user && !isPublicPath) {
      router.replace("/");
    }
  }, [inChat, isPublicPath, loading, navigation?.key, pathname, user]);

  return <View style={styles.root}>
    <StatusBar style="light" />
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth/login" />
      <Stack.Screen name="auth/signup" />
      <Stack.Screen name="auth/forgot-password" />
      <Stack.Screen name="(chat)/index" />
      <Stack.Screen name="onboarding/profile" />
      <Stack.Screen name="onboarding/questionnaire" />
      <Stack.Screen name="setup" />
      <Stack.Screen name="model-setup" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="item/[id]" />
      <Stack.Screen name="modal" options={{ presentation: "modal" }} />
    </Stack>
    {loading || !navigation?.key ? <View style={styles.overlay}><BootScreen /></View> : null}
  </View>;
}

export default function RootLayout() {
  return <AuthProvider><AppShell /></AuthProvider>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject },
  boot: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  bootTitle: { color: Brand.ink, fontSize: 19, fontWeight: "900" },
  bootText: { color: Brand.muted, fontSize: 13 },
});
