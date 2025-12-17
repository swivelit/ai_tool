import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

export function Orb({
  listening,
  onPress,
}: {
  listening: boolean;
  onPress: () => void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    Animated.timing(glow, {
      toValue: listening ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [listening, glow]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const glowScale = glow.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.25] });
  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.85] });

  const size = 76;

  const gradient = useMemo(
    () => ["rgba(34,211,238,1)", "rgba(139,92,246,1)"] as const,
    []
  );

  return (
    <Pressable onPress={onPress} style={{ alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size + 30, height: size + 30, alignItems: "center", justifyContent: "center" }}>
        <Animated.View
          style={{
            position: "absolute",
            width: size + 26,
            height: size + 26,
            borderRadius: 999,
            transform: [{ scale: glowScale }],
            opacity: glowOpacity,
            backgroundColor: "rgba(34,211,238,0.18)",
          }}
        />
        <Animated.View style={{ transform: [{ scale }] }}>
          <LinearGradient
            colors={gradient}
            start={{ x: 0.1, y: 0.1 }}
            end={{ x: 0.9, y: 0.9 }}
            style={{
              width: size,
              height: size,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOpacity: 0.35,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 10 },
              elevation: 10,
            }}
          >
            <View
              style={{
                width: size - 10,
                height: size - 10,
                borderRadius: 999,
                backgroundColor: "rgba(10,15,30,0.55)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.12)",
              }}
            />
          </LinearGradient>
        </Animated.View>
      </View>
    </Pressable>
  );
}
