import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { Screen } from "@/components/ui";
import { useAssistant } from "@/components/AssistantProvider";
import { Elevation, Radius, Spacing, Type, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
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

function getStatusConfig(item: Item, t: Palette) {
  const date = parseItemDate(item);

  if (!date) {
    return {
      label: "Draft",
      text: t.cocoa,
      bg: t.surface,
      border: t.line,
      dot: t.accentSoft,
      icon: "ellipse" as const,
    };
  }

  if (date.getTime() < Date.now()) {
    return {
      label: "Completed",
      text: t.cocoa,
      bg: t.surface,
      border: t.surfaceStrong,
      dot: t.muted,
      icon: "checkmark-circle" as const,
    };
  }

  return {
    label: "Upcoming",
    text: t.success,
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
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={16} color={t.bronze} />
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
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
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
        color={active ? t.ink : t.cocoa}
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
  const { palette: t, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
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

  const load = useCallback(async (
    userId = profile?.userId,
    isActive: () => boolean = () => true
  ) => {
    try {
      if (!isActive()) return;

      setLoading(true);
      const suffix = userId ? `?user_id=${userId}` : "";
      const data = await apiGet<Item[]>(`/items${suffix}`);

      if (!isActive()) return;
      setItems(Array.isArray(data) ? data : []);
    } finally {
      if (isActive()) {
        setLoading(false);
      }
    }
  }, [profile?.userId]);

  useEffect(() => {
    let mounted = true;
    const currentUserId = profile?.userId;

    void load(currentUserId, () => mounted);

    return () => {
      mounted = false;
    };
  }, [load, profile?.userId]);

  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNowTs(Date.now());
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  const now = useMemo(() => new Date(nowTs), [nowTs]);

  const stats = useMemo(() => {
    const now = new Date(nowTs);

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
  }, [items, nowTs]);

  const nextUpcoming = useMemo(() => {
    const now = new Date(nowTs);

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
  }, [items, nowTs]);

  const filteredItems = useMemo(() => {
    const now = new Date(nowTs);
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
  }, [filter, items, nowTs, q]);

  const groupedRows = useMemo<PlannerRow[]>(() => {
    const now = new Date(nowTs);
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const tomorrowStart = startOfDay(addDays(now, 1));
    const tomorrowEnd = endOfDay(addDays(now, 1));
    const weekEnd = endOfDay(addDays(now, 7));

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
  }, [filter, filteredItems, nowTs]);

  const searchResultsLabel = useMemo(() => {
    const count = filteredItems.length;
    if (q.trim()) return `${count} result${count === 1 ? "" : "s"} found`;
    return `${count} item${count === 1 ? "" : "s"} in view`;
  }, [filteredItems.length, q]);

  return (
    <Screen safeArea={false} style={styles.page}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <FlatList<PlannerRow>
        data={groupedRows}
        keyExtractor={(row) => row.key}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={load}
            tintColor={t.caramel}
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

              <View style={styles.topCenter}>
                <Text style={styles.topTitle}>Schedule</Text>
              </View>

              <Pressable onPress={() => { void load(); }} style={styles.topIconBtn}>
                {loading ? (
                  <ActivityIndicator size="small" color={t.cocoa} />
                ) : (
                  <Ionicons name="refresh" size={18} color={t.cocoa} />
                )}
              </Pressable>
            </View>

            <GlassCard style={{ borderRadius: heroRadius, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>

                <View style={styles.heroStatusPill}>
                  <Ionicons
                    name={loading ? "hourglass-outline" : "checkmark-circle"}
                    size={14}
                    color={loading ? t.bronze : t.success}
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
                Your day at a glance
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
                  "rgba(40, 87, 215, 0.18)",
                  "rgba(8, 11, 16, 0.5)",
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.nextUpCard}
              >
                <View style={styles.nextUpHeader}>
                  <View style={styles.nextUpBadge}>
                    <Text style={styles.nextUpBadgeText}>Next up</Text>
                  </View>

                  <Pressable
                    onPress={() => router.replace("/(chat)" as any)}
                    style={styles.nextUpAction}
                  >
                    <Text style={styles.nextUpActionText}>Create more</Text>
                    <Ionicons
                      name="arrow-forward"
                      size={14}
                      color={t.cocoa}
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
                  </View>
                )}
              </LinearGradient>
            </GlassCard>

            <View
              style={[
                styles.searchShell,
                { marginTop: Spacing.lg, minHeight: searchHeight },
              ]}
            >
              <Ionicons
                name="search"
                size={17}
                color={t.muted}
              />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search reminders, meetings, notes..."
                placeholderTextColor={t.placeholder}
                style={styles.searchInput}
              />

              {q.trim() ? (
                <Pressable onPress={() => setQ("")} style={styles.clearBtn}>
                  <Ionicons name="close" size={14} color={t.cocoa} />
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
                  color={t.bronze}
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
                color={t.bronze}
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
                : ""}
            </Text>

            {!q.trim() ? (
              <Pressable
                onPress={() => router.replace("/(chat)" as any)}
                style={({ pressed }) => [
                  styles.emptyCta,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.emptyCtaText}>Back to assistant</Text>
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
          const status = getStatusConfig(item, t);

          return (
            <Pressable
              onPress={() => router.push(`/item/${item.id}`)}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <LinearGradient
                colors={[
                  "rgba(255,255,255,0.94)",
                  t.accentSoft,
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
                      color={t.muted}
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
    </Screen>
  );
}

function createStyles(t: Palette) {
  return StyleSheet.create({
  page: {
    flex: 1,
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
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  topCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
  },

  topCaption: {
    ...Type.overline,
    color: t.muted,
    textTransform: "uppercase",
  },

  topTitle: {
    ...Type.subheading,
    marginTop: Spacing.xxs,
    color: t.ink,
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },

  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroPillText: {
    ...Type.caption,
    fontWeight: "700",
    color: t.cocoa,
  },

  heroStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  heroStatusText: {
    ...Type.caption,
    fontWeight: "700",
    color: t.cocoa,
  },

  heroTitle: {
    marginTop: Spacing.lg,
    color: t.ink,
    fontWeight: "800",
    letterSpacing: -0.4,
  },

  heroSubtitle: {
    ...Type.body,
    marginTop: Spacing.sm,
    color: t.muted,
  },

  metricGrid: {
    marginTop: Spacing.xl,
    flexDirection: "row",
    gap: Spacing.sm,
  },

  metricCard: {
    flex: 1,
    minHeight: 98,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
    justifyContent: "space-between",
  },

  metricIconWrap: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
  },

  metricLabel: {
    ...Type.caption,
    fontWeight: "700",
    marginTop: Spacing.sm,
    color: t.muted,
  },

  metricValue: {
    ...Type.title,
    marginTop: Spacing.sm,
    color: t.ink,
  },

  nextUpCard: {
    marginTop: Spacing.lg,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: t.accentSoft,
  },

  nextUpHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },

  nextUpBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  nextUpBadgeText: {
    ...Type.caption,
    fontWeight: "700",
    color: t.cocoa,
  },

  nextUpAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },

  nextUpActionText: {
    ...Type.caption,
    fontWeight: "700",
    color: t.cocoa,
  },

  nextUpTitle: {
    ...Type.subheading,
    marginTop: Spacing.md,
    color: t.ink,
  },

  nextUpTime: {
    ...Type.caption,
    fontWeight: "800",
    marginTop: Spacing.xs,
    color: t.caramel,
  },

  nextUpDetails: {
    ...Type.caption,
    marginTop: Spacing.sm,
    color: t.muted,
    lineHeight: 20,
  },

  searchShell: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.lineStrong,
  },

  searchInput: {
    flex: 1,
    marginLeft: Spacing.sm,
    color: t.ink,
    fontSize: Type.callout.fontSize,
    fontWeight: "500",
  },

  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },

  filterChip: {
    minWidth: 92,
    height: 40,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  filterChipActive: {
    backgroundColor: t.accentSoft,
    borderColor: t.accentSoft,
  },

  filterChipText: {
    ...Type.caption,
    fontWeight: "700",
    color: t.cocoa,
  },

  filterChipTextActive: {
    color: t.ink,
  },

  sectionOverviewCard: {
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  sectionOverviewTitle: {
    ...Type.callout,
    fontWeight: "800",
    color: t.ink,
  },

  sectionOverviewSubtitle: {
    ...Type.caption,
    fontSize: 12,
    fontWeight: "700",
    marginTop: Spacing.xs,
    color: t.muted,
  },

  sectionOverviewPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  sectionOverviewPillText: {
    ...Type.overline,
    color: t.cocoa,
  },

  sectionHeaderWrap: {
    marginTop: Spacing.xs,
    paddingHorizontal: Spacing.xxs,
  },

  sectionHeaderTitle: {
    ...Type.callout,
    fontWeight: "800",
    color: t.cocoa,
  },

  sectionHeaderHelper: {
    ...Type.caption,
    fontSize: 12,
    fontWeight: "700",
    marginTop: Spacing.xs,
    color: t.muted,
  },

  itemCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: t.line,
    padding: Spacing.lg,
    flexDirection: "row",
    alignItems: "stretch",
    ...Elevation.low,
    shadowColor: "#57deff",
  },

  itemRail: {
    width: 76,
    alignItems: "center",
    marginRight: Spacing.md,
  },

  itemDateChip: {
    width: "100%",
    minHeight: 42,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.accentSoft,
    borderWidth: 1,
    borderColor: t.accentSoft,
  },

  itemDateChipText: {
    ...Type.overline,
    color: t.cocoa,
    textAlign: "center",
  },

  itemRailLine: {
    width: 2,
    flex: 1,
    marginTop: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: t.accentSoft,
  },

  itemMain: {
    flex: 1,
    minWidth: 0,
  },

  itemTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },

  itemTitle: {
    ...Type.callout,
    fontWeight: "800",
    flex: 1,
    color: t.ink,
  },

  itemTime: {
    ...Type.caption,
    fontWeight: "800",
    marginTop: Spacing.xs,
    color: t.caramel,
  },

  itemDetails: {
    ...Type.caption,
    marginTop: Spacing.sm,
    color: t.muted,
    lineHeight: 19,
  },

  itemFooterRow: {
    marginTop: Spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },

  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  statusText: {
    ...Type.overline,
    letterSpacing: 0.2,
  },

  typeChip: {
    maxWidth: "48%",
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    backgroundColor: t.surface,
    borderWidth: 1,
    borderColor: t.line,
  },

  typeChipText: {
    ...Type.overline,
    fontWeight: "800",
    letterSpacing: 0.2,
    color: t.cocoa,
  },

  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: t.accentSoft,
    marginBottom: Spacing.md,
  },

  emptyTitle: {
    ...Type.heading,
    color: t.ink,
    textAlign: "center",
  },

  emptySub: {
    ...Type.body,
    marginTop: Spacing.sm,
    color: t.muted,
    textAlign: "center",
  },

  emptyCta: {
    marginTop: Spacing.lg,
    alignSelf: "center",
    minWidth: 160,
    minHeight: 46,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.bronze,
  },

  emptyCtaText: {
    ...Type.callout,
    fontWeight: "800",
    color: t.cream,
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
  });
}
