import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

import { Brand } from "@/constants/theme";

export function GlassCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.shell, style]}>
      <BlurView
        intensity={24}
        tint="light"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFillObject}
      />

      <LinearGradient
        colors={[
          "rgba(255,255,255,0.42)",
          "rgba(255,244,224,0.24)",
          "rgba(215,154,89,0.08)",
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={styles.topSheen} />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.38)",
    backgroundColor: "rgba(255, 249, 239, 0.34)",
    shadowColor: "#a56522",
    shadowOpacity: 0.1,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },

  content: {
    padding: 18,
  },

  topSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "46%",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
});