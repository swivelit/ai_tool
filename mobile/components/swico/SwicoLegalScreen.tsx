import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import legalContent from "../../../web/src/content/legalContent.json";
import { useAppTheme } from "@/hooks/use-app-theme";

type PageId = keyof typeof legalContent.pages;
export function SwicoLegalScreen({ page, onClose }: { page: string; onClose: () => void }) {
  const { palette: t } = useAppTheme();
  const pageData = legalContent.pages[page as PageId] || legalContent.pages.terms;
  return <View style={[styles.root, { backgroundColor: t.background }]}><View style={styles.header}><Pressable onPress={onClose} accessibilityLabel="Close legal page"><Ionicons name="arrow-back" size={23} color={t.text} /></Pressable><Text style={[styles.title, { color: t.text }]}>{pageData.title}</Text></View><ScrollView contentContainerStyle={styles.content}>{<Text style={[styles.summary, { color: t.muted }]}>{pageData.summary}</Text>}{pageData.sections.map(section => <View key={section.heading} style={styles.section}><Text style={[styles.heading, { color: t.text }]}>{section.heading}</Text><Text style={[styles.body, { color: t.muted }]}>{section.body}</Text></View>)}</ScrollView></View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, header: { padding: 16, paddingTop: 52, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1 }, title: { fontSize: 18, fontWeight: "800", flex: 1 }, content: { padding: 20, paddingBottom: 48 }, summary: { fontSize: 14, lineHeight: 21, marginBottom: 20 }, section: { marginBottom: 22 }, heading: { fontSize: 16, fontWeight: "800", marginBottom: 8 }, body: { fontSize: 14, lineHeight: 22 } });

