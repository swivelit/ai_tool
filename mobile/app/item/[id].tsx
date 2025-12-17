import React, { useEffect, useState } from "react";
import { SafeAreaView, Text, View, Pressable, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, router } from "expo-router";

import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

import { GlassCard } from "@/components/Glass";
import { apiGet, apiPost, API_BASE } from "@/lib/api";
import { Item } from "@/lib/types";
import { createPdfFromItem, createCsvFromItem } from "@/lib/localDocs";

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = Number(id);
  const [item, setItem] = useState<Item | null>(null);

  async function load() {
    try {
      const data = await apiGet<Item>(`/items/${itemId}`);
      setItem(data);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to load item");
    }
  }

  useEffect(() => {
    if (!Number.isFinite(itemId)) return;
    load();
  }, [itemId]);

  async function gen(kind: "pdf" | "docx" | "excel" | "ppt") {
    if (!item) return;

    try {
      // Local generation
      if (kind === "pdf") return await createPdfFromItem(item);
      if (kind === "excel") return await createCsvFromItem(item);

      // Server generation (docx/ppt)
      const res = await apiPost<any>(`/items/${itemId}/generate-${kind}`);
      const category = item.category || res?.category || "Other";

      const filename =
        kind === "ppt"
          ? `item_${itemId}.pptx`
          : kind === "docx"
          ? `item_${itemId}.docx`
          : `item_${itemId}.${kind}`;

      // If you implemented file-serving routes like:
      // /files/ppt/{category}/{filename}, /files/docx/{category}/{filename}
      const url =
        kind === "ppt"
          ? `${API_BASE}/files/ppt/${category}/${filename}`
          : `${API_BASE}/files/docx/${category}/${filename}`;

      const localPath = FileSystem.documentDirectory + filename;
      const dl = await FileSystem.downloadAsync(url, localPath);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri);
      } else {
        Alert.alert("Saved", `File saved at: ${dl.uri}`);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Document generation failed");
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 16 }}>
        <Pressable onPress={() => router.back()} style={{ marginBottom: 10 }}>
          <Text style={{ color: "rgba(255,255,255,0.75)", fontWeight: "900" }}>← Back</Text>
        </Pressable>

        {item ? (
          <GlassCard>
            <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 20, fontWeight: "900" }}>
              {item.title || `Item #${item.id}`}
            </Text>

            <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.75)" }}>
              Intent: {item.intent}
            </Text>
            <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              Category: {item.category}
            </Text>
            {!!item.datetime && (
              <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
                When: {item.datetime}
              </Text>
            )}

            <Text style={{ marginTop: 12, color: "rgba(255,255,255,0.70)" }}>
              {item.details || item.raw_text}
            </Text>

            <View style={{ gap: 10, marginTop: 16 }}>
              <Pressable onPress={() => gen("pdf")} style={btnStyle}>
                <Text style={btnText}>Generate PDF (Local)</Text>
              </Pressable>
              <Pressable onPress={() => gen("docx")} style={btnStyle}>
                <Text style={btnText}>Generate Word (Server)</Text>
              </Pressable>
              <Pressable onPress={() => gen("excel")} style={btnStyle}>
                <Text style={btnText}>Generate CSV (Local)</Text>
              </Pressable>
              <Pressable onPress={() => gen("ppt")} style={btnStyle}>
                <Text style={btnText}>Generate PPT (Server)</Text>
              </Pressable>
            </View>
          </GlassCard>
        ) : (
          <Text style={{ color: "rgba(255,255,255,0.70)" }}>Loading…</Text>
        )}
      </SafeAreaView>
    </LinearGradient>
  );
}

const btnStyle = {
  height: 50,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
  backgroundColor: "rgba(255,255,255,0.06)",
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const btnText = { color: "white", fontWeight: "900" as const };