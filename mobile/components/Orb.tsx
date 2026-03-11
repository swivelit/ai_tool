import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

type OrbProps = {
  listening: boolean;
  onPress: () => void;
  size?: number;
};

export function Orb({ listening, onPress, size = 168 }: OrbProps) {
  const floatAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const activeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 2600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 2600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    floatLoop.start();
    pulseLoop.start();

    return () => {
      floatLoop.stop();
      pulseLoop.stop();
    };
  }, [floatAnim, pulseAnim]);

  useEffect(() => {
    Animated.timing(activeAnim, {
      toValue: listening ? 1 : 0,
      duration: 260,
      useNativeDriver: true,
    }).start();
  }, [listening, activeAnim]);

  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [5, -7],
  });

  const haloScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1.08],
  });

  const haloOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.28, 0.55],
  });

  const activeScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });

  const activeOpacity = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.16, 0.72],
  });

  const shellColors = useMemo(
    () =>
      [
        "rgba(76,214,255,0.95)",
        "rgba(23,135,255,0.85)",
        "rgba(8,32,80,0.95)",
      ] as const,
    []
  );

  return (
    <Pressable onPress={onPress} style={{ alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: size + 90,
          height: size + 90,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            width: size + 82,
            height: size + 82,
            borderRadius: 999,
            backgroundColor: "rgba(56,189,248,0.12)",
            transform: [{ scale: haloScale }],
            opacity: haloOpacity,
          }}
        />
        <Animated.View
          style={{
            position: "absolute",
            width: size + 46,
            height: size + 46,
            borderRadius: 999,
            backgroundColor: "rgba(34,211,238,0.18)",
            transform: [{ scale: activeScale }],
            opacity: activeOpacity,
          }}
        />
        <Animated.View
          style={{
            transform: [{ translateY }],
          }}
        >
          <LinearGradient
            colors={shellColors}
            start={{ x: 0.2, y: 0.1 }}
            end={{ x: 0.8, y: 0.95 }}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#2DD4FF",
              shadowOpacity: 0.32,
              shadowRadius: 26,
              shadowOffset: { width: 0, height: 10 },
              elevation: 12,
            }}
          >
            <View
              style={{
                width: size - 16,
                height: size - 16,
                borderRadius: (size - 16) / 2,
                overflow: "hidden",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.12)",
                backgroundColor: "rgba(1,11,29,0.65)",
              }}
            >
              <LinearGradient
                colors={[
                  "rgba(255,255,255,0.25)",
                  "rgba(255,255,255,0.02)",
                  "rgba(0,0,0,0.10)",
                ]}
                start={{ x: 0.15, y: 0.08 }}
                end={{ x: 0.82, y: 0.92 }}
                style={{ flex: 1, borderRadius: 999 }}
              />
              <View
                style={{
                  position: "absolute",
                  top: 18,
                  left: 20,
                  width: size * 0.28,
                  height: size * 0.16,
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.18)",
                  transform: [{ rotate: "-18deg" }],
                }}
              />
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </Pressable>
  );
}