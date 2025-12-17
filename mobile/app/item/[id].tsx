import React, { useEffect, useState } from "react";
import { SafeAreaView, Text, View, Pressable, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, router } from "expo-router";

import { GlassCard } from "@/components/Glass";
import { apiGet, apiPost } from "@/lib/api";
import { Item } from "@/lib/types";

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = Number(id);
  const [item, setItem] = useState<Item | null>(null);

  async function load() {
    const data = await apiGet<Item>(`/items/${itemId}`);
    setItem(data);
  }

  useEffect(() => {
    load();
  }, [itemId]);

  async function gen(kind: "pdf" | "docx" | "excel" | "ppt") {
    try {
      const res = await apiPost<any>(`/items/${itemId}/generate-${kind}`);
      Alert.alert("Generated", JSON.stringify(res, null, 2));
      // NOTE: for Play Store quality: add a backend download endpoint to fetch the file.
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed");
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
              <Pressable onPress={() => gen("pdf")} style={btnStyle("#22D3EE")}>
                <Text style={btnText}>Generate PDF</Text>
              </Pressable>
              <Pressable onPress={() => gen("docx")} style={btnStyle("#8B5CF6")}>
                <Text style={btnText}>Generate Word</Text>
              </Pressable>
              <Pressable onPress={() => gen("excel")} style={btnStyle("#34D399")}>
                <Text style={btnText}>Generate Excel</Text>
              </Pressable>
              <Pressable onPress={() => gen("ppt")} style={btnStyle("#F59E0B")}>
                <Text style={btnText}>Generate PPT</Text>
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

const btnStyle = (color: string) => ({
  height: 50,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
  backgroundColor: "rgba(255,255,255,0.06)",
  alignItems: "center" as const,
  justifyContent: "center" as const,
});

const btnText = { color: "white", fontWeight: "900" as const };
