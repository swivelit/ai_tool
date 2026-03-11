import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { GlassCard } from "@/components/Glass";
import { apiGet } from "@/lib/api";
import { Item } from "@/lib/types";

type FilterKey = "all" | "upcoming" | "completed";

export default function Explore() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const data = await apiGet<Item[]>("/items");
      setItems(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function parseItemDate(item: Item): Date | null {
    if (!item.datetime) return null;
    const d = new Date(item.datetime);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const filtered = useMemo(() => {
    const now = Date.now();
    const search = q.trim().toLowerCase();

    let next = [...items].sort((a, b) => {
      const ad = parseItemDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = parseItemDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });

    if (filter === "upcoming") {
      next = next.filter((item) => {
        const d = parseItemDate(item);
        return d ? d.getTime() >= now : false;
      });
    }

    if (filter === "completed") {
      next = next.filter((item) => {
        const d = parseItemDate(item);
        return d ? d.getTime() < now : false;
      });
    }

    if (search) {
      next = next.filter((i) => {
        const blob =
          `${i.title || ""} ${i.details || ""} ${i.raw_text || ""} ${i.intent || ""} ${i.category || ""} ${i.datetime || ""}`.toLowerCase();
        return blob.includes(search);
      });
    }

    return next;
  }, [items, q, filter]);

  function formatDate(item: Item) {
    const d = parseItemDate(item);
    if (!d) return item.datetime || "No time set";

    const isToday = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const date = d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });

    return isToday ? `Today, ${time}` : `${time} • ${date}`;
  }

  function formatSubDate(item: Item) {
    const d = parseItemDate(item);
    if (!d) return item.category || item.intent || "General";

    return d.toLocaleDateString([], {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function statusColor(item: Item) {
    const d = parseItemDate(item);
    if (!d) return "rgba(141, 221, 255, 0.9)";
    return d.getTime() < Date.now()
      ? "rgba(255,255,255,0.65)"
      : "rgba(87, 255, 170, 0.95)";
  }

  return (
    <LinearGradient
      colors={["#020816", "#04132D", "#0B3D86"]}
      start={{ x: 0.12, y: 0.04 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 18 }}>
        <View style={topRow}>
          <Text style={screenTitle}>Schedule</Text>
          <Pressable style={refreshBtn} onPress={load}>
            <Ionicons name="refresh" size={18} color="rgba(255,255,255,0.92)" />
          </Pressable>
        </View>

        <Text style={screenSub}>
          {loading ? "Refreshing..." : "All your upcoming and completed items."}
        </Text>

        <View style={searchShell}>
          <Ionicons name="search" size={16} color="rgba(255,255,255,0.50)" />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search schedule..."
            placeholderTextColor="rgba(255,255,255,0.38)"
            style={searchInput}
          />
        </View>

        <View style={filterRow}>
          <FilterChip label="All" active={filter === "all"} onPress={() => setFilter("all")} />
          <FilterChip
            label="Upcoming"
            active={filter === "upcoming"}
            onPress={() => setFilter("upcoming")}
          />
          <FilterChip
            label="Completed"
            active={filter === "completed"}
            onPress={() => setFilter("completed")}
          />
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: 110 }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          ListEmptyComponent={
            <GlassCard style={{ borderRadius: 24 }}>
              <Text style={emptyTitle}>No schedule items</Text>
              <Text style={emptySub}>
                Try creating a reminder or event from the AI screen.
              </Text>
            </GlassCard>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/item/${item.id}`)}>
              <GlassCard style={{ borderRadius: 24 }}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={iconWrap}>
                    <Ionicons name="calendar-outline" size={20} color="rgba(173,232,255,0.95)" />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={itemTitle} numberOfLines={1}>
                      {item.title || "Untitled item"}
                    </Text>
                    <Text style={itemPrimaryMeta}>{formatDate(item)}</Text>
                    <Text style={itemSecondaryMeta}>{formatSubDate(item)}</Text>
                  </View>

                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: statusColor(item),
                    }}
                  />
                </View>
              </GlassCard>
            </Pressable>
          )}
        />
      </SafeAreaView>
    </LinearGradient>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        height: 34,
        paddingHorizontal: 14,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? "rgba(140,220,255,0.22)" : "rgba(255,255,255,0.08)",
        borderWidth: 1,
        borderColor: active ? "rgba(160,230,255,0.34)" : "rgba(255,255,255,0.08)",
      }}
    >
      <Text
        style={{
          color: active ? "white" : "rgba(255,255,255,0.72)",
          fontWeight: "800",
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const topRow = {
  paddingTop: 10,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const screenTitle = {
  color: "white",
  fontSize: 30,
  fontWeight: "900" as const,
};

const screenSub = {
  marginTop: 6,
  color: "rgba(255,255,255,0.62)",
  fontSize: 14,
};

const refreshBtn = {
  width: 38,
  height: 38,
  borderRadius: 19,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const searchShell = {
  marginTop: 16,
  height: 48,
  borderRadius: 18,
  paddingHorizontal: 14,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  backgroundColor: "rgba(18,33,67,0.96)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const searchInput = {
  flex: 1,
  marginLeft: 10,
  color: "white",
  fontSize: 15,
};

const filterRow = {
  marginTop: 14,
  flexDirection: "row" as const,
  gap: 10,
};

const iconWrap = {
  width: 42,
  height: 42,
  borderRadius: 14,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  marginRight: 12,
};

const itemTitle = {
  color: "rgba(255,255,255,0.96)",
  fontSize: 16,
  fontWeight: "900" as const,
};

const itemPrimaryMeta = {
  marginTop: 6,
  color: "rgba(255,255,255,0.80)",
  fontSize: 13,
  fontWeight: "700" as const,
};

const itemSecondaryMeta = {
  marginTop: 4,
  color: "rgba(255,255,255,0.50)",
  fontSize: 12,
};

const emptyTitle = {
  color: "white",
  fontSize: 18,
  fontWeight: "900" as const,
};

const emptySub = {
  marginTop: 8,
  color: "rgba(255,255,255,0.62)",
  lineHeight: 20,
  fontSize: 14,
};