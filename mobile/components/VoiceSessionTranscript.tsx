import React, { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

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
  status?: string | null;
  replyLanguage?: string | null;
  onScrollEnd?: () => void;
};

export function VoiceSessionTranscript({
  turns,
  status,
  replyLanguage,
  onScrollEnd,
}: Props) {
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      onScrollEnd?.();
    }, 80);
    return () => clearTimeout(timeout);
  }, [onScrollEnd, turns.length, status]);

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
        {!turns.length && !status ? (
          <Text style={styles.emptyHint}>
            Hold the orb. Your speech and reply will appear here.
          </Text>
        ) : null}
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
        {status ? (
          <Text style={styles.status}>
            {status}
            {replyLanguage ? ` (${replyLanguage})` : ""}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 16,
    width: "100%",
    maxWidth: 360,
    maxHeight: 220,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: "rgba(255,255,255,0.76)",
  },
  scroll: {
    width: "100%",
  },
  content: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
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
    backgroundColor: Brand.cocoa,
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
    backgroundColor: "rgba(255, 245, 231, 0.92)",
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
  status: {
    color: Brand.textMuted,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
    textAlign: "center",
  },
  emptyHint: {
    color: Brand.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "800",
    textAlign: "center",
  },
});
