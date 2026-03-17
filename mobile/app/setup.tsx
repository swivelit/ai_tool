import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";

export default function Setup() {
  const { updateName, name } = useAssistant();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [input, setInput] = useState(name || "");

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 14);
  const bottomPadding = Math.max(insets.bottom + 24, 24);

  useEffect(() => {
    setInput(name || "");
  }, [name]);

  async function onContinue() {
    const trimmed = input.trim();
    await updateName(trimmed.length ? trimmed : "Elli");
    router.replace("/(tabs)");
  }

  async function onSkip() {
    await updateName("Elli");
    router.replace("/(tabs)");
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
            paddingHorizontal: horizontalPadding,
          }}
        >
          <View style={{ width: "100%", maxWidth: 520, alignSelf: "center" }}>
            <View style={styles.heroPill}>
              <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
              <Text style={styles.heroPillText}>Quick setup</Text>
            </View>

            <Text
              style={[
                styles.title,
                {
                  fontSize: isVerySmallPhone ? 28 : isSmallPhone ? 31 : 34,
                  lineHeight: isVerySmallPhone ? 34 : isSmallPhone ? 37 : 40,
                },
              ]}
            >
              Name your assistant
            </Text>

            <Text style={styles.subtitle}>
              This gives the app a more personal feel. You can change it later in Settings any time.
            </Text>

            <GlassCard style={{ borderRadius: 28, marginTop: 18 }}>
              <Text style={styles.label}>Assistant name</Text>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={`Default: ${name || "Elli"}`}
                placeholderTextColor="rgba(124, 99, 80, 0.52)"
                style={styles.input}
              />

              <View style={styles.exampleCard}>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={Brand.bronze} />
                <Text style={styles.exampleText}>
                  Example: “Hey {input.trim() || name || "Elli"}, remind me to call mom at 7.”
                </Text>
              </View>

              <Pressable onPress={onContinue} style={({ pressed }) => [styles.buttonShell, pressed && styles.pressed]}>
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
                </LinearGradient>
              </Pressable>

              <Pressable onPress={onSkip} style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}>
                <Text style={styles.skipText}>Skip and use Elli</Text>
              </Pressable>
            </GlassCard>
          </View>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
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

  heroPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 16,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  label: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
  },

  input: {
    height: 56,
    borderRadius: 18,
    paddingHorizontal: 14,
    color: Brand.ink,
    fontSize: 15,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  exampleCard: {
    marginTop: 16,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  exampleText: {
    flex: 1,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  buttonShell: {
    borderRadius: 18,
    overflow: "hidden",
    marginTop: 22,
  },

  primaryButton: {
    minHeight: 56,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  primaryButtonText: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  skipButton: {
    minHeight: 48,
    marginTop: 12,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  skipText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});