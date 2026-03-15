import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { apiGet } from "@/lib/api";
import { Item } from "@/lib/types";

type FilterKey = "all" | "upcoming" | "completed";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function Explore() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(false);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;

  const horizontalPadding = isSmallPhone ? 14 : 16;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const titleFontSize = isVerySmallPhone ? 22 : isSmallPhone ? 24 : 26;
  const searchHeight = isSmallPhone ? 44 : 46;
  const chipHeight = isSmallPhone ? 31 : 32;
  const badgeMinWidth = isSmallPhone ? 72 : 82;

  async function load() {
    try {
      setLoading(true);
      const data = await apiGet<Item[]>("/items");
      setItems(data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
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

  function timeLabel(item: Item) {
    const d = parseItemDate(item);
    if (!d) return item.datetime || "No time";

    const isToday = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return isToday ? `Today, ${time}` : time;
  }

  function dateBadge(item: Item) {
    const d = parseItemDate(item);
    if (!d) return item.category || "General";
    return d.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function dotColor(item: Item) {
    const d = parseItemDate(item);
    if (!d) return "rgba(133,218,255,0.95)";
    return d.getTime() < Date.now()
      ? "rgba(255,255,255,0.45)"
      : "rgba(93,255,167,0.95)";
  }

  return (
    <LinearGradient
      colors={["#020816", "#04122B", "#082E6B", "#76ACE4"]}
      start={{ x: 0.08, y: 0.02 }}
      end={{ x: 0.88, y: 1 }}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1, paddingTop: topPadding, paddingHorizontal: horizontalPadding }}>
        <View style={topBar}>
          <Pressable style={iconBtn} onPress={() => router.replace("/(tabs)")}>
            <Ionicons name="chevron-back" size={18} color="rgba(255,255,255,0.95)" />
          </Pressable>

          <View style={titleWrap}>
            <Text style={[screenTitle, { fontSize: titleFontSize }]} numberOfLines={1}>
              Schedule
            </Text>
          </View>

          <Pressable style={iconBtn} onPress={load}>
            <Ionicons name="refresh" size={18} color="rgba(255,255,255,0.95)" />
          </Pressable>
        </View>

        <View style={[searchWrap, { marginTop: isSmallPhone ? 14 : 18, height: searchHeight }]}>
          <Ionicons name="search" size={15} color="rgba(255,255,255,0.55)" />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search schedule..."
            placeholderTextColor="rgba(255,255,255,0.34)"
            style={[searchInput, { fontSize: isSmallPhone ? 13 : 14 }]}
          />
        </View>

        <View style={[filterRow, { marginTop: isSmallPhone ? 12 : 14 }]}>
          <FilterChip
            label="All"
            active={filter === "all"}
            onPress={() => setFilter("all")}
            height={chipHeight}
          />
          <FilterChip
            label="Upcoming"
            active={filter === "upcoming"}
            onPress={() => setFilter("upcoming")}
            height={chipHeight}
          />
          <FilterChip
            label="Completed"
            active={filter === "completed"}
            onPress={() => setFilter("completed")}
            height={chipHeight}
          />
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: isSmallPhone ? 10 : 14,
            paddingBottom: Math.max(insets.bottom + 24, 30),
          }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          ListEmptyComponent={
            <GlassCard style={{ borderRadius: 22 }}>
              <Text style={emptyTitle}>{loading ? "Loading..." : "No schedule items"}</Text>
              <Text style={emptySub}>
                Create reminders from the AI screen and they will show here.
              </Text>
            </GlassCard>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/item/${item.id}`)}>
              <View style={[scheduleCard, { minHeight: isSmallPhone ? 78 : 82 }]}>
                <View style={[scheduleLeftIcon, { width: isSmallPhone ? 32 : 34, height: isSmallPhone ? 32 : 34, borderRadius: isSmallPhone ? 16 : 17 }]}>
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color="rgba(180,232,255,0.95)"
                  />
                </View>

                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[scheduleTitle, { fontSize: isSmallPhone ? 14 : 15 }]} numberOfLines={1}>
                    {item.title || "Untitled item"}
                  </Text>
                  <Text style={[scheduleTime, { fontSize: isSmallPhone ? 11 : 12 }]}>
                    {timeLabel(item)}
                  </Text>

                  <View style={scheduleMetaRow}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: dotColor(item),
                        marginRight: 6,
                      }}
                    />
                    <Text style={scheduleMetaText} numberOfLines={1}>
                      {item.category || item.intent || "General"}
                    </Text>
                  </View>
                </View>

                <View style={[dateBadgeWrap, { minWidth: badgeMinWidth }]}>
                  <Text style={dateBadgeText} numberOfLines={1}>
                    {dateBadge(item)}
                  </Text>
                </View>
              </View>
            </Pressable>
          )}
        />
      </View>
    </LinearGradient>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  height,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  height: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minWidth: 82,
        height,
        paddingHorizontal: 14,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? "rgba(142,214,255,0.22)" : "rgba(255,255,255,0.10)",
        borderWidth: 1,
        borderColor: active ? "rgba(166,228,255,0.34)" : "rgba(255,255,255,0.08)",
        marginRight: 10,
        marginBottom: 10,
      }}
    >
      <Text
        style={{
          color: active ? "white" : "rgba(255,255,255,0.74)",
          fontWeight: "800",
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const topBar = {
  minHeight: 44,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
};

const titleWrap = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  paddingHorizontal: 12,
};

const iconBtn = {
  width: 36,
  height: 36,
  borderRadius: 18,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const screenTitle = {
  color: "white",
  fontWeight: "900" as const,
};

const searchWrap = {
  borderRadius: 16,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  paddingHorizontal: 14,
  backgroundColor: "rgba(16,34,68,0.92)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
};

const searchInput = {
  flex: 1,
  marginLeft: 9,
  color: "white",
};

const filterRow = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  alignItems: "center" as const,
};

const scheduleCard = {
  borderRadius: 18,
  paddingHorizontal: 12,
  paddingVertical: 12,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  backgroundColor: "rgba(154,201,246,0.18)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const scheduleLeftIcon = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.08)",
  marginRight: 10,
};

const scheduleTitle = {
  color: "rgba(255,255,255,0.96)",
  fontWeight: "900" as const,
};

const scheduleTime = {
  marginTop: 6,
  color: "rgba(255,255,255,0.82)",
  fontWeight: "700" as const,
};

const scheduleMetaRow = {
  marginTop: 6,
  flexDirection: "row" as const,
  alignItems: "center" as const,
};

const scheduleMetaText = {
  flex: 1,
  color: "rgba(255,255,255,0.58)",
  fontSize: 11,
};

const dateBadgeWrap = {
  marginLeft: 10,
  height: 28,
  borderRadius: 999,
  paddingHorizontal: 10,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.12)",
};

const dateBadgeText = {
  color: "rgba(255,255,255,0.88)",
  fontSize: 11,
  fontWeight: "800" as const,
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