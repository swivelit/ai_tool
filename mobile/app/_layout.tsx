import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, router, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { AssistantProvider, useAssistant } from "@/components/AssistantProvider";
import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { getProfileForFirebaseUid, UserProfile } from "@/lib/account";
import {
  APP_BOOT_TIMEOUT_MS,
  LOCAL_AGENT_SEED_TIMEOUT_MS,
  PROFILE_BOOT_TIMEOUT_MS,
  getPendingBootSteps,
  resolveDesiredRoute,
  runBootStep,
} from "@/lib/appBoot";
import { ensureLocalAgentSeedData } from "@/lib/localAgentBootstrap";

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
  const pathname = usePathname();
  const { user } = useAuth();
  const { profile } = useAssistant();
  const [fallbackProfile, setFallbackProfile] = useState<UserProfile | null>(null);
  const [profileLookupLoading, setProfileLookupLoading] = useState(false);
  const lastNavigationRef = useRef<string | null>(null);

  const providerProfile = user && profile?.firebaseUid === user.uid ? profile : null;

  useEffect(() => {
    if (!user) {
      setFallbackProfile(null);
      setProfileLookupLoading(false);
      return;
    }

    if (providerProfile) {
      setFallbackProfile(null);
      setProfileLookupLoading(false);
      return;
    }

    let alive = true;
    setProfileLookupLoading(true);

    void (async () => {
      const result = await runBootStep(
        "profile bootstrap",
        () => getProfileForFirebaseUid(user.uid, user.email),
        {
          timeoutMs: PROFILE_BOOT_TIMEOUT_MS,
          optional: true,
        }
      );

      if (!alive) {
        return;
      }

      if (result.status === "completed") {
        setFallbackProfile(result.value ?? null);
      } else {
        setFallbackProfile(null);
      }

      setProfileLookupLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [providerProfile, user?.email, user?.uid]);

  const activeProfile = providerProfile || fallbackProfile;

  const targetRoute = useMemo(
    () =>
      resolveDesiredRoute({
        pathname,
        hasUser: Boolean(user),
        hasProfile: Boolean(activeProfile?.userId),
        questionnaireCompleted: Boolean(activeProfile?.questionnaireCompleted),
      }),
    [activeProfile?.questionnaireCompleted, activeProfile?.userId, pathname, user]
  );

  useEffect(() => {
    if (!targetRoute || targetRoute === pathname) {
      lastNavigationRef.current = null;
      return;
    }

    if (lastNavigationRef.current === targetRoute) {
      return;
    }

    lastNavigationRef.current = targetRoute;
    router.replace(targetRoute);
  }, [pathname, targetRoute]);

  if (user && !activeProfile && profileLookupLoading) {
    return <BootScreen />;
  }

  return null;
}

function AppShell() {
  const { loading: authLoading } = useAuth();
  const { loading: profileLoading } = useAssistant();
  const [localAgentLoading, setLocalAgentLoading] = useState(true);
  const [bootTimedOut, setBootTimedOut] = useState(false);

  useEffect(() => {
    let alive = true;

    void (async () => {
      await runBootStep("local agent seed bootstrap", ensureLocalAgentSeedData, {
        timeoutMs: LOCAL_AGENT_SEED_TIMEOUT_MS,
        optional: true,
      });

      if (alive) {
        setLocalAgentLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const pendingBootSteps = useMemo(
    () =>
      getPendingBootSteps({
        authLoading,
        profileLoading,
        localSeedLoading: localAgentLoading,
      }),
    [authLoading, localAgentLoading, profileLoading]
  );

  useEffect(() => {
    if (!pendingBootSteps.length) {
      setBootTimedOut(false);
      return;
    }

    const timer = setTimeout(() => {
      console.warn(
        `[boot] App boot watchdog tripped after ${APP_BOOT_TIMEOUT_MS}ms. Continuing with pending steps: ${pendingBootSteps.join(
          ", "
        )}.`
      );
      setBootTimedOut(true);
    }, APP_BOOT_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [pendingBootSteps]);

  if (!bootTimedOut && pendingBootSteps.length) {
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
