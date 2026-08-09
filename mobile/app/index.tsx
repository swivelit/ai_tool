import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/components/AuthProvider";
import { Radius, Spacing } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";

export default function LandingScreen() {
  const { user } = useAuth();
  const { palette: t, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 12 : 18);
  const bottomPadding = Math.max(insets.bottom + 30, 30);
  const maxContentWidth = Math.min(width - horizontalPadding * 2, 520);
  const primaryHeight = isCompact ? 54 : 58;

  return (
    <View style={[styles.page, { backgroundColor: t.background }]}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
          justifyContent: "center",
        }}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            width: "100%",
            alignSelf: "center",
            maxWidth: maxContentWidth,
          }}
        >
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
            <Text style={[styles.title, { color: t.text }]}>
              {user ? "Welcome back" : "Get started"}
            </Text>

            <Text style={[styles.subtitle, { color: t.muted }]}>
              {user
                ? "Continue where you left off."
                : "Login or create your account to continue."}
            </Text>

            <Pressable
              onPress={() => {
                if (user) {
                  router.push("/(chat)" as any);
                  return;
                }

                router.push("/auth/login");
              }}
              style={({ pressed }) => [styles.primaryButton, { backgroundColor: t.accent, marginTop: 24 }, pressed && styles.pressed]}
            >
                <Text style={[styles.primaryButtonText, { color: t.accentText }]}>
                  {user ? "Continue to app" : "Login"}
                </Text>
            </Pressable>

            {!user ? (
              <Pressable
                onPress={() => router.push("/auth/signup")}
                style={({ pressed }) => [styles.secondaryButton, { minHeight: primaryHeight, marginTop: 12, borderColor: t.line }, pressed && styles.pressed]}
              >
                <Text style={[styles.secondaryButtonText, { color: t.text }]}>Create account</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push("/setup")}
                style={({ pressed }) => [styles.secondaryButton, { minHeight: primaryHeight, marginTop: 12, borderColor: t.line }, pressed && styles.pressed]}
              >
                <Text style={[styles.secondaryButtonText, { color: t.text }]}>
                  Choose a new name
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  card: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.xl,
  },

  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 23,
  },

  buttonShell: {
    borderRadius: Radius.md,
  },

  primaryButton: {
    borderRadius: Radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  primaryButtonText: {
    fontSize: 15,
    fontWeight: "900",
  },

  secondaryButton: {
    borderRadius: Radius.md,
    borderWidth: 1,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});
