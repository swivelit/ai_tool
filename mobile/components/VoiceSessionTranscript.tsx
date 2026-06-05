import React, { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { Brand } from "@/constants/theme";

export type VoiceSessionTurn = {
  id: string;
  userText: string;
  assistantText: string;
  status: "listening" | "thinking" | "done" | "error";
  replyLanguage?: string | null;
  ttsStatus?: string | null;
};

type Props = {
  turns: VoiceSessionTurn[];
  onScrollEnd?: () => void;
};

export function VoiceSessionTranscript({
  turns,
  onScrollEnd,
}: Props) {
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      onScrollEnd?.();
    }, 80);
    return () => clearTimeout(timeout);
  }, [onScrollEnd, turns.length]);

  return (
    <View
      testID="voice-session-transcript"
      accessibilityLabel="voice-session-transcript"
      style={styles.wrap}
    >
      <ScrollView
        ref={scrollRef}
        testID="voice-session-scroll"
        accessibilityLabel="voice-session-scroll"
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {turns.map((turn) => (
          <View key={turn.id} style={styles.turn}>
            {turn.userText ? (
              <View style={styles.userRow}>
                <Text
                  testID="voice-session-user-turn"
                  accessibilityLabel="voice-session-user-turn"
                  style={styles.userBubble}
                >
                  {turn.userText}
                </Text>
              </View>
            ) : null}

            {turn.assistantText || turn.status === "thinking" || turn.status === "listening" ? (
              <View style={styles.assistantRow}>
                <Text
                  testID="voice-session-assistant-turn"
                  accessibilityLabel="voice-session-assistant-turn"
                  style={[styles.assistantBubble, turn.status === "error" && styles.errorBubble]}
                >
                  {turn.assistantText ||
                    (turn.status === "listening" ? "Listening..." : "Preparing reply...")}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(3, 4, 5, 0.96)", "rgba(3, 4, 5, 0)"]}
        style={styles.topFade}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 16,
    width: "100%",
    maxWidth: 360,
    maxHeight: 190,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  scroll: {
    width: "100%",
  },
  content: {
    minHeight: 72,
    paddingHorizontal: 12,
    paddingTop: 30,
    paddingBottom: 8,
    gap: 8,
  },
  topFade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 44,
  },
  turn: {
    gap: 8,
  },
  userRow: {
    alignItems: "flex-end",
  },
  assistantRow: {
    alignItems: "flex-start",
  },
  userBubble: {
    maxWidth: "88%",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: Brand.bronze,
    color: Brand.cream,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  assistantBubble: {
    maxWidth: "92%",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    color: Brand.ink,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  errorBubble: {
    color: Brand.danger,
  },
});
