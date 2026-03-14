import React, { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, Text } from "react-native";
import { Stack, router, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { AssistantProvider, useAssistant } from "@/components/AssistantProvider";
import { getProfileForFirebaseUid, UserProfile } from "@/lib/account";

function BootScreen() {
  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color="white" />
        <Text style={{ marginTop: 14, color: "rgba(255,255,255,0.75)", fontSize: 14 }}>
          Loading J AI...
        </Text>
      </SafeAreaView>
    </LinearGradient>
  );
}

function RouteGate() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { profile } = useAssistant();

  const [storedProfile, setStoredProfile] = useState<UserProfile | null>(null);
  const [checkingStoredProfile, setCheckingStoredProfile] = useState(true);

  useEffect(() => {
    let alive = true;

    async function loadStoredProfile() {
      try {
        if (!user?.uid) {
          if (alive) {
            setStoredProfile(null);
            setCheckingStoredProfile(false);
          }
          return;
        }

        setCheckingStoredProfile(true);
        const localProfile = await getProfileForFirebaseUid(user.uid);

        if (!alive) return;
        setStoredProfile(localProfile);
      } finally {
        if (alive) {
          setCheckingStoredProfile(false);
        }
      }
    }

    void loadStoredProfile();

    return () => {
      alive = false;
    };
  }, [
    user?.uid,
    profile?.firebaseUid,
    profile?.userId,
    profile?.questionnaireCompleted,
  ]);

  useEffect(() => {
    if (checkingStoredProfile) return;

    const providerProfile =
      user && profile?.firebaseUid === user.uid ? profile : null;

    const localProfile =
      user && storedProfile?.firebaseUid === user.uid ? storedProfile : null;

    const activeProfile = providerProfile || localProfile;

    const hasProfile = Boolean(activeProfile?.userId);
    const questionnaireCompleted = Boolean(activeProfile?.questionnaireCompleted);

    const inAuth = pathname.startsWith("/auth");
    const inOnboarding = pathname.startsWith("/onboarding");
    const atRoot = pathname === "/";
    const atProfile = pathname === "/onboarding/profile";
    const atQuestionnaire = pathname === "/onboarding/questionnaire";

    if (!user) {
      if (!inAuth && !atRoot) {
        router.replace("/");
      }
      return;
    }

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

    if (inAuth || inOnboarding || atRoot || pathname === "/setup") {
      router.replace("/(tabs)");
    }
  }, [checkingStoredProfile, pathname, profile, storedProfile, user]);

  if (user && checkingStoredProfile) {
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
      <StatusBar style="light" />
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