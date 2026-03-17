import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

type PlannerRow =
  | {
      type: "section";
      key: string;
      title: string;
      helper: string;
    }
  | {
      type: "item";
      key: string;
      item: Item;
    };

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

function addDays(date: Date, amount: number) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + amount);
  return next;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isTomorrow(date: Date, now: Date) {
  return isSameDay(date, addDays(now, 1));
}

function parseItemDate(item: Item): Date | null {
  if (!item.datetime) return null;
  const date = new Date(item.datetime);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTypeLabel(value?: string | null) {
  const source = (value || "general").replace(/[_-]+/g, " ").trim();
  if (!source) return "General";

  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateChip(item: Item) {
  const date = parseItemDate(item);
  if (!date) return "ANYTIME";

  return date
    .toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
}

function formatTimeLabel(item: Item, now: Date) {
  const date = parseItemDate(item);
  if (!date) return "No time assigned";

  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isSameDay(date, now)) return `Today · ${time}`;
  if (isTomorrow(date, now)) return `Tomorrow · ${time}`;

  return `${date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} · ${time}`;
}

function getStatusConfig(item: Item) {
  const date = parseItemDate(item);

  if (!date) {
    return {
      label: "Draft",
      text: Brand.cocoa,
      bg: "rgba(255,255,255,0.62)",
      border: Brand.line,
      dot: "rgba(185,120,54,0.88)",
      icon: "ellipse" as const,
    };
  }

  if (date.getTime() < Date.now()) {
    return {
      label: "Completed",
      text: "#7b6552",
      bg: "rgba(124, 99, 80, 0.10)",
      border: "rgba(124, 99, 80, 0.16)",
      dot: "rgba(124, 99, 80, 0.60)",
      icon: "checkmark-circle" as const,
    };
  }

  return {
    label: "Upcoming",
    text: Brand.success,
    bg: "rgba(111, 140, 94, 0.10)",
    border: "rgba(111, 140, 94, 0.18)",
    dot: "rgba(111, 140, 94, 0.92)",
    icon: "time" as const,
  };
}

function getPrimaryText(item: Item) {
  return item.title || item.raw_text || `Item #${item.id}`;
}

function getDetailText(item: Item) {
  return item.details || item.raw_text || "No extra details available.";
}

function getSectionMeta(sectionKey: string, count: number) {
  switch (sectionKey) {
    case "today":
      return {
        title: "Today",
        helper: `${count} item${count === 1 ? "" : "s"} lined up for today`,
      };
    case "tomorrow":
      return {
        title: "Tomorrow",
        helper: `${count} item${count === 1 ? "" : "s"} scheduled next`,
      };
    case "week":
      return {
        title: "Coming up this week",
        helper: `${count} item${count === 1 ? "" : "s"} arriving soon`,
      };
    case "later":
      return {
        title: "Later",
        helper: `${count} future item${
          count === 1 ? "" : "s"
        } beyond this week`,
      };
    case "completed":
      return {
        title: "Completed",
        helper: `${count} item${count === 1 ? "" : "s"} already passed`,
      };
    default:
      return {
        title: "Unscheduled",
        helper: `${count} draft item${
          count === 1 ? "" : "s"
        } without a set time`,
      };
  }
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={16} color={Brand.bronze} />
      </View>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon: keyof typeof Ionicons.glyphMap;
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
      <Ionicons
        name={icon}
        size={14}
        color={active ? Brand.ink : Brand.cocoa}
      />
      <Text
        style={[
          styles.filterChipText,
          active && styles.filterChipTextActive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
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
  const titleSize = isVerySmallPhone ? 24 : isSmallPhone ? 28 : 32;
  const heroRadius = isSmallPhone ? 26 : 30;
  const searchHeight = isSmallPhone ? 52 : 56;

  async function load() {
    try {
      setLoading(true);
      const suffix = profile?.userId ? `?user_id=${profile.userId}` : "";
      const data = await apiGet<Item[]>(`/items${suffix}`);
      setItems(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [profile?.userId]);

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrowStart = startOfDay(addDays(now, 1));
  const tomorrowEnd = endOfDay(addDays(now, 1));
  const weekEnd = endOfDay(addDays(now, 7));

  const stats = useMemo(() => {
    const upcoming = items.filter((item) => {
      const date = parseItemDate(item);
      return date ? date.getTime() >= now.getTime() : false;
    }).length;

    const completed = items.filter((item) => {
      const date = parseItemDate(item);
      return date ? date.getTime() < now.getTime() : false;
    }).length;

    const today = items.filter((item) => {
      const date = parseItemDate(item);
      return date ? isSameDay(date, now) : false;
    }).length;

    const drafts = items.filter((item) => !parseItemDate(item)).length;

    return {
      total: items.length,
      upcoming,
      completed,
      today,
      drafts,
    };
  }, [items, now]);

  const nextUpcoming = useMemo(() => {
    return (
      [...items]
        .filter((item) => {
          const date = parseItemDate(item);
          return date ? date.getTime() >= now.getTime() : false;
        })
        .sort((a, b) => {
          const ad = parseItemDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const bd = parseItemDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return ad - bd;
        })[0] || null
    );
  }, [items, now]);

  const filteredItems = useMemo(() => {
    const search = q.trim().toLowerCase();

    let next = [...items];

    if (filter === "upcoming") {
      next = next.filter((item) => {
        const date = parseItemDate(item);
        return date ? date.getTime() >= now.getTime() : false;
      });
    }

    if (filter === "completed") {
      next = next.filter((item) => {
        const date = parseItemDate(item);
        return date ? date.getTime() < now.getTime() : false;
      });
    }

    if (search) {
      next = next.filter((item) => {
        const blob = `${item.title || ""} ${item.details || ""} ${
          item.raw_text || ""
        } ${item.intent || ""} ${item.category || ""} ${
          item.datetime || ""
        }`.toLowerCase();
        return blob.includes(search);
      });
    }

    return next;
  }, [filter, items, now, q]);

  const groupedRows = useMemo<PlannerRow[]>(() => {
    const sections: Record<string, Item[]> = {
      today: [],
      tomorrow: [],
      week: [],
      later: [],
      completed: [],
      unscheduled: [],
    };

    filteredItems.forEach((item) => {
      const date = parseItemDate(item);

      if (!date) {
        sections.unscheduled.push(item);
        return;
      }

      if (date.getTime() < now.getTime()) {
        sections.completed.push(item);
        return;
      }

      if (date >= todayStart && date <= todayEnd) {
        sections.today.push(item);
        return;
      }

      if (date >= tomorrowStart && date <= tomorrowEnd) {
        sections.tomorrow.push(item);
        return;
      }

      if (date > tomorrowEnd && date <= weekEnd) {
        sections.week.push(item);
        return;
      }

      sections.later.push(item);
    });

    const futureSort = (a: Item, b: Item) => {
      const ad = parseItemDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = parseItemDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    };

    const pastSort = (a: Item, b: Item) => {
      const ad = parseItemDate(a)?.getTime() ?? 0;
      const bd = parseItemDate(b)?.getTime() ?? 0;
      return bd - ad;
    };

    sections.today.sort(futureSort);
    sections.tomorrow.sort(futureSort);
    sections.week.sort(futureSort);
    sections.later.sort(futureSort);
    sections.completed.sort(pastSort);
    sections.unscheduled.sort((a, b) => b.id - a.id);

    const order =
      filter === "completed"
        ? ["completed"]
        : filter === "upcoming"
        ? ["today", "tomorrow", "week", "later"]
        : ["today", "tomorrow", "week", "later", "completed", "unscheduled"];

    const rows: PlannerRow[] = [];

    order.forEach((sectionKey) => {
      const sectionItems = sections[sectionKey] || [];
      if (!sectionItems.length) return;

      const meta = getSectionMeta(sectionKey, sectionItems.length);

      rows.push({
        type: "section",
        key: `section-${sectionKey}`,
        title: meta.title,
        helper: meta.helper,
      });

      sectionItems.forEach((item) => {
        rows.push({
          type: "item",
          key: `item-${item.id}`,
          item,
        });
      });
    });

    return rows;
  }, [
    filter,
    filteredItems,
    now,
    todayEnd,
    todayStart,
    tomorrowEnd,
    tomorrowStart,
    weekEnd,
  ]);

  const searchResultsLabel = useMemo(() => {
    const count = filteredItems.length;
    if (q.trim()) return `${count} result${count === 1 ? "" : "s"} found`;
    return `${count} item${count === 1 ? "" : "s"} in view`;
  }, [filteredItems.length, q]);

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <FlatList<PlannerRow>
        data={groupedRows}
        keyExtractor={(row) => row.key}
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
          paddingBottom: Math.max(insets.bottom + 28, 28),
        }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListHeaderComponent={
          <>
            <View style={styles.topBar}>
              <Pressable
                onPress={() => router.replace("/(tabs)")}
                style={styles.topIconBtn}
              >
                <Ionicons
                  name="sparkles-outline"
                  size={18}
                  color={Brand.cocoa}
                />
              </Pressable>

              <View style={styles.topCenter}>
                <Text style={styles.topCaption}>Planner workspace</Text>
                <Text style={styles.topTitle}>Schedule</Text>
              </View>

              <Pressable onPress={load} style={styles.topIconBtn}>
                {loading ? (
                  <ActivityIndicator size="small" color={Brand.cocoa} />
                ) : (
                  <Ionicons name="refresh" size={18} color={Brand.cocoa} />
                )}
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: heroRadius, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.heroPill}>
                  <Ionicons
                    name="calendar-clear-outline"
                    size={14}
                    color={Brand.bronze}
                  />
                  <Text style={styles.heroPillText}>Planner overview</Text>
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
                    lineHeight: titleSize + 6,
                  },
                ]}
              >
                Your reminders, tasks, and plans presented like a polished
                production planner.
              </Text>

              <Text style={styles.heroSubtitle}>
                Review what matters now, search instantly, and open any item
                from a cleaner, more professional schedule experience.
              </Text>

              <View style={styles.metricGrid}>
                <MetricCard
                  label="Today"
                  value={String(stats.today)}
                  icon="sunny-outline"
                />
                <MetricCard
                  label="Upcoming"
                  value={String(stats.upcoming)}
                  icon="time-outline"
                />
                <MetricCard
                  label="Drafts"
                  value={String(stats.drafts)}
                  icon="document-text-outline"
                />
              </View>

              <LinearGradient
                colors={[
                  "rgba(255,255,255,0.72)",
                  "rgba(255,236,204,0.64)",
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.nextUpCard}
              >
                <View style={styles.nextUpHeader}>
                  <View style={styles.nextUpBadge}>
                    <Ionicons
                      name="flash-outline"
                      size={14}
                      color={Brand.bronze}
                    />
                    <Text style={styles.nextUpBadgeText}>Next up</Text>
                  </View>

                  <Pressable
                    onPress={() => router.replace("/(tabs)")}
                    style={styles.nextUpAction}
                  >
                    <Text style={styles.nextUpActionText}>Create more</Text>
                    <Ionicons
                      name="arrow-forward"
                      size={14}
                      color={Brand.cocoa}
                    />
                  </Pressable>
                </View>

                {nextUpcoming ? (
                  <Pressable
                    onPress={() => router.push(`/item/${nextUpcoming.id}`)}
                    style={({ pressed }) => [pressed && styles.pressed]}
                  >
                    <Text style={styles.nextUpTitle} numberOfLines={1}>
                      {getPrimaryText(nextUpcoming)}
                    </Text>
                    <Text style={styles.nextUpTime}>
                      {formatTimeLabel(nextUpcoming, now)}
                    </Text>
                    <Text style={styles.nextUpDetails} numberOfLines={2}>
                      {getDetailText(nextUpcoming)}
                    </Text>
                  </Pressable>
                ) : (
                  <View>
                    <Text style={styles.nextUpTitle}>Nothing upcoming yet</Text>
                    <Text style={styles.nextUpDetails}>
                      Create a reminder or event from the AI command center and
                      it will appear here with a premium planner view.
                    </Text>
                  </View>
                )}
              </LinearGradient>
            </GlassCard>

            <View
              style={[
                styles.searchShell,
                { marginTop: 18, minHeight: searchHeight },
              ]}
            >
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

              {q.trim() ? (
                <Pressable onPress={() => setQ("")} style={styles.clearBtn}>
                  <Ionicons name="close" size={14} color={Brand.cocoa} />
                </Pressable>
              ) : null}
            </View>

            <View style={styles.filterRow}>
              <FilterChip
                label="All"
                active={filter === "all"}
                onPress={() => setFilter("all")}
                icon="apps-outline"
              />
              <FilterChip
                label="Upcoming"
                active={filter === "upcoming"}
                onPress={() => setFilter("upcoming")}
                icon="time-outline"
              />
              <FilterChip
                label="Completed"
                active={filter === "completed"}
                onPress={() => setFilter("completed")}
                icon="checkmark-done-outline"
              />
            </View>

            <View style={styles.sectionOverviewCard}>
              <View>
                <Text style={styles.sectionOverviewTitle}>Timeline focus</Text>
                <Text style={styles.sectionOverviewSubtitle}>
                  {searchResultsLabel} · {stats.completed} completed ·{" "}
                  {stats.total} total
                </Text>
              </View>

              <View style={styles.sectionOverviewPill}>
                <Ionicons
                  name="layers-outline"
                  size={14}
                  color={Brand.bronze}
                />
                <Text style={styles.sectionOverviewPillText}>
                  {filter.toUpperCase()}
                </Text>
              </View>
            </View>

            <View style={{ height: 12 }} />
          </>
        }
        ListEmptyComponent={
          <GlassCard style={{ borderRadius: 26 }}>
            <View style={styles.emptyIconWrap}>
              <Ionicons
                name={q.trim() ? "search-outline" : "calendar-outline"}
                size={24}
                color={Brand.bronze}
              />
            </View>

            <Text style={styles.emptyTitle}>
              {loading
                ? "Loading your planner..."
                : q.trim()
                ? "No matching items"
                : "No schedule items yet"}
            </Text>

            <Text style={styles.emptySub}>
              {q.trim()
                ? "Try a different keyword or switch filters to widen your schedule search."
                : "Create reminders from the AI screen and they will appear here in a refined planner layout."}
            </Text>

            {!q.trim() ? (
              <Pressable
                onPress={() => router.replace("/(tabs)")}
                style={({ pressed }) => [
                  styles.emptyCta,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.emptyCtaText}>Go to AI workspace</Text>
              </Pressable>
            ) : null}
          </GlassCard>
        }
        renderItem={({ item: row }) => {
          if (row.type === "section") {
            return (
              <View style={styles.sectionHeaderWrap}>
                <Text style={styles.sectionHeaderTitle}>{row.title}</Text>
                <Text style={styles.sectionHeaderHelper}>{row.helper}</Text>
              </View>
            );
          }

          const item = row.item;
          const status = getStatusConfig(item);

          return (
            <Pressable
              onPress={() => router.push(`/item/${item.id}`)}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <LinearGradient
                colors={[
                  "rgba(255,255,255,0.94)",
                  "rgba(255,239,210,0.88)",
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.itemCard}
              >
                <View style={styles.itemRail}>
                  <View style={styles.itemDateChip}>
                    <Text style={styles.itemDateChipText}>
                      {formatDateChip(item)}
                    </Text>
                  </View>
                  <View style={styles.itemRailLine} />
                </View>

                <View style={styles.itemMain}>
                  <View style={styles.itemTopRow}>
                    <Text style={styles.itemTitle} numberOfLines={1}>
                      {getPrimaryText(item)}
                    </Text>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color="rgba(124, 99, 80, 0.56)"
                    />
                  </View>

                  <Text style={styles.itemTime}>
                    {formatTimeLabel(item, now)}
                  </Text>

                  <Text style={styles.itemDetails} numberOfLines={2}>
                    {getDetailText(item)}
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
                      <Ionicons
                        name={status.icon}
                        size={12}
                        color={status.text}
                      />
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: status.dot },
                        ]}
                      />
                      <Text
                        style={[styles.statusText, { color: status.text }]}
                      >
                        {status.label}
                      </Text>
                    </View>

                    <View style={styles.typeChip}>
                      <Text style={styles.typeChipText} numberOfLines={1}>
                        {formatTypeLabel(item.category || item.intent)}
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
    minHeight: 98,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
    justifyContent: "space-between",
  },

  metricIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  metricLabel: {
    marginTop: 10,
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

  nextUpCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  nextUpHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  nextUpBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  nextUpBadgeText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  nextUpAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  nextUpActionText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  nextUpTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  nextUpTime: {
    marginTop: 6,
    color: Brand.bronze,
    fontSize: 12,
    fontWeight: "800",
  },

  nextUpDetails: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
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
    fontWeight: "600",
  },

  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14,
  },

  filterChip: {
    minWidth: 92,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
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

  sectionOverviewCard: {
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sectionOverviewTitle: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  sectionOverviewSubtitle: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  sectionOverviewPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,248,236,0.86)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sectionOverviewPillText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
  },

  sectionHeaderWrap: {
    marginTop: 4,
    paddingHorizontal: 2,
  },

  sectionHeaderTitle: {
    color: Brand.cocoa,
    fontSize: 15,
    fontWeight: "900",
  },

  sectionHeaderHelper: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },

  itemCard: {
    borderRadius: 26,
    borderWidth: 1,
    borderColor: Brand.line,
    padding: 14,
    flexDirection: "row",
    alignItems: "stretch",
    shadowColor: "#d09858",
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },

  itemRail: {
    width: 76,
    alignItems: "center",
    marginRight: 12,
  },

  itemDateChip: {
    width: "100%",
    minHeight: 42,
    paddingHorizontal: 10,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.62)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.16)",
  },

  itemDateChipText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
    textAlign: "center",
  },

  itemRailLine: {
    width: 2,
    flex: 1,
    marginTop: 10,
    borderRadius: 999,
    backgroundColor: "rgba(185,120,54,0.12)",
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
    backgroundColor: "rgba(255,255,255,0.62)",
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
    backgroundColor: "rgba(255,229,180,0.6)",
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

  emptyCta: {
    marginTop: 18,
    alignSelf: "center",
    minWidth: 160,
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.ink,
  },

  emptyCtaText: {
    color: "#fff8ec",
    fontSize: 14,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});