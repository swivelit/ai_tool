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
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";
import { Brand } from "@/constants/theme";

const FEATURES = [
  {
    icon: "sparkles-outline" as const,
    title: "Assistant-first experience",
    copy: "Everything you need to stay organized, in one place.",
  },
  {
    icon: "shield-checkmark-outline" as const,
    title: "Secure account flow",
    copy: "Your data stays safe and always available.",
  },
  {
    icon: "color-wand-outline" as const,
    title: "Made to feel effortless",
    copy: "Everything feels natural from the first tap.",
  },
];

const HIGHLIGHTS = [
  "Intelligent by design",
  "Ready instantly",
  "Built for you",
];

export default function LandingScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isCompact = width < 370 || height < 760;
  const isVeryCompact = width < 345 || height < 700;
  const horizontalPadding = isCompact ? 16 : 20;
  const topPadding = insets.top + (isCompact ? 12 : 18);
  const bottomPadding = Math.max(insets.bottom + 30, 30);
  const maxContentWidth = Math.min(width - horizontalPadding * 2, 580);
  const heroTitleSize = isVeryCompact ? 34 : isCompact ? 38 : 44;
  const heroTitleLineHeight = isVeryCompact ? 40 : isCompact ? 44 : 50;
  const primaryHeight = isCompact ? 54 : 58;

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
          justifyContent: height > 780 ? "center" : "flex-start",
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
          <View style={styles.heroTopRow}>
            <View style={styles.brandPill}>
              <Ionicons name="sparkles" size={14} color={Brand.bronze} />
              <Text style={styles.brandPillText}>J AI · Built around you</Text>
            </View>

            <View style={styles.heroStatusChip}>
              <Ionicons
                name={user ? "checkmark-circle" : "flash-outline"}
                size={14}
                color={user ? Brand.success : Brand.bronze}
              />
              <Text style={styles.heroStatusText}>
                {user ? "All set" : "Get started"}
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.heroTitle,
              {
                fontSize: heroTitleSize,
                lineHeight: heroTitleLineHeight,
              },
            ]}
          >
            One assistant. Total control.
          </Text>

          <Text style={styles.heroSubtitle}>
            Seamless from the first tap. Everything is ready when you are.
          </Text>

          <View style={styles.highlightRow}>
            {HIGHLIGHTS.map((item) => (
              <View key={item} style={styles.highlightChip}>
                <Text style={styles.highlightChipText}>{item}</Text>
              </View>
            ))}
          </View>

          <GlassCard style={{ borderRadius: 32, marginTop: 22 }}>
            <View style={styles.heroCardTopRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.cardTitle}>
                  {user ? "Welcome back." : "Get started"}
                </Text>
                <Text style={styles.cardSubtitle}>
                  {user
                    ? "You are all set. Pick up right where you left off."
                    : "Secure, simple, and ready in seconds."}
                </Text>
              </View>

              <LinearGradient
                colors={Brand.gradients.hero}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.heroBadge}
              >
                <Ionicons name="sparkles" size={22} color={Brand.ink} />
              </LinearGradient>
            </View>

            <View style={styles.featureList}>
              {FEATURES.map((feature) => (
                <View key={feature.title} style={styles.featureRow}>
                  <View style={styles.featureIconWrap}>
                    <Ionicons name={feature.icon} size={18} color={Brand.bronze} />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={styles.featureTitle}>{feature.title}</Text>
                    <Text style={styles.featureCopy}>{feature.copy}</Text>
                  </View>
                </View>
              ))}
            </View>

            <LinearGradient
              colors={["rgba(255,255,255,0.90)", "rgba(255,239,210,0.76)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.previewCard}
            >
              <View style={styles.previewBadge}>
                <Ionicons
                  name="chatbubble-ellipses-outline"
                  size={14}
                  color={Brand.bronze}
                />
                <Text style={styles.previewBadgeText}>See it work</Text>
              </View>

              <Text style={styles.previewTitle}>“Keep me on track throughout the day.”</Text>
              <Text style={styles.previewCopy}>
                Designed to feel seamless, wherever you are in the app.
              </Text>
            </LinearGradient>

            <Pressable
              onPress={() => router.push(user ? "/(tabs)" : "/auth/login")}
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
                <Ionicons name="arrow-forward" size={18} color={Brand.ink} />
              </LinearGradient>
            </Pressable>

            {!user ? (
              <Pressable
                onPress={() => router.push("/auth/signup")}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                  { minHeight: primaryHeight, marginTop: 12 },
                ]}
              >
                <Ionicons name="person-add-outline" size={18} color={Brand.cocoa} />
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
                <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
                <Text style={styles.secondaryButtonText}>Choose a new name</Text>
              </Pressable>
            )}

            <Text style={styles.footerNote}>
              Crafted for simplicity and everyday reliability.
            </Text>
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

  topGlow: {
    position: "absolute",
    top: -90,
    right: -40,
    width: 230,
    height: 230,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 250,
    left: -90,
    width: 210,
    height: 210,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.36)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -90,
    right: 10,
    width: 270,
    height: 270,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  brandPill: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  brandPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroStatusChip: {
    minHeight: 36,
    paddingHorizontal: 12,
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

  heroTitle: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 15,
    lineHeight: 24,
  },

  highlightRow: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  highlightChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  highlightChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroCardTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  cardTitle: {
    color: Brand.ink,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "900",
  },

  cardSubtitle: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 15,
    lineHeight: 23,
  },

  heroBadge: {
    width: 58,
    height: 58,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.52)",
  },

  featureList: {
    marginTop: 20,
    gap: 12,
  },

  featureRow: {
    borderRadius: 22,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  featureIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  featureTitle: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  featureCopy: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
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
    backgroundColor: "rgba(255,255,255,0.74)",
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
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "900",
  },

  previewCopy: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
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

  footerNote: {
    marginTop: 18,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});