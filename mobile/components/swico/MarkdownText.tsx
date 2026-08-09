import React from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { Brand } from "@/constants/theme";

function inlineParts(value: string) {
  return value.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
}

export function MarkdownText({ value }: { value: string }) {
  const lines = String(value || "").split("\n");
  return (
    <View style={styles.root}>
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <View key={`space-${index}`} style={styles.space} />;
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) return null;
        const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
        const bullet = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
        const content = heading?.[1] || bullet?.[1] || trimmed;
        const parts = inlineParts(content);
        return (
          <View key={`line-${index}`} style={bullet ? styles.bulletRow : undefined}>
            {bullet ? <Text style={styles.bullet}>•</Text> : null}
            <Text style={[styles.text, heading && styles.heading]}>
              {parts.map((part, partIndex) => {
                const code = part.startsWith("`") && part.endsWith("`");
                const bold = part.startsWith("**") && part.endsWith("**");
                const italic = part.startsWith("*") && part.endsWith("*") && !bold;
                const display = code || bold || italic ? part.slice(bold ? 2 : 1, bold ? -2 : -1) : part;
                if (/^https?:\/\//.test(display)) {
                  return <Text key={partIndex} style={styles.link} onPress={() => void Linking.openURL(display)}>{display}</Text>;
                }
                return <Text key={partIndex} style={[code && styles.code, bold && styles.bold, italic && styles.italic]}>{display}</Text>;
              })}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4 }, text: { color: Brand.text, fontSize: 15, lineHeight: 23 }, heading: { fontSize: 18, lineHeight: 25, fontWeight: "800", marginTop: 8 }, space: { height: 4 }, bulletRow: { flexDirection: "row", gap: 8 }, bullet: { color: Brand.caramel, fontSize: 18, lineHeight: 23 }, code: { fontFamily: "monospace", backgroundColor: Brand.soft, color: Brand.caramel }, bold: { fontWeight: "800" }, italic: { fontStyle: "italic" }, link: { color: Brand.caramel, textDecorationLine: "underline" },
});
