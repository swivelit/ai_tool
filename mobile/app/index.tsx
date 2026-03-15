import React from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAuth } from "@/components/AuthProvider";

export default function LandingScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;

  const horizontalPadding = isSmallPhone ? 16 : 18;
  const topPadding = insets.top + (isSmallPhone ? 10 : 16);
  const bottomPadding = Math.max(insets.bottom + 24, 24);
  const maxContentWidth = Math.min(width - horizontalPadding * 2, 520);
  const badgeSize = isSmallPhone ? 40 : 42;
  const buttonHeight = isSmallPhone ? 52 : 54;
  const cardRadius = isSmallPhone ? 24 : 28;

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#0B4C9C"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
          justifyContent: height > 760 ? "center" : "flex-start",
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
          <View style={headerRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text
                style={{
                  color: "white",
                  fontSize: isVerySmallPhone ? 28 : isSmallPhone ? 30 : 32,
                  lineHeight: isVerySmallPhone ? 34 : isSmallPhone ? 36 : 38,
                  fontWeight: "900",
                }}
              >
                J AI
              </Text>

              <Text
                style={{
                  marginTop: 6,
                  color: "rgba(255,255,255,0.68)",
                  fontSize: isSmallPhone ? 13 : 14,
                  lineHeight: isSmallPhone ? 19 : 21,
                }}
              >
                Your persona-aware daily AI companion
              </Text>
            </View>

            <View
              style={[
                badge,
                {
                  width: badgeSize,
                  height: badgeSize,
                  borderRadius: badgeSize / 2,
                },
              ]}
            >
              <Ionicons
                name="sparkles-outline"
                size={isSmallPhone ? 17 : 18}
                color="rgba(173,232,255,0.95)"
              />
            </View>
          </View>

          <GlassCard
            style={{
              marginTop: isSmallPhone ? 18 : 22,
              borderRadius: cardRadius,
              width: "100%",
            }}
          >
            <Text
              style={{
                color: "white",
                fontSize: isVerySmallPhone ? 24 : isSmallPhone ? 26 : 28,
                lineHeight: isVerySmallPhone ? 30 : isSmallPhone ? 32 : 34,
                fontWeight: "900",
              }}
            >
              Login or create your account
            </Text>

            <Text
              style={{
                marginTop: 10,
                color: "rgba(255,255,255,0.72)",
                fontSize: isSmallPhone ? 13 : 14,
                lineHeight: isSmallPhone ? 20 : 21,
              }}
            >
              Use email and password or continue with Google. After login, we’ll finish your
              profile and routine setup.
            </Text>

            <View style={{ marginTop: isSmallPhone ? 16 : 18, gap: isSmallPhone ? 10 : 12 }}>
              <Feature icon="mail-outline" text="Email and password sign up" isSmallPhone={isSmallPhone} />
              <Feature icon="logo-google" text="Google sign-in" isSmallPhone={isSmallPhone} />
              <Feature
                icon="shield-checkmark-outline"
                text="Firebase keeps the session logged in"
                isSmallPhone={isSmallPhone}
              />
            </View>

            <Pressable
              onPress={() => router.push("/auth/login")}
              style={[
                primaryBtn,
                {
                  marginTop: isSmallPhone ? 20 : 22,
                  minHeight: buttonHeight,
                  borderRadius: isSmallPhone ? 16 : 18,
                },
              ]}
            >
              <Text
                style={{
                  color: "#041222",
                  fontWeight: "900",
                  fontSize: isSmallPhone ? 14 : 15,
                }}
              >
                {user ? "Continue" : "Login"}
              </Text>
            </Pressable>

            {!user ? (
              <Pressable
                onPress={() => router.push("/auth/signup")}
                style={[
                  secondaryBtn,
                  {
                    marginTop: 12,
                    minHeight: buttonHeight,
                    borderRadius: isSmallPhone ? 16 : 18,
                  },
                ]}
              >
                <Text
                  style={{
                    color: "white",
                    fontWeight: "900",
                    fontSize: isSmallPhone ? 14 : 15,
                  }}
                >
                  Create account
                </Text>
              </Pressable>
            ) : null}
          </GlassCard>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

function Feature({
  icon,
  text,
  isSmallPhone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  isSmallPhone: boolean;
}) {
  return (
    <View style={featureRow}>
      <Ionicons
        name={icon}
        size={isSmallPhone ? 17 : 18}
        color="rgba(173,232,255,0.95)"
      />
      <Text
        style={{
          flex: 1,
          color: "rgba(255,255,255,0.88)",
          fontSize: isSmallPhone ? 13 : 14,
          fontWeight: "700",
          lineHeight: isSmallPhone ? 18 : 20,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

const headerRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const badge = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const featureRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 10,
};

const primaryBtn = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(98,193,255,0.96)",
};

const secondaryBtn = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};