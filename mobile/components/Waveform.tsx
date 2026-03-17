import React, { useEffect, useMemo } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { Brand } from "@/constants/theme";

type WaveformProps = {
  active: boolean;
};

export function Waveform({ active }: WaveformProps) {
  const bars = useMemo(
    () => Array.from({ length: 12 }, () => new Animated.Value(0.18)),
    []
  );

  useEffect(() => {
    if (!active) {
      bars.forEach((bar) => {
        Animated.timing(bar, {
          toValue: 0.18,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      });
      return;
    }

    const loops = bars.map((bar, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(bar, {
            toValue: 1,
            duration: 180 + index * 18,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(bar, {
            toValue: 0.24,
            duration: 220 + index * 22,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      )
    );

    loops.forEach((loop, index) => {
      setTimeout(() => loop.start(), index * 28);
    });

    return () => {
      loops.forEach((loop) => loop.stop());
    };
  }, [active, bars]);

  return (
    <View style={styles.row}>
      {bars.map((bar, index) => {
        const opacity = bar.interpolate({
          inputRange: [0, 1],
          outputRange: [0.35, 0.96],
        });

        const scaleY = bar.interpolate({
          inputRange: [0, 1],
          outputRange: [0.18, 1],
        });

        const translateY = bar.interpolate({
          inputRange: [0, 1],
          outputRange: [7, 0],
        });

        return (
          <Animated.View
            key={index}
            style={[
              styles.bar,
              {
                backgroundColor: index % 2 === 0 ? Brand.caramel : Brand.bronze,
                opacity,
                transform: [{ translateY }, { scaleY }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: 32,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 6,
  },

  bar: {
    width: 6,
    height: 30,
    borderRadius: 999,
  },
});