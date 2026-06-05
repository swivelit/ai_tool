import React, { useEffect, useMemo, useRef } from "react";
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from "react-native";
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

import {
  type CharacterMode,
  type CharacterState,
  type Emotion,
  emotionShape,
  resolveCharacterVisuals,
} from "@/lib/assistantCharacter";

type AssistantCharacterProps = {
  state?: CharacterState;
  emotion?: Emotion;
  mouthOpenness?: number;
  mode?: CharacterMode;
  size?: number;
  listening?: boolean;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHidden?: boolean;
  style?: StyleProp<ViewStyle>;
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function TestableView({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View pointerEvents="none" style={style}>{children}</View>;
}

export function AssistantCharacter({
  state = "idle",
  emotion = "neutral",
  mouthOpenness = 0,
  mode = "hero",
  size = 172,
  listening,
  onPress,
  onPressIn,
  onPressOut,
  testID,
  accessibilityLabel = "Hold the assistant to talk",
  accessibilityHidden = false,
  style,
}: AssistantCharacterProps) {
  const float = useSharedValue(0);
  const breathe = useSharedValue(0);
  const blink = useSharedValue(1);
  const shimmer = useSharedValue(0);
  const pressed = useSharedValue(0);
  const active = useSharedValue(state === "idle" ? 0 : 1);

  const pressInFiredRef = useRef(false);

  const effectiveState: CharacterState =
    listening && state === "idle" ? "listening" : state;
  const isFloating = mode === "floating";
  const bodyWidth = Math.round(size * (isFloating ? 0.76 : 0.82));
  const bodyHeight = Math.round(size * (isFloating ? 0.96 : 1.08));
  const containerWidth = Math.round(size * (isFloating ? 1.05 : 1.48));
  const containerHeight = Math.round(size * (isFloating ? 1.18 : 1.48));
  const eyeSize = Math.max(12, bodyWidth * 0.25);
  const eyeTop = bodyHeight * 0.28;
  const eyeGap = bodyWidth * 0.06;
  const resolvedMouthOpenness = clamp01(mouthOpenness);

  const visuals = useMemo(
    () =>
      resolveCharacterVisuals({
        state: effectiveState,
        emotion,
        amplitude: resolvedMouthOpenness,
        blink: 1,
        speakingWave: 1,
      }),
    [effectiveState, emotion, resolvedMouthOpenness],
  );
  const shape = useMemo(() => emotionShape(emotion), [emotion]);
  const componentTestID =
    testID ||
    (mode === "floating" ? "floating-assistant-character" : "voice-assistant-character");
  const interactive = Boolean(onPress || onPressIn || onPressOut);

  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, { duration: 2700, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    blink.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2200, easing: Easing.linear }),
        withTiming(0.08, { duration: 70, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 1300, easing: Easing.linear }),
        withTiming(0.12, { duration: 65, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 105, easing: Easing.out(Easing.quad) }),
      ),
      -1,
      false,
    );
    shimmer.value = withRepeat(
      withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
  }, [blink, breathe, float, shimmer]);

  useEffect(() => {
    active.value = withTiming(effectiveState === "idle" ? 0 : 1, {
      duration: 220,
      easing: Easing.out(Easing.quad),
    });
  }, [active, effectiveState]);

  const pressRetentionOffset = useMemo(
    () => ({ top: 96, right: 96, bottom: 96, left: 96 }),
    [],
  );

  const containerMotionStyle = useAnimatedStyle(() => {
    const y = interpolate(float.value, [0, 1], [isFloating ? 2 : 5, isFloating ? -4 : -9]);
    const lift = interpolate(pressed.value, [0, 1], [0, isFloating ? -2 : -5]);
    const rot = interpolate(float.value, [0, 1], [-1.2, 1.2]);
    const pressScale = interpolate(pressed.value, [0, 1], [1, 1.015]);

    return {
      transform: [
        { translateY: y + lift },
        { rotate: `${rot}deg` },
        { scale: pressScale },
      ],
    };
  });

  const auraStyle = useAnimatedStyle(() => {
    const base = interpolate(breathe.value, [0, 1], [0.96, 1.08]);
    const stateBoost = interpolate(active.value, [0, 1], [0, 0.08]);
    const opacity = Math.min(
      0.56,
      visuals.glow + interpolate(breathe.value, [0, 1], [0.02, 0.16]),
    );
    return {
      opacity,
      transform: [{ scale: base + stateBoost }],
    };
  });

  const shimmerStyle = useAnimatedStyle(() => {
    const x = interpolate(shimmer.value, [0, 1], [-bodyWidth * 1.2, bodyWidth * 1.2]);
    return {
      opacity: interpolate(breathe.value, [0, 1], [0.14, 0.32]),
      transform: [{ translateX: x }, { rotate: "-18deg" }],
    };
  });

  const eyeAnimatedStyle = useAnimatedStyle(() => {
    const open = Math.max(0.08, blink.value * visuals.eyeScaleY);
    return {
      transform: [{ scaleY: open }],
    };
  });

  const ledStyle = useAnimatedStyle(() => {
    const pulse = interpolate(breathe.value, [0, 1], [0.7, 1]);
    const activeOpacity = interpolate(active.value, [0, 1], [0.32, 0.9]);
    return {
      opacity: activeOpacity,
      transform: [{ scale: pulse + active.value * 0.08 }],
    };
  });

  const handlePressIn = () => {
    if (pressInFiredRef.current) return;
    pressInFiredRef.current = true;
    pressed.value = withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) });
    onPressIn?.();
  };

  const handlePressOut = () => {
    if (!pressInFiredRef.current) return;
    pressInFiredRef.current = false;
    pressed.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) });
    onPressOut?.();
  };

  const body = (
    <TestableView
      style={[
        styles.frame,
        {
          width: containerWidth,
          height: containerHeight,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.aura,
          auraStyle,
          {
            width: size * 1.02,
            height: size * 1.02,
            borderRadius: size,
            backgroundColor:
              effectiveState === "listening"
                ? "rgba(82, 221, 255, 0.20)"
                : effectiveState === "speaking"
                  ? "rgba(137, 118, 255, 0.18)"
                  : "rgba(255, 255, 255, 0.08)",
          },
        ]}
      />

      <Animated.View style={[styles.characterLift, containerMotionStyle]}>
        <View
          style={[
            styles.baseShadow,
            {
              width: bodyWidth * 0.86,
              height: Math.max(10, size * 0.07),
              borderRadius: size,
              bottom: -bodyHeight * 0.055,
            },
          ]}
        />

        <LinearGradient
          colors={["#1c222b", "#030405", "#121820"]}
          start={{ x: 0.08, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={[
            styles.bodyShell,
            {
              width: bodyWidth,
              height: bodyHeight,
              borderRadius: bodyWidth * 0.22,
            },
          ]}
        >
          <LinearGradient
            colors={["rgba(255,255,255,0.22)", "rgba(255,255,255,0.04)", "rgba(255,255,255,0)"]}
            locations={[0, 0.38, 1]}
            start={{ x: 0.16, y: 0.02 }}
            end={{ x: 0.84, y: 0.78 }}
            style={StyleSheet.absoluteFillObject}
          />

          <Animated.View style={[styles.shimmer, shimmerStyle]}>
            <LinearGradient
              colors={["rgba(255,255,255,0)", "rgba(255,255,255,0.42)", "rgba(255,255,255,0)"]}
              locations={[0, 0.5, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
          </Animated.View>

          <View
            style={[
              styles.facePanel,
              {
                top: bodyHeight * 0.16,
                left: bodyWidth * 0.1,
                right: bodyWidth * 0.1,
                height: bodyHeight * 0.57,
                borderRadius: bodyWidth * 0.18,
              },
            ]}
          />

          <View
            style={[
              styles.eyesRow,
              {
                top: eyeTop,
                left: bodyWidth * 0.13,
                right: bodyWidth * 0.13,
                gap: eyeGap,
              },
            ]}
          >
            {["left", "right"].map((side) => {
              const isLeft = side === "left";
              return (
                <View key={side} style={{ width: eyeSize, height: eyeSize * 0.72 }}>
                  <Animated.View
                    style={[
                      styles.eye,
                      eyeAnimatedStyle,
                      {
                        width: eyeSize,
                        height: eyeSize * 0.72,
                        borderRadius: eyeSize * 0.28,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.pupil,
                        {
                          width: eyeSize * 0.28,
                          height: eyeSize * 0.32,
                          borderRadius: eyeSize * 0.18,
                          transform: [
                            { translateX: isLeft ? eyeSize * 0.02 : -eyeSize * 0.02 },
                            { translateY: shape.pupilShiftY * eyeSize * 0.12 },
                          ],
                        },
                      ]}
                    />
                    <View style={styles.eyeSparkle} />
                  </Animated.View>

                  <View
                    style={[
                      styles.brow,
                      {
                        width: eyeSize * 0.78,
                        top: -eyeSize * 0.34,
                        left: eyeSize * 0.1,
                        transform: [
                          {
                            rotate: `${isLeft ? -visuals.browTilt : visuals.browTilt}deg`,
                          },
                        ],
                      },
                    ]}
                  />

                  {[0, 1, 2].map((lash) => (
                    <View
                      key={lash}
                      style={[
                        styles.lash,
                        {
                          top: -eyeSize * 0.12,
                          left: eyeSize * (0.12 + lash * 0.22),
                          transform: [{ rotate: `${isLeft ? -18 - lash * 4 : 18 + lash * 4}deg` }],
                        },
                      ]}
                    />
                  ))}
                </View>
              );
            })}
          </View>

          <View
            style={[
              styles.cheek,
              {
                top: bodyHeight * 0.52,
                left: bodyWidth * 0.18,
                opacity: emotion === "happy" || emotion === "excited" ? 0.36 : 0.14,
              },
            ]}
          />
          <View
            style={[
              styles.cheek,
              {
                top: bodyHeight * 0.52,
                right: bodyWidth * 0.18,
                opacity: emotion === "happy" || emotion === "excited" ? 0.36 : 0.14,
              },
            ]}
          />

          <View
            style={[
              styles.mouthTrack,
              {
                top: bodyHeight * 0.62,
                width: bodyWidth * (0.2 + Math.abs(visuals.mouthCurve) * 0.07),
                height: Math.max(5, bodyHeight * (0.024 + visuals.mouthOpenness * 0.075)),
                borderRadius: bodyWidth * 0.08,
                transform: [
                  { translateY: visuals.mouthCurve < 0 ? bodyHeight * 0.02 : 0 },
                  { rotate: `${visuals.mouthCurve < -0.2 ? "180deg" : "0deg"}` },
                ],
              },
            ]}
          >
            <LinearGradient
              colors={["#ff8ba2", "#4f0717"]}
              start={{ x: 0.2, y: 0 }}
              end={{ x: 0.8, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
          </View>

          <Animated.View
            style={[
              styles.sideLed,
              ledStyle,
              {
                width: Math.max(8, bodyWidth * 0.07),
                height: bodyHeight * 0.22,
                right: -Math.max(4, bodyWidth * 0.035),
                top: bodyHeight * 0.43,
                borderRadius: bodyWidth * 0.06,
                backgroundColor:
                  effectiveState === "listening"
                    ? "#5cf0ff"
                    : effectiveState === "speaking"
                      ? "#9a8cff"
                      : "#dce7ff",
              },
            ]}
          />

          <View
            style={[
              styles.lowerSensor,
              {
                width: bodyWidth * 0.22,
                height: bodyHeight * 0.018,
                bottom: bodyHeight * 0.13,
              },
            ]}
          />
        </LinearGradient>

        <View
          style={[
            styles.wheels,
            {
              width: bodyWidth * 0.76,
              bottom: -bodyHeight * 0.035,
            },
          ]}
        >
          <View style={[styles.wheel, { width: bodyWidth * 0.2, height: bodyWidth * 0.1 }]} />
          <View style={[styles.wheel, { width: bodyWidth * 0.2, height: bodyWidth * 0.1 }]} />
        </View>
      </Animated.View>
    </TestableView>
  );

  if (!interactive) {
    return (
      <View
        accessible={false}
        accessibilityElementsHidden={accessibilityHidden}
        importantForAccessibility={accessibilityHidden ? "no-hide-descendants" : "no"}
        testID={componentTestID}
        style={[styles.host, style]}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Press and hold the assistant to record. Release to stop and send."
      testID={componentTestID}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={24}
      pressRetentionOffset={pressRetentionOffset}
      android_disableSound
      style={[styles.host, style]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: {
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    alignItems: "center",
    justifyContent: "center",
  },
  aura: {
    position: "absolute",
    shadowColor: "#4fdfff",
    shadowOpacity: 0.32,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  characterLift: {
    alignItems: "center",
    justifyContent: "center",
  },
  baseShadow: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  bodyShell: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "#050607",
    shadowColor: "#000000",
    shadowOpacity: 0.62,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
    elevation: 16,
  },
  shimmer: {
    position: "absolute",
    top: "-18%",
    bottom: "-18%",
    width: "40%",
  },
  facePanel: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "rgba(255,255,255,0.035)",
  },
  eyesRow: {
    position: "absolute",
    flexDirection: "row",
    justifyContent: "center",
  },
  eye: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fbff",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.82)",
    overflow: "hidden",
    shadowColor: "#ffffff",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  pupil: {
    backgroundColor: "#071018",
  },
  eyeSparkle: {
    position: "absolute",
    top: "20%",
    left: "28%",
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.95)",
  },
  brow: {
    position: "absolute",
    height: 3,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.86)",
  },
  lash: {
    position: "absolute",
    width: 2,
    height: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.86)",
  },
  cheek: {
    position: "absolute",
    width: 18,
    height: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,121,151,0.46)",
  },
  mouthTrack: {
    position: "absolute",
    alignSelf: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,139,162,0.36)",
    backgroundColor: "#4f0717",
  },
  sideLed: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.26)",
    shadowColor: "#5cf0ff",
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  lowerSensor: {
    position: "absolute",
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  wheels: {
    position: "absolute",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  wheel: {
    borderRadius: 999,
    backgroundColor: "#050607",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
});
