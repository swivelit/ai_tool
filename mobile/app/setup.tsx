import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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

const EXAMPLES = [
  "Hey Elli, remind me to call mom at 7.",
  "Elli, help me plan tomorrow.",
  "Can you schedule a meeting for Friday?",
];

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
  const heroTitleSize = isVerySmallPhone ? 28 : isSmallPhone ? 31 : 36;
  const heroTitleLineHeight = isVerySmallPhone ? 34 : isSmallPhone ? 37 : 42;
  const selectedName = input.trim() || name || "Elli";

  useEffect(() => {
    setInput(name || "");
  }, [name]);

  const nameQuality = useMemo(() => {
    const value = input.trim();
    if (!value) return "Using default";
    if (value.length < 3) return "Short and quick";
    if (value.length < 8) return "Balanced";
    return "Distinctive";
  }, [input]);

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

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={styles.page}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingTop: topPadding,
            paddingBottom: bottomPadding,
            paddingHorizontal: horizontalPadding,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: "100%", maxWidth: 560, alignSelf: "center" }}>
            <View style={styles.topBar}>
              <View style={styles.topBarPill}>
                <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
                <Text style={styles.topBarPillText}>Quick setup</Text>
              </View>

              <Pressable
                onPress={onSkip}
                style={({ pressed }) => [styles.topSkipBtn, pressed && styles.pressed]}
              >
                <Text style={styles.topSkipBtnText}>Skip</Text>
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.heroPill}>
                  <Ionicons name="chatbubble-ellipses-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroPillText}>Assistant identity</Text>
                </View>

                <View style={styles.heroStatusChip}>
                  <Ionicons name="flash-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroStatusText}>Optional step</Text>
                </View>
              </View>

              <Text
                style={[
                  styles.title,
                  {
                    fontSize: heroTitleSize,
                    lineHeight: heroTitleLineHeight,
                  },
                ]}
              >
                Give your assistant a name that feels personal and memorable.
              </Text>

              <Text style={styles.subtitle}>
                This small setup step makes the experience feel warmer and more human.
                You can always change it later from Settings.
              </Text>

              <View style={styles.metricRow}>
                <MetricCard label="Current name" value={selectedName} icon="sparkles-outline" />
                <MetricCard label="Style" value={nameQuality} icon="color-wand-outline" />
                <MetricCard label="Default" value="Elli" icon="star-outline" />
              </View>

              <LinearGradient
                colors={["rgba(255,255,255,0.88)", "rgba(255,239,210,0.72)"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.previewCard}
              >
                <View style={styles.previewBadge}>
                  <Ionicons name="mic-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.previewBadgeText}>Live preview</Text>
                </View>

                <Text style={styles.previewTitle}>{selectedName}</Text>
                <Text style={styles.previewText}>
                  “Hey {selectedName}, remind me to call mom at 7.”
                </Text>
              </LinearGradient>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <Text style={styles.sectionTitle}>Choose assistant name</Text>
              <Text style={styles.sectionSubtitle}>
                Short names work best in voice prompts and quick typed commands.
              </Text>

              <Text style={styles.label}>Assistant name</Text>
              <View style={styles.inputShell}>
                <View style={styles.inputIconWrap}>
                  <Ionicons name="sparkles-outline" size={16} color={Brand.bronze} />
                </View>

                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder={`Default: ${name || "Elli"}`}
                  placeholderTextColor="rgba(124, 99, 80, 0.52)"
                  style={styles.input}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>

              <View style={styles.examplePanel}>
                <View style={styles.examplePanelHeader}>
                  <Ionicons
                    name="chatbubble-ellipses-outline"
                    size={16}
                    color={Brand.bronze}
                  />
                  <Text style={styles.examplePanelTitle}>Usage examples</Text>
                </View>

                <View style={styles.exampleList}>
                  {EXAMPLES.map((example, index) => (
                    <Text key={index} style={styles.exampleText}>
                      {example.replace(/Elli/g, selectedName)}
                    </Text>
                  ))}
                </View>
              </View>

              <Pressable
                onPress={onContinue}
                style={({ pressed }) => [styles.buttonShell, pressed && styles.pressed]}
              >
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

              <Pressable
                onPress={onSkip}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Ionicons name="play-skip-forward-outline" size={18} color={Brand.cocoa} />
                <Text style={styles.secondaryButtonText}>Skip and use Elli</Text>
              </Pressable>
            </GlassCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
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

  topBar: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topBarPill: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topBarPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  topSkipBtn: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topSkipBtnText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroPill: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroStatusChip: {
    minHeight: 34,
    paddingHorizontal: 11,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricRow: {
    marginTop: 20,
    flexDirection: "row",
    gap: 10,
  },

  metricCard: {
    flex: 1,
    minHeight: 96,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  metricValue: {
    marginTop: 12,
    color: Brand.ink,
    fontSize: 16,
    fontWeight: "900",
  },

  metricLabel: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  previewCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  previewTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  previewText: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  label: {
    color: Brand.cocoa,
    fontSize: 13,
    fontWeight: "800",
    marginTop: 18,
    marginBottom: 8,
  },

  inputShell: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },

  inputIconWrap: {
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },

  input: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    paddingRight: 14,
  },

  examplePanel: {
    marginTop: 16,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  examplePanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  examplePanelTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  exampleList: {
    marginTop: 10,
    gap: 8,
  },

  exampleText: {
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
    minHeight: 54,
    marginTop: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.78)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
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