import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { Brand } from "@/constants/theme";

type OrbProps = {
  listening: boolean;
  onPressIn?: () => void;
  onPressOut?: () => void;
  size?: number;
};

/**
 * Premium-looking orb control.
 * - Voice is captured only while the orb is being held.
 * - Motion is designed to feel polished, physical, and responsive.
 */
export function Orb({
  listening,
  onPressIn,
  onPressOut,
  size = 168,
}: OrbProps) {
  const float = useSharedValue(0);
  const breathe = useSharedValue(0);
  const ring = useSharedValue(0);
  const ring2 = useSharedValue(0);
  const orbit = useSharedValue(0);
  const shimmer = useSharedValue(0);

  const active = useSharedValue(listening ? 1 : 0);
  const pressed = useSharedValue(0);

  const pressInFiredRef = useRef(false);

  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, {
        duration: 2600,
        easing: Easing.inOut(Easing.sin),
      }),
      -1,
      true
    );

    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1800, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );

    ring.value = withRepeat(
      withTiming(1, { duration: 16000, easing: Easing.linear }),
      -1,
      false
    );

    ring2.value = withRepeat(
      withTiming(1, { duration: 22000, easing: Easing.linear }),
      -1,
      false
    );

    orbit.value = withRepeat(
      withTiming(1, { duration: 5200, easing: Easing.linear }),
      -1,
      false
    );

    shimmer.value = withRepeat(
      withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.quad) }),
      -1,
      false
    );
  }, [breathe, float, orbit, ring, ring2, shimmer]);

  useEffect(() => {
    active.value = withTiming(listening ? 1 : 0, {
      duration: 240,
      easing: Easing.out(Easing.quad),
    });
  }, [active, listening]);

  const shellColors = useMemo(
    () => ["#fffdf8", "#ffeecf", "#ffd99f", "#c7843f"] as const,
    []
  );

  const coreColors = useMemo(
    () => ["#fff8ec", "#ffe6b7", "#efbc74", "#b86e31"] as const,
    []
  );

  const translateYStyle = useAnimatedStyle(() => {
    const y = interpolate(float.value, [0, 1], [5, -9]);
    const pressLift = interpolate(pressed.value, [0, 1], [0, -6]);
    const tilt = interpolate(active.value, [0, 1], [0.6, 1.6]);
    const rot = interpolate(float.value, [0, 1], [-tilt, tilt]);

    return {
      transform: [{ translateY: y + pressLift }, { rotate: `${rot}deg` }],
    };
  });

  const haloStyle = useAnimatedStyle(() => {
    const baseScale = interpolate(breathe.value, [0, 1], [0.98, 1.09]);
    const baseOpacity = interpolate(breathe.value, [0, 1], [0.18, 0.46]);
    const activeBoost = interpolate(active.value, [0, 1], [0, 0.24]);
    const pressBoost = interpolate(pressed.value, [0, 1], [0, 0.16]);

    return {
      opacity: Math.min(0.7, baseOpacity + activeBoost + pressBoost),
      transform: [
        { scale: baseScale + active.value * 0.08 + pressed.value * 0.06 },
      ],
    };
  });

  const activeGlowStyle = useAnimatedStyle(() => {
    const scale = interpolate(active.value, [0, 1], [1.0, 1.14]);
    const opacity = interpolate(active.value, [0, 1], [0.08, 0.62]);
    return { opacity, transform: [{ scale }] };
  });

  const coreScaleStyle = useAnimatedStyle(() => {
    const scale = interpolate(active.value, [0, 1], [1.0, 1.04]);
    const pressScale = interpolate(pressed.value, [0, 1], [1.0, 1.02]);
    return { transform: [{ scale: scale * pressScale }] };
  });

  const ringStyle = useAnimatedStyle(() => {
    const deg = interpolate(ring.value, [0, 1], [0, 360]);
    const wobble = interpolate(active.value, [0, 1], [0, 10]);
    return { transform: [{ rotate: `${deg + wobble}deg` }] };
  });

  const ringStyle2 = useAnimatedStyle(() => {
    const deg = interpolate(ring2.value, [0, 1], [0, -360]);
    return {
      transform: [{ rotate: `${deg}deg` }],
      opacity: interpolate(active.value, [0, 1], [0.85, 1.0]),
    };
  });

  const orbitStyle = useAnimatedStyle(() => {
    const deg = interpolate(orbit.value, [0, 1], [0, 360]);
    return {
      transform: [{ rotate: `${deg}deg` }],
      opacity: interpolate(active.value, [0, 1], [0.85, 1.0]),
    };
  });

  const shimmerStyle = useAnimatedStyle(() => {
    const travel = size * 1.25;
    const x = interpolate(shimmer.value, [0, 1], [-travel, travel]);
    const opacity = interpolate(breathe.value, [0, 1], [0.18, 0.35]);
    const activeBoost = interpolate(active.value, [0, 1], [0, 0.18]);
    return {
      opacity: Math.min(0.62, opacity + activeBoost),
      transform: [{ translateX: x }, { rotate: "-18deg" }],
    };
  });

  const handlePressIn = () => {
    if (pressInFiredRef.current) return;
    pressInFiredRef.current = true;

    pressed.value = withTiming(1, {
      duration: 120,
      easing: Easing.out(Easing.quad),
    });
    onPressIn?.();
  };

  const handlePressOut = () => {
    if (!pressInFiredRef.current) return;
    pressInFiredRef.current = false;

    pressed.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.quad),
    });
    onPressOut?.();
  };

  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={
        listening ? "Recording, release to stop" : "Hold the orb to record"
      }
      accessibilityHint="Press and hold the orb to record. Release to stop and send."
      style={styles.pressable}
      onStartShouldSetResponder={() => true}
      onResponderGrant={handlePressIn}
      onResponderRelease={handlePressOut}
      onResponderTerminate={handlePressOut}
      onResponderTerminationRequest={() => true}
      onTouchCancel={handlePressOut}
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
            haloStyle,
            {
              width: size + 98,
              height: size + 98,
              borderRadius: 999,
              backgroundColor: "rgba(255, 229, 180, 0.22)",
            },
          ]}
        />

        <Animated.View
          pointerEvents="none"
          style={[
            styles.absCenter,
            activeGlowStyle,
            {
              width: size + 58,
              height: size + 58,
              borderRadius: 999,
              backgroundColor: "rgba(215, 154, 89, 0.20)",
            },
          ]}
        />

        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              width: size + 54,
              height: size + 54,
              alignItems: "center",
              justifyContent: "center",
            },
            orbitStyle,
          ]}
        >
          <View
            style={{
              position: "absolute",
              width: size + 54,
              height: size + 54,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "rgba(124, 84, 52, 0.15)",
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
              borderColor: "rgba(255, 229, 180, 0.78)",
              shadowColor: "#f4c785",
              shadowOpacity: 0.35,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            }}
          />
        </Animated.View>

        <Animated.View style={[translateYStyle, coreScaleStyle]}>
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
              shadowOpacity: 0.3,
              shadowRadius: 30,
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
                borderColor: "rgba(255,255,255,0.62)",
                backgroundColor: "rgba(255, 247, 233, 0.72)",
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
                style={[styles.absFillCenter, ringStyle]}
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
                style={[styles.absFill, ringStyle2]}
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
                    backgroundColor: "rgba(124, 84, 52, 0.10)",
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

              <Animated.View
                pointerEvents="none"
                style={[styles.shimmerWrap, shimmerStyle]}
              >
                <LinearGradient
                  colors={[
                    "rgba(255,255,255,0)",
                    "rgba(255,255,255,0.40)",
                    "rgba(255,255,255,0)",
                  ]}
                  locations={[0, 0.5, 1]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.absFill}
                />
              </Animated.View>

              <LinearGradient
                colors={["rgba(255,255,255,0.52)", "rgba(255,255,255,0.06)"]}
                start={{ x: 0.14, y: 0.1 }}
                end={{ x: 0.82, y: 0.88 }}
                style={[styles.absFill, { borderRadius: 999 }]}
              />
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </View>
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
  shimmerWrap: {
    position: "absolute",
    top: "-35%",
    left: "-35%",
    width: "170%",
    height: "170%",
  },
});