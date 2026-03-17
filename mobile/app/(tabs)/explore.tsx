import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { useAssistant } from "@/components/AssistantProvider";
import { Brand } from "@/constants/theme";
import { apiGet } from "@/lib/api";
import { Item } from "@/lib/types";

type FilterKey = "all" | "upcoming" | "completed";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isTomorrow(date: Date) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return isSameDay(date, tomorrow);
}

export default function Explore() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { profile } = useAssistant();

  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(false);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;

  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const titleSize = isVerySmallPhone ? 24 : isSmallPhone ? 27 : 31;
  const heroRadius = isSmallPhone ? 26 : 30;
  const searchHeight = isSmallPhone ? 52 : 56;
  const metricMinHeight = isSmallPhone ? 82 : 88;

  async function load() {
    try {
      setLoading(true);
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<Item[]>(`/items${suffix}`);
      setItems(data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [profile?.userId]);

  function parseItemDate(item: Item): Date | null {
    if (!item.datetime) return null;
    const d = new Date(item.datetime);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const stats = useMemo(() => {
    const now = Date.now();

    const upcoming = items.filter((item) => {
      const d = parseItemDate(item);
      return d ? d.getTime() >= now : false;
    }).length;

    const completed = items.filter((item) => {
      const d = parseItemDate(item);
      return d ? d.getTime() < now : false;
    }).length;

    const unscheduled = items.filter((item) => !parseItemDate(item)).length;

    return {
      total: items.length,
      upcoming,
      completed,
      unscheduled,
    };
  }, [items]);

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

  function dateChip(item: Item) {
    const d = parseItemDate(item);
    if (!d) return "ANYTIME";

    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    }).toUpperCase();
  }

  function timeLabel(item: Item) {
    const d = parseItemDate(item);
    if (!d) return "No time assigned";

    const time = d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    if (isSameDay(d, new Date())) return `Today · ${time}`;
    if (isTomorrow(d)) return `Tomorrow · ${time}`;

    return `${d.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    })} · ${time}`;
  }

  function detailLabel(item: Item) {
    return item.details || item.raw_text || "No extra details available.";
  }

  function typeLabel(item: Item) {
    return item.category || item.intent || "General";
  }

  function statusConfig(item: Item) {
    const d = parseItemDate(item);

    if (!d) {
      return {
        label: "Draft",
        text: Brand.cocoa,
        bg: "rgba(255,255,255,0.58)",
        border: Brand.line,
        dot: "rgba(185,120,54,0.88)",
      };
    }

    if (d.getTime() < Date.now()) {
      return {
        label: "Completed",
        text: "#7b6552",
        bg: "rgba(124, 99, 80, 0.10)",
        border: "rgba(124, 99, 80, 0.14)",
        dot: "rgba(124, 99, 80, 0.60)",
      };
    }

    return {
      label: "Upcoming",
      text: Brand.success,
      bg: "rgba(111, 140, 94, 0.10)",
      border: "rgba(111, 140, 94, 0.18)",
      dot: "rgba(111, 140, 94, 0.92)",
    };
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={load}
            tintColor={Brand.caramel}
          />
        }
        contentContainerStyle={{
          paddingTop: topPadding,
          paddingHorizontal: horizontalPadding,
          paddingBottom: Math.max(insets.bottom + 24, 28),
        }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListHeaderComponent={
          <>
            <View style={styles.topBar}>
              <Pressable
                onPress={() => router.replace("/(tabs)")}
                style={styles.topIconBtn}
              >
                <Ionicons name="sparkles-outline" size={18} color={Brand.cocoa} />
              </Pressable>

              <View style={styles.topCenter}>
                <Text style={styles.topCaption}>Planner</Text>
                <Text style={styles.topTitle}>Schedule</Text>
              </View>

              <Pressable onPress={load} style={styles.topIconBtn}>
                <Ionicons name="refresh" size={18} color={Brand.cocoa} />
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: heroRadius, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.heroPill}>
                  <Ionicons name="calendar-clear-outline" size={14} color={Brand.bronze} />
                  <Text style={styles.heroPillText}>Your timeline</Text>
                </View>

                <View style={styles.heroStatusPill}>
                  <Ionicons
                    name={loading ? "hourglass-outline" : "checkmark-circle"}
                    size={14}
                    color={loading ? Brand.bronze : Brand.success}
                  />
                  <Text style={styles.heroStatusText}>
                    {loading ? "Refreshing" : "Synced"}
                  </Text>
                </View>
              </View>

              <Text
                style={[
                  styles.heroTitle,
                  {
                    fontSize: titleSize,
                    lineHeight: titleSize + 5,
                  },
                ]}
              >
                Your reminders and plans, presented with clarity and polish.
              </Text>

              <Text style={styles.heroSubtitle}>
                Search, review, and manage your upcoming moments in a cleaner premium schedule view.
              </Text>

              <View style={styles.metricGrid}>
                <MetricCard
                  label="Total"
                  value={String(stats.total)}
                  minHeight={metricMinHeight}
                />
                <MetricCard
                  label="Upcoming"
                  value={String(stats.upcoming)}
                  minHeight={metricMinHeight}
                />
                <MetricCard
                  label="Completed"
                  value={String(stats.completed)}
                  minHeight={metricMinHeight}
                />
              </View>
            </GlassCard>

            <View style={[styles.searchShell, { marginTop: 18, minHeight: searchHeight }]}>
              <Ionicons
                name="search"
                size={17}
                color="rgba(124, 99, 80, 0.62)"
              />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search reminders, meetings, notes..."
                placeholderTextColor="rgba(124, 99, 80, 0.48)"
                style={styles.searchInput}
              />
            </View>

            <View style={styles.filterRow}>
              <FilterChip
                label="All"
                active={filter === "all"}
                onPress={() => setFilter("all")}
              />
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

            <View style={styles.sectionRow}>
              <View>
                <Text style={styles.sectionTitle}>Your items</Text>
                <Text style={styles.sectionSubtitle}>
                  {filtered.length} result{filtered.length === 1 ? "" : "s"}
                  {stats.unscheduled > 0 ? ` · ${stats.unscheduled} without a time` : ""}
                </Text>
              </View>
            </View>

            <View style={{ height: 12 }} />
          </>
        }
        ListEmptyComponent={
          <GlassCard style={{ borderRadius: 26 }}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="calendar-outline" size={24} color={Brand.bronze} />
            </View>
            <Text style={styles.emptyTitle}>
              {loading ? "Loading your schedule..." : "No schedule items yet"}
            </Text>
            <Text style={styles.emptySub}>
              Create reminders from the AI screen and they will appear here in a more polished planner view.
            </Text>
          </GlassCard>
        }
        renderItem={({ item }) => {
          const status = statusConfig(item);

          return (
            <Pressable
              onPress={() => router.push(`/item/${item.id}`)}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <LinearGradient
                colors={[
                  "rgba(255,255,255,0.92)",
                  "rgba(255,239,210,0.86)",
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.itemCard}
              >
                <View style={styles.itemDateChip}>
                  <Text style={styles.itemDateChipText}>{dateChip(item)}</Text>
                </View>

                <View style={styles.itemMain}>
                  <View style={styles.itemTopRow}>
                    <Text style={styles.itemTitle} numberOfLines={1}>
                      {item.title || "Untitled item"}
                    </Text>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color="rgba(124, 99, 80, 0.56)"
                    />
                  </View>

                  <Text style={styles.itemTime}>{timeLabel(item)}</Text>

                  <Text style={styles.itemDetails} numberOfLines={2}>
                    {detailLabel(item)}
                  </Text>

                  <View style={styles.itemFooterRow}>
                    <View
                      style={[
                        styles.statusChip,
                        {
                          backgroundColor: status.bg,
                          borderColor: status.border,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.statusDot,
                          {
                            backgroundColor: status.dot,
                          },
                        ]}
                      />
                      <Text style={[styles.statusText, { color: status.text }]}>
                        {status.label}
                      </Text>
                    </View>

                    <View style={styles.typeChip}>
                      <Text style={styles.typeChipText} numberOfLines={1}>
                        {typeLabel(item)}
                      </Text>
                    </View>
                  </View>
                </View>
              </LinearGradient>
            </Pressable>
          );
        }}
      />
    </LinearGradient>
  );
}

function MetricCard({
  label,
  value,
  minHeight,
}: {
  label: string;
  value: string;
  minHeight: number;
}) {
  return (
    <View style={[styles.metricCard, { minHeight }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
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
      style={({ pressed }) => [
        styles.filterChip,
        active && styles.filterChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },

  topGlow: {
    position: "absolute",
    top: -90,
    right: -20,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.56)",
  },

  leftGlow: {
    position: "absolute",
    top: 260,
    left: -70,
    width: 190,
    height: 190,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -90,
    right: 0,
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "rgba(215,154,89,0.16)",
  },

  topBar: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  topIconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },

  topCaption: {
    color: Brand.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  topTitle: {
    marginTop: 2,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  heroStatusText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  heroTitle: {
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  heroSubtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metricGrid: {
    marginTop: 20,
    flexDirection: "row",
    gap: 10,
  },

  metricCard: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    justifyContent: "space-between",
  },

  metricLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  metricValue: {
    marginTop: 8,
    color: Brand.ink,
    fontSize: 24,
    fontWeight: "900",
  },

  searchShell: {
    borderRadius: 20,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  searchInput: {
    flex: 1,
    marginLeft: 10,
    color: Brand.ink,
    fontSize: 14,
  },

  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14,
  },

  filterChip: {
    minWidth: 88,
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  filterChipActive: {
    backgroundColor: "rgba(255,229,180,0.78)",
    borderColor: "rgba(185,120,54,0.22)",
  },

  filterChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  filterChipTextActive: {
    color: Brand.ink,
  },

  sectionRow: {
    marginTop: 18,
    marginBottom: 2,
  },

  sectionTitle: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  itemCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Brand.line,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    shadowColor: "#d09858",
    shadowOpacity: 0.10,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },

  itemDateChip: {
    minWidth: 72,
    height: 38,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.62)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.16)",
    marginRight: 12,
  },

  itemDateChipText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
  },

  itemMain: {
    flex: 1,
    minWidth: 0,
  },

  itemTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  itemTitle: {
    flex: 1,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  itemTime: {
    marginTop: 6,
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "800",
  },

  itemDetails: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  itemFooterRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },

  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  statusText: {
    fontSize: 11,
    fontWeight: "800",
  },

  typeChip: {
    maxWidth: "48%",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  typeChipText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
  },

  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: "rgba(255,229,180,0.60)",
    marginBottom: 14,
  },

  emptyTitle: {
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
  },

  emptySub: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});