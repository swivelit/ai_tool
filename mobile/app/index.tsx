import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";

export default function LandingScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 12 : 18);
  const bottomPadding = Math.max(insets.bottom + 30, 30);
  const maxContentWidth = Math.min(width - horizontalPadding * 2, 520);
  const primaryHeight = isCompact ? 54 : 58;

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

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
          <GlassCard style={styles.card}>
            <Text style={styles.title}>
              {user ? "Welcome back" : "Get started"}
            </Text>

            <Text style={styles.subtitle}>
              {user
                ? "Continue where you left off."
                : "Login or create your account to continue."}
            </Text>

            <Pressable
              onPress={() => {
                if (user) {
                  router.push("/(tabs)");
                  return;
                }

                router.push("./auth/login");
              }}
              style={({ pressed }) => [
                styles.buttonShell,
                pressed && styles.pressed,
                { marginTop: 24 },
              ]}
            >
              <LinearGradient
                colors={Brand.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.primaryButton, { minHeight: primaryHeight }]}
              >
                <Text style={styles.primaryButtonText}>
                  {user ? "Continue to app" : "Login"}
                </Text>
              </LinearGradient>
            </Pressable>

            {!user ? (
              <Pressable
                onPress={() => router.push("./auth/signup")}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                  { minHeight: primaryHeight, marginTop: 12 },
                ]}
              >
                <Text style={styles.secondaryButtonText}>Create account</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push("/setup")}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                  { minHeight: primaryHeight, marginTop: 12 },
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  Choose a new name
                </Text>
              </Pressable>
            )}
          </GlassCard>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  card: {
    borderRadius: 32,
  },

  title: {
    color: Brand.ink,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 15,
    lineHeight: 23,
  },

  buttonShell: {
    borderRadius: 18,
    overflow: "hidden",
  },

  primaryButton: {
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    shadowColor: "#d4934f",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },

  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  secondaryButton: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.78)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  secondaryButtonText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});