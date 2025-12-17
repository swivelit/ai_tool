import React from "react";
import { View, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

export function GlassCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          borderRadius: 20,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.10)",
          backgroundColor: "rgba(255,255,255,0.06)",
        },
        style,
      ]}
    >
      <BlurView intensity={22} tint="dark" style={{ padding: 16 }}>
        <LinearGradient
          colors={["rgba(34,211,238,0.12)", "rgba(139,92,246,0.08)", "rgba(0,0,0,0)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: "absolute", inset: 0 }}
        />
        {children}
      </BlurView>
    </View>
  );
}
