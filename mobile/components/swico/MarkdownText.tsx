import React, { useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { useAppTheme } from "@/hooks/use-app-theme";

function CodeBlock({ value, language, colors }: { value: string; language: string; colors: ReturnType<typeof useAppTheme>["palette"] }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.codeBlock, { backgroundColor: colors.isDark ? "#171717" : "#ececec", borderColor: colors.line }]}>
      <View style={styles.codeHeader}>
        <Text style={[styles.codeLanguage, { color: colors.muted }]}>{language || "code"}</Text>
        <Pressable onPress={() => void Clipboard.setStringAsync(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} hitSlop={8}>
          <Text style={[styles.copyCode, { color: colors.accent }]}>{copied ? "Copied" : "Copy code"}</Text>
        </Pressable>
      </View>
      <Text selectable style={[styles.codeText, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

export function MarkdownText({ value }: { value: string }) {
  const { palette: colors } = useAppTheme();
  const rules = useMemo<RenderRules>(() => ({
    link: (node, children, _parent, styles) => (
      <Text key={node.key} style={[styles.link, { color: colors.accent }]} onPress={() => void Linking.openURL(String(node.attributes?.href || ""))}>{children}</Text>
    ),
    code_block: (node) => <CodeBlock key={node.key} value={String(node.content || "").replace(/\n$/, "")} language={String((node as any).info || "").trim()} colors={colors} />,
    fence: (node) => <CodeBlock key={node.key} value={String(node.content || "").replace(/\n$/, "")} language={String((node as any).info || "").trim()} colors={colors} />,
  }), [colors]);
  const markdownStyle = useMemo(() => ({
    body: { color: colors.text, fontSize: 15, lineHeight: 23 },
    heading1: { color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: "800", marginTop: 10, marginBottom: 6 },
    heading2: { color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: "800", marginTop: 9, marginBottom: 5 },
    heading3: { color: colors.text, fontSize: 17, lineHeight: 23, fontWeight: "800", marginTop: 8, marginBottom: 4 },
    paragraph: { marginTop: 0, marginBottom: 7 },
    bullet_list: { marginTop: 2, marginBottom: 4 },
    ordered_list: { marginTop: 2, marginBottom: 4 },
    list_item: { marginTop: 1, marginBottom: 1 },
    blockquote: { backgroundColor: colors.soft, borderLeftColor: colors.lineStrong, borderLeftWidth: 3, paddingHorizontal: 10, marginLeft: 0 },
    code_inline: { color: colors.text, backgroundColor: colors.soft, fontFamily: "monospace", paddingHorizontal: 3 },
    table: { borderWidth: 1, borderColor: colors.line },
    th: { backgroundColor: colors.soft, color: colors.text, fontWeight: "800", padding: 6 },
    td: { color: colors.text, borderColor: colors.line, padding: 6 },
    hr: { backgroundColor: colors.line, height: 1 },
  }), [colors]);
  return <Markdown style={markdownStyle as any} rules={rules} onLinkPress={(url) => { void Linking.openURL(url); return false; }}>{String(value || "")}</Markdown>;
}

const styles = StyleSheet.create({
  codeBlock: { borderWidth: 1, borderRadius: 10, overflow: "hidden", marginVertical: 7 },
  codeHeader: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: "rgba(128,128,128,0.25)" },
  codeLanguage: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  copyCode: { fontSize: 11, fontWeight: "800" },
  codeText: { fontFamily: "monospace", fontSize: 12, lineHeight: 18, padding: 10 },
});
