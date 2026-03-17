import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { Brand } from "@/constants/theme";

type OrbProps = {
  listening: boolean;
  onPress: () => void;
  size?: number;
};

export function Orb({ listening, onPress, size = 168 }: OrbProps) {
  const floatAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const activeAnim = useRef(new Animated.Value(0)).current;
  const ringRotateAnim = useRef(new Animated.Value(0)).current;
  const orbitAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 1900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const ringLoop = Animated.loop(
      Animated.timing(ringRotateAnim, {
        toValue: 1,
        duration: 16000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    const orbitLoop = Animated.loop(
      Animated.timing(orbitAnim, {
        toValue: 1,
        duration: 5200,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    floatLoop.start();
    pulseLoop.start();
    ringLoop.start();
    orbitLoop.start();

    return () => {
      floatLoop.stop();
      pulseLoop.stop();
      ringLoop.stop();
      orbitLoop.stop();
    };
  }, [floatAnim, orbitAnim, pulseAnim, ringRotateAnim]);

  useEffect(() => {
    Animated.timing(activeAnim, {
      toValue: listening ? 1 : 0,
      duration: 260,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [activeAnim, listening]);

  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [5, -9],
  });

  const haloScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.98, 1.08],
  });

  const haloOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.24, 0.5],
  });

  const activeScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });

  const activeOpacity = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.14, 0.72],
  });

  const coreScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.03],
  });

  const ringRotate = ringRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const reverseRingRotate = ringRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "-360deg"],
  });

  const orbitRotate = orbitAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const shellColors = useMemo(
    () => ["#fffdf8", "#ffeecf", "#ffd99f", "#c7843f"] as const,
    []
  );

  const oceanColors = useMemo(
    () => ["#fff8ec", "#ffe6b7", "#efbc74", "#b86e31"] as const,
    []
  );

  return (
    <Pressable
      onPress={onPress}
      style={{ alignItems: "center", justifyContent: "center" }}
      accessibilityRole="button"
      accessibilityLabel={listening ? "Stop recording" : "Start voice input"}
    >
      <View
        style={{
          width: size + 110,
          height: size + 110,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: size + 96,
            height: size + 96,
            borderRadius: 999,
            backgroundColor: "rgba(255, 229, 180, 0.22)",
            transform: [{ scale: haloScale }],
            opacity: haloOpacity,
          }}
        />

        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: size + 58,
            height: size + 58,
            borderRadius: 999,
            backgroundColor: "rgba(215, 154, 89, 0.18)",
            transform: [{ scale: activeScale }],
            opacity: activeOpacity,
          }}
        />

        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: size + 52,
            height: size + 52,
            transform: [{ rotate: orbitRotate }],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              position: "absolute",
              width: size + 52,
              height: size + 52,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "rgba(124, 84, 52, 0.16)",
            }}
          />
          <View
            style={{
              position: "absolute",
              top: 0,
              width: 14,
              height: 14,
              borderRadius: 999,
              backgroundColor: Brand.warmWhite,
              borderWidth: 3,
              borderColor: "rgba(255, 229, 180, 0.75)",
              shadowColor: "#f4c785",
              shadowOpacity: 0.35,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            }}
          />
        </Animated.View>

        <Animated.View style={{ transform: [{ translateY }, { scale: coreScale }] }}>
          <LinearGradient
            colors={shellColors}
            start={{ x: 0.15, y: 0.08 }}
            end={{ x: 0.86, y: 0.95 }}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#d59856",
              shadowOpacity: 0.28,
              shadowRadius: 28,
              shadowOffset: { width: 0, height: 16 },
              elevation: 14,
            }}
          >
            <View
              style={{
                width: size - 14,
                height: size - 14,
                borderRadius: (size - 14) / 2,
                overflow: "hidden",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.58)",
                backgroundColor: "rgba(255, 247, 233, 0.7)",
              }}
            >
              <LinearGradient
                colors={oceanColors}
                start={{ x: 0.18, y: 0.1 }}
                end={{ x: 0.84, y: 0.94 }}
                style={{ flex: 1, borderRadius: 999 }}
              />

              <Animated.View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  transform: [{ rotate: ringRotate }],
                }}
              >
                <View
                  style={{
                    width: size - 40,
                    height: size - 40,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "rgba(124, 84, 52, 0.18)",
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    width: size - 62,
                    height: size - 20,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "rgba(124, 84, 52, 0.12)",
                    transform: [{ rotate: "88deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    width: size - 38,
                    height: (size - 38) * 0.46,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "rgba(124, 84, 52, 0.12)",
                    transform: [{ translateY: -16 }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    width: size - 38,
                    height: (size - 38) * 0.46,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "rgba(124, 84, 52, 0.12)",
                    transform: [{ translateY: 16 }],
                  }}
                />
              </Animated.View>

              <Animated.View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  transform: [{ rotate: reverseRingRotate }],
                }}
              >
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.24,
                    left: size * 0.17,
                    width: size * 0.34,
                    height: size * 0.19,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.18)",
                    transform: [{ rotate: "-16deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.44,
                    left: size * 0.21,
                    width: size * 0.22,
                    height: size * 0.14,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.16)",
                    transform: [{ rotate: "12deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.32,
                    right: size * 0.16,
                    width: size * 0.28,
                    height: size * 0.18,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.18)",
                    transform: [{ rotate: "22deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.52,
                    right: size * 0.23,
                    width: size * 0.18,
                    height: size * 0.11,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.14)",
                    transform: [{ rotate: "-18deg" }],
                  }}
                />
              </Animated.View>

              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 16,
                  left: 18,
                  width: size * 0.34,
                  height: size * 0.16,
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.44)",
                  transform: [{ rotate: "-18deg" }],
                }}
              />

              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  right: 24,
                  bottom: 22,
                  width: size * 0.2,
                  height: size * 0.2,
                  borderRadius: 999,
                  backgroundColor: "rgba(124, 84, 52, 0.08)",
                }}
              />
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </Pressable>
  );
}