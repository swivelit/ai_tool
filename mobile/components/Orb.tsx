import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

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
  const iconAnim = useRef(new Animated.Value(0)).current;

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

    const ringLoop = Animated.loop(
      Animated.timing(ringRotateAnim, {
        toValue: 1,
        duration: 15000,
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

    const iconLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(iconAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(iconAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    floatLoop.start();
    pulseLoop.start();
    ringLoop.start();
    orbitLoop.start();
    iconLoop.start();

    return () => {
      floatLoop.stop();
      pulseLoop.stop();
      ringLoop.stop();
      orbitLoop.stop();
      iconLoop.stop();
    };
  }, [floatAnim, iconAnim, orbitAnim, pulseAnim, ringRotateAnim]);

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
    outputRange: [0.22, 0.48],
  });

  const activeScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });

  const activeOpacity = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.12, 0.7],
  });

  const coreScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.035],
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

  const iconScale = iconAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });

  const shellColors = useMemo(
    () => ["#fffdf8", "#ffeecf", "#ffd99f", "#c7843f"] as const,
    []
  );

  const coreColors = useMemo(
    () => ["#fff8ec", "#ffe6b7", "#efbc74", "#b86e31"] as const,
    []
  );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={listening ? "Stop recording" : "Start voice input"}
      style={styles.pressable}
    >
      <View
        style={{
          width: size + 112,
          height: size + 112,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.absCenter,
            {
              width: size + 98,
              height: size + 98,
              borderRadius: 999,
              backgroundColor: "rgba(255, 229, 180, 0.22)",
              transform: [{ scale: haloScale }],
              opacity: haloOpacity,
            },
          ]}
        />

        <Animated.View
          pointerEvents="none"
          style={[
            styles.absCenter,
            {
              width: size + 58,
              height: size + 58,
              borderRadius: 999,
              backgroundColor: "rgba(215, 154, 89, 0.18)",
              transform: [{ scale: activeScale }],
              opacity: activeOpacity,
            },
          ]}
        />

        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: size + 54,
            height: size + 54,
            alignItems: "center",
            justifyContent: "center",
            transform: [{ rotate: orbitRotate }],
          }}
        >
          <View
            style={{
              position: "absolute",
              width: size + 54,
              height: size + 54,
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
                colors={coreColors}
                start={{ x: 0.18, y: 0.1 }}
                end={{ x: 0.84, y: 0.94 }}
                style={{ flex: 1, borderRadius: 999 }}
              />

              <Animated.View
                pointerEvents="none"
                style={[
                  styles.absFillCenter,
                  {
                    transform: [{ rotate: ringRotate }],
                  },
                ]}
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
                style={[
                  styles.absFill,
                  {
                    transform: [{ rotate: reverseRingRotate }],
                  },
                ]}
              >
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.22,
                    left: size * 0.18,
                    width: size * 0.32,
                    height: size * 0.18,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.14)",
                    transform: [{ rotate: "-16deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    top: size * 0.49,
                    right: size * 0.18,
                    width: size * 0.24,
                    height: size * 0.15,
                    borderRadius: 999,
                    backgroundColor: "rgba(124, 84, 52, 0.1)",
                    transform: [{ rotate: "18deg" }],
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    bottom: size * 0.18,
                    left: size * 0.24,
                    width: size * 0.14,
                    height: size * 0.14,
                    borderRadius: 999,
                    backgroundColor: "rgba(255,255,255,0.22)",
                  }}
                />
              </Animated.View>

              <LinearGradient
                colors={["rgba(255,255,255,0.5)", "rgba(255,255,255,0.06)"]}
                start={{ x: 0.14, y: 0.1 }}
                end={{ x: 0.82, y: 0.88 }}
                style={[
                  styles.absFill,
                  {
                    borderRadius: 999,
                  },
                ]}
              />

              <Animated.View
                pointerEvents="none"
                style={[
                  styles.absFillCenter,
                  {
                    transform: [{ scale: iconScale }],
                  },
                ]}
              >
                <View
                  style={{
                    width: size * 0.34,
                    height: size * 0.34,
                    borderRadius: 999,
                    backgroundColor: listening
                      ? "rgba(255,248,236,0.28)"
                      : "rgba(255,248,236,0.18)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.26)",
                    alignItems: "center",
                    justifyContent: "center",
                    shadowColor: "#f7d6a0",
                    shadowOpacity: 0.22,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 4,
                  }}
                >
                  <Ionicons
                    name={listening ? "stop" : "mic"}
                    size={size * 0.16}
                    color={Brand.ink}
                  />
                </View>
              </Animated.View>
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    alignItems: "center",
    justifyContent: "center",
  },

  absCenter: {
    position: "absolute",
  },

  absFill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },

  absFillCenter: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});