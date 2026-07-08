import React, { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { Tabs, router, useRootNavigationState } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

import { HapticTab } from "@/components/haptic-tab";
import { useAuth } from "@/components/AuthProvider";
import { Spacing, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";

function TabIcon({
  focused,
  color,
  name,
}: {
  focused: boolean;
  color: string;
  name: keyof typeof Ionicons.glyphMap;
}) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      {focused ? (
        <LinearGradient
          colors={t.gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.iconGradient}
        >
          <Ionicons name={name} size={18} color={t.ink} />
        </LinearGradient>
      ) : (
        <Ionicons name={name} size={18} color={color} />
      )}
    </View>
  );
}

function LoadingScreen() {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <LinearGradient colors={t.gradients.page} style={styles.loadingPage}>
      <ActivityIndicator size="small" color={t.bronze} />
    </LinearGradient>
  );
}

export default function TabLayout() {
  const { user, loading } = useAuth();
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const rootNavigationState = useRootNavigationState();
  const hasRedirectedRef = useRef(false);

  const navigatorReady = Boolean(rootNavigationState?.key);

  useEffect(() => {
    if (loading || user || !navigatorReady) {
      hasRedirectedRef.current = false;
      return;
    }

    if (hasRedirectedRef.current) {
      return;
    }

    hasRedirectedRef.current = true;

    const frame = requestAnimationFrame(() => {
      // Important:
      // "/" is ambiguous in this app because both:
      // - app/index.tsx
      // - app/(tabs)/index.tsx
      // resolve there.
      //
      // After delete/sign-out, use an unambiguous public route so we always
      // escape the tabs tree instead of getting stuck on the tabs loading screen.
      router.replace("/auth/login");
    });

    return () => cancelAnimationFrame(frame);
  }, [loading, navigatorReady, user]);

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <LoadingScreen />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarButton: HapticTab,
        sceneStyle: { backgroundColor: "transparent" },
        tabBarActiveTintColor: t.ink,
        tabBarInactiveTintColor: t.muted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.3,
          marginTop: Spacing.xxs,
          marginBottom: Platform.OS === "ios" ? 0 : Spacing.xs,
        },
        tabBarItemStyle: {
          paddingTop: Spacing.xs,
        },
        tabBarStyle: {
          height: Platform.OS === "ios" ? 84 : 74,
          paddingTop: 8,
          paddingBottom: Platform.OS === "ios" ? 12 : 10,
          borderTopWidth: 0,
          backgroundColor: "transparent",
          elevation: 0,
          shadowColor: "#000000",
          shadowOpacity: 0.12,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: -6 },
        },
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView
              intensity={18}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient
              colors={t.gradients.softCard}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.topBorder} />
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="explore"
        options={{
          title: "Schedule",
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} name="calendar-clear-outline" />
          ),
        }}
      />

      <Tabs.Screen
        name="routine"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} name="settings-outline" />
          ),
        }}
      />
    </Tabs>
  );
}

function createStyles(t: Palette) {
  return StyleSheet.create({
  loadingPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  topBorder: {
    position: "absolute",
    top: 0,
    left: 16,
    right: 16,
    height: 1,
    backgroundColor: t.line,
  },

  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },

  iconWrapActive: {
    shadowColor: "#57deff",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },

  iconGradient: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  });
}
