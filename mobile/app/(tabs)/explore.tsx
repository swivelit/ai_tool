import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable, FlatList } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";

import { GlassCard } from "@/components/Glass";
import { apiGet } from "@/lib/api";
import { Item } from "@/lib/types";

export default function Explore() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");

  async function load() {
    const data = await apiGet<Item[]>("/items");
    setItems(data);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((i) => {
      const blob = `${i.title || ""} ${i.details || ""} ${i.raw_text || ""} ${i.intent || ""} ${i.category || ""}`.toLowerCase();
      return blob.includes(s);
    });
  }, [items, q]);

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 16 }}>
        <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 26, fontWeight: "900" }}>
          History
        </Text>
        <Text style={{ marginTop: 6, color: "rgba(255,255,255,0.60)" }}>
          Tap an item to open details.
        </Text>

        <GlassCard style={{ marginTop: 12 }}>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search your notes/reminders/tasks…"
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{ color: "white", height: 44, fontSize: 16 }}
          />
          <Pressable
            onPress={load}
            style={{
              marginTop: 10,
              height: 48,
              borderRadius: 16,
              backgroundColor: "rgba(139,92,246,0.18)",
              borderWidth: 1,
              borderColor: "rgba(139,92,246,0.28)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "white", fontWeight: "900" }}>Refresh</Text>
          </Pressable>
        </GlassCard>

        <FlatList
          data={filtered}
          keyExtractor={(i) => String(i.id)}
          contentContainerStyle={{ paddingTop: 14, paddingBottom: 20 }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/item/${item.id}`)}>
              <GlassCard>
                <Text style={{ color: "rgba(255,255,255,0.92)", fontWeight: "900", fontSize: 16 }}>
                  {item.title || `${item.intent.toUpperCase()} #${item.id}`}
                </Text>
                <Text style={{ marginTop: 8, color: "rgba(255,255,255,0.70)" }}>
                  {item.details || item.raw_text}
                </Text>
                <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.50)", fontWeight: "700" }}>
                  {item.category} • {item.intent}
                </Text>
              </GlassCard>
            </Pressable>
          )}
        />
      </SafeAreaView>
    </LinearGradient>
  );
}