import React, { useEffect, useRef } from "react";
import { Animated, View } from "react-native";

export function Waveform({ active }: { active: boolean }) {
  const bars = Array.from({ length: 10 }).map(() => useRef(new Animated.Value(0.2)).current);

  useEffect(() => {
    if (!active) {
      bars.forEach((b) => b.setValue(0.2));
      return;
    }

    const loops = bars.map((b, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(b, { toValue: 1, duration: 220 + i * 18, useNativeDriver: true }),
          Animated.timing(b, { toValue: 0.25, duration: 240 + i * 22, useNativeDriver: true }),
        ])
      )
    );

    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active]);

  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-end", height: 30 }}>
      {bars.map((b, idx) => {
        const h = b.interpolate({ inputRange: [0, 1], outputRange: [6, 28] });
        const o = b.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.95] });
        return (
          <Animated.View
            key={idx}
            style={{
              width: 6,
              height: 28,
              borderRadius: 99,
              backgroundColor: "rgba(34,211,238,0.9)",
              transform: [{ scaleY: h.interpolate({ inputRange: [6, 28], outputRange: [0.2, 1] }) }],
              opacity: o,
            }}
          />
        );
      })}
    </View>
  );
}
