import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { apiGet, apiPost, API_BASE } from "@/lib/api";
import { createCsvFromItem, createPdfFromItem } from "@/lib/localDocs";
import { Item } from "@/lib/types";

type ExportKind = "pdf" | "docx" | "excel" | "ppt";

function parseItemDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIntentLabel(value?: string | null) {
  const source = (value || "general").replace(/[_-]+/g, " ").trim();
  if (!source) return "General";

  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatWhen(value?: string | null) {
  const date = parseItemDate(value);
  if (!date) return value || "No time assigned";

  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateChip(value?: string | null) {
  const date = parseItemDate(value);
  if (!date) return "ANYTIME";

  return date
    .toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
}

function formatRelativeWhen(value?: string | null) {
  const date = parseItemDate(value);
  if (!date) return "Not scheduled yet";

  const now = new Date();

  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );

  const diffDays = Math.round(
    (startOfDate.getTime() - startOfNow.getTime()) / 86_400_000
  );

  if (diffDays === 0) return "Happening today";
  if (diffDays === 1) return "Scheduled for tomorrow";
  if (diffDays === -1) return "Occurred yesterday";
  if (diffDays > 1) return `In ${diffDays} days`;
  return `${Math.abs(diffDays)} days ago`;
}

function getDayWindow(value?: string | null) {
  const date = parseItemDate(value);
  if (!date) return "Flexible";

  const hour = date.getHours();
  if (hour < 6) return "Early morning";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 21) return "Evening";
  return "Night";
}

function getStatus(item: Item) {
  const date = parseItemDate(item.datetime);

  if (!date) {
    return {
      label: "Draft",
      text: Brand.cocoa,
      bg: "rgba(255,255,255,0.60)",
      border: Brand.line,
      dot: "rgba(185,120,54,0.92)",
      icon: "ellipse-outline" as const,
      helper: "No schedule set yet",
    };
  }

  if (date.getTime() < Date.now()) {
    return {
      label: "Completed",
      text: "#7b6552",
      bg: "rgba(124, 99, 80, 0.10)",
      border: "rgba(124, 99, 80, 0.16)",
      dot: "rgba(124, 99, 80, 0.70)",
      icon: "checkmark-circle-outline" as const,
      helper: "This item is now in the past",
    };
  }

  return {
    label: "Upcoming",
    text: Brand.success,
    bg: "rgba(111, 140, 94, 0.10)",
    border: "rgba(111, 140, 94, 0.18)",
    dot: "rgba(111, 140, 94, 0.92)",
    icon: "time-outline" as const,
    helper: "This item is scheduled ahead",
  };
}

function getPrimaryTitle(item: Item | null) {
  if (!item) return "";
  return item.title || item.raw_text || `Item #${item.id}`;
}

function getSummary(item: Item | null) {
  if (!item) return "";
  return item.details || item.raw_text || "No details available.";
}

function getSourceLabel(item: Item | null) {
  if (!item) return "Unknown";
  return item.transcript ? "Voice-generated" : "Text-generated";
}

function getRecommendedExport(item: Item | null) {
  if (!item) return "PDF";

  const content = `${item.category || ""} ${item.intent || ""}`.toLowerCase();

  if (
    content.includes("meeting") ||
    content.includes("presentation") ||
    content.includes("pitch")
  ) {
    return "PPT";
  }

  if (
    content.includes("report") ||
    content.includes("document") ||
    content.includes("note")
  ) {
    return "Word";
  }

  if (
    content.includes("task") ||
    content.includes("schedule") ||
    content.includes("planner")
  ) {
    return "CSV";
  }

  return "PDF";
}

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = Number(id);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<ExportKind | null>(null);

  const isSmallPhone = width < 370 || height < 760;
  const isVerySmallPhone = width < 345 || height < 700;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = insets.top + (isSmallPhone ? 6 : 10);
  const bottomPadding = Math.max(insets.bottom + 28, 28);
  const titleSize = isVerySmallPhone ? 24 : isSmallPhone ? 28 : 33;
  const titleLineHeight = titleSize + 6;

  const status = useMemo(() => (item ? getStatus(item) : null), [item]);

  const heroTitle = useMemo(() => getPrimaryTitle(item), [item]);
  const summary = useMemo(() => getSummary(item), [item]);

  const detailPairs = useMemo(() => {
    if (!item) return [];

    return [
      {
        label: "When",
        value: formatWhen(item.datetime),
        icon: "time-outline" as const,
      },
      {
        label: "Relative",
        value: formatRelativeWhen(item.datetime),
        icon: "sparkles-outline" as const,
      },
      {
        label: "Time window",
        value: getDayWindow(item.datetime),
        icon: "sunny-outline" as const,
      },
      {
        label: "Source",
        value: getSourceLabel(item),
        icon: "mic-outline" as const,
      },
    ];
  }, [item]);

  const descriptorChips = useMemo(() => {
    if (!item) return [];

    return [
      {
        label: formatIntentLabel(item.intent),
        icon: "flash-outline" as const,
      },
      {
        label: formatIntentLabel(item.category),
        icon: "layers-outline" as const,
      },
      {
        label: getRecommendedExport(item),
        icon: "share-social-outline" as const,
      },
    ];
  }, [item]);

  async function load() {
    if (!Number.isFinite(itemId)) {
      setLoading(false);
      Alert.alert("Invalid item", "This item ID is not valid.");
      return;
    }

    try {
      setLoading(true);
      const data = await apiGet<Item>(`/items/${itemId}`);
      setItem(data);
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Failed to load item.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [itemId]);

  async function gen(kind: ExportKind) {
    if (!item || exporting) return;

    try {
      setExporting(kind);

      if (kind === "pdf") {
        await createPdfFromItem(item);
        return;
      }

      if (kind === "excel") {
        await createCsvFromItem(item);
        return;
      }

      const res = await apiPost<any>(`/items/${itemId}/generate-${kind}`);
      const category = item.category || res?.category || "Other";
      const filename =
        kind === "ppt" ? `item_${itemId}.pptx` : `item_${itemId}.docx`;

      const url =
        kind === "ppt"
          ? `${API_BASE}/files/ppt/${category}/${filename}`
          : `${API_BASE}/files/docx/${category}/${filename}`;

      const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
      if (!baseDir) {
        throw new Error("No writable directory available on this device.");
      }

      const localPath = `${baseDir}${filename}`;
      const downloaded = await FileSystem.downloadAsync(url, localPath);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri);
      } else {
        Alert.alert("Saved", `File saved at: ${downloaded.uri}`);
      }
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Document generation failed.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingTop: topPadding,
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomPadding,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} style={styles.topIconBtn}>
            <Ionicons name="chevron-back" size={18} color={Brand.cocoa} />
          </Pressable>

          <View style={styles.topCenter}>
            <Text style={styles.topCaption}>Planner item</Text>
            <Text style={styles.topTitle}>Detail view</Text>
          </View>

          <Pressable onPress={load} style={styles.topIconBtn} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={Brand.cocoa} />
            ) : (
              <Ionicons name="refresh" size={18} color={Brand.cocoa} />
            )}
          </Pressable>
        </View>

        {loading ? (
          <GlassCard style={{ borderRadius: 30, marginTop: 14 }}>
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={Brand.bronze} />
              <Text style={styles.loadingText}>Loading item details...</Text>
            </View>
          </GlassCard>
        ) : item ? (
          <>
            <GlassCard style={{ borderRadius: 32, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.dateChip}>
                  <Text style={styles.dateChipText}>
                    {formatDateChip(item.datetime)}
                  </Text>
                </View>

                {status ? (
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
                      size={13}
                      color={status.text}
                    />
                    <View
                      style={[styles.statusDot, { backgroundColor: status.dot }]}
                    />
                    <Text style={[styles.statusText, { color: status.text }]}>
                      {status.label}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.heroBody}>
                <Text
                  style={[
                    styles.title,
                    { fontSize: titleSize, lineHeight: titleLineHeight },
                  ]}
                >
                  {heroTitle}
                </Text>

                <Text style={styles.subtitle}>
                  Everything you need for this item is right here.
                </Text>

                <View style={styles.descriptorRow}>
                  {descriptorChips.map((chip) => (
                    <View key={`${chip.icon}-${chip.label}`} style={styles.metaPill}>
                      <Ionicons
                        name={chip.icon}
                        size={14}
                        color={Brand.bronze}
                      />
                      <Text style={styles.metaPillText}>{chip.label}</Text>
                    </View>
                  ))}
                </View>

                <LinearGradient
                  colors={[
                    "rgba(255,255,255,0.86)",
                    "rgba(255,239,210,0.68)",
                  ]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.highlightStrip}
                >
                  <View style={styles.highlightBadge}>
                    <Ionicons
                      name="sparkles-outline"
                      size={14}
                      color={Brand.bronze}
                    />
                    <Text style={styles.highlightBadgeText}>Overview</Text>
                  </View>

                  <Text style={styles.highlightTitle}>
                    {status?.helper || "Review this item"}
                  </Text>

                  <Text style={styles.highlightText}>
                    {item.datetime
                      ? `${formatWhen(item.datetime)} · ${getDayWindow(
                          item.datetime
                        )}`
                      : "No exact time is attached yet. You can still export and review the item content."}
                  </Text>
                </LinearGradient>
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Timeline snapshot</Text>
                  <Text style={styles.sectionSubtitle}>
                    The most important scheduling context at a glance.
                  </Text>
                </View>

                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>Live</Text>
                </View>
              </View>

              <View style={styles.detailGrid}>
                {detailPairs.map((entry) => (
                  <InfoCard
                    key={entry.label}
                    label={entry.label}
                    value={entry.value}
                    icon={entry.icon}
                  />
                ))}
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Summary</Text>
                  <Text style={styles.sectionSubtitle}>
                    A clearer presentation of the assistant’s structured output.
                  </Text>
                </View>

                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>Primary</Text>
                </View>
              </View>

              <Text style={styles.bodyText}>{summary}</Text>
            </GlassCard>

            {item.raw_text && item.raw_text !== item.details ? (
              <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
                <View style={styles.sectionHeaderRow}>
                  <View>
                    <Text style={styles.sectionTitle}>Original request</Text>
                    <Text style={styles.sectionSubtitle}>
                      The exact text or voice-generated source that created this
                      item.
                    </Text>
                  </View>

                  <View style={styles.sectionBadge}>
                    <Text style={styles.sectionBadgeText}>Source</Text>
                  </View>
                </View>

                <View style={styles.originalInputCard}>
                  <Text style={styles.originalInputText}>{item.raw_text}</Text>
                </View>
              </GlassCard>
            ) : null}

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Item metadata</Text>
                  <Text style={styles.sectionSubtitle}>
                    Helpful details about this item.
                  </Text>
                </View>

                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>System</Text>
                </View>
              </View>

              <View style={styles.systemList}>
                <SystemRow
                  label="Item ID"
                  value={`#${item.id}`}
                  icon="pricetag-outline"
                />
                <SystemRow
                  label="Intent"
                  value={formatIntentLabel(item.intent)}
                  icon="flash-outline"
                />
                <SystemRow
                  label="Category"
                  value={formatIntentLabel(item.category)}
                  icon="albums-outline"
                />
                <SystemRow
                  label="Recommended export"
                  value={getRecommendedExport(item)}
                  icon="share-social-outline"
                />
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Export options</Text>
                  <Text style={styles.sectionSubtitle}>
                    Share or download this item your way.
                  </Text>
                </View>

                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>Share</Text>
                </View>
              </View>

              <View style={styles.exportHero}>
                <View style={styles.exportHeroIcon}>
                  <Ionicons
                    name="download-outline"
                    size={18}
                    color={Brand.bronze}
                  />
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={styles.exportHeroTitle}>
                    Recommended: {getRecommendedExport(item)}
                  </Text>
                  <Text style={styles.exportHeroText}>
                    Pick the format that best matches how this item will be used,
                    reviewed, or shared outside the app.
                  </Text>
                </View>
              </View>

              <View style={styles.actionGrid}>
                <ExportCard
                  label="PDF"
                  helper="Quick local export"
                  icon="document-text-outline"
                  active={exporting === "pdf"}
                  onPress={() => gen("pdf")}
                />
                <ExportCard
                  label="Word"
                  helper="Word document"
                  icon="reader-outline"
                  active={exporting === "docx"}
                  onPress={() => gen("docx")}
                />
                <ExportCard
                  label="CSV"
                  helper="Spreadsheet format"
                  icon="grid-outline"
                  active={exporting === "excel"}
                  onPress={() => gen("excel")}
                />
                <ExportCard
                  label="PPT"
                  helper="Presentation format"
                  icon="easel-outline"
                  active={exporting === "ppt"}
                  onPress={() => gen("ppt")}
                />
              </View>
            </GlassCard>

            <View style={styles.bottomActionsRow}>
              <Pressable
                onPress={() => router.replace("/(tabs)/explore")}
                style={({ pressed }) => [
                  styles.bottomActionSecondary,
                  pressed && styles.pressed,
                ]}
              >
                <Ionicons
                  name="calendar-outline"
                  size={16}
                  color={Brand.cocoa}
                />
                <Text style={styles.bottomActionSecondaryText}>
                  Planner
                </Text>
              </Pressable>

              <Pressable
                onPress={() => router.replace("/(tabs)")}
                style={({ pressed }) => [
                  styles.bottomActionPrimary,
                  pressed && styles.pressed,
                ]}
              >
                <LinearGradient
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.bottomActionPrimaryInner}
                >
                  <Ionicons name="sparkles" size={16} color={Brand.ink} />
                  <Text style={styles.bottomActionPrimaryText}>
                    Home
                  </Text>
                </LinearGradient>
              </Pressable>
            </View>
          </>
        ) : (
          <GlassCard style={{ borderRadius: 30, marginTop: 14 }}>
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIconWrap}>
                <Ionicons
                  name="document-text-outline"
                  size={24}
                  color={Brand.bronze}
                />
              </View>
              <Text style={styles.emptyTitle}>Item not found</Text>
              <Text style={styles.emptySubtitle}>
                This schedule entry could not be loaded. Go back to the planner
                and try again.
              </Text>

              <Pressable
                onPress={() => router.replace("/(tabs)/explore")}
                style={({ pressed }) => [
                  styles.emptyActionBtn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.emptyActionBtnText}>Back to planner</Text>
              </Pressable>
            </View>
          </GlassCard>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

function InfoCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.infoCard}>
      <View style={styles.infoIconWrap}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>
      <Text style={styles.infoCardLabel}>{label}</Text>
      <Text style={styles.infoCardValue} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

function SystemRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.systemRow}>
      <View style={styles.systemRowIcon}>
        <Ionicons name={icon} size={15} color={Brand.bronze} />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.systemRowLabel}>{label}</Text>
        <Text style={styles.systemRowValue}>{value}</Text>
      </View>
    </View>
  );
}

function ExportCard({
  label,
  helper,
  icon,
  active,
  onPress,
}: {
  label: string;
  helper: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.exportCard, pressed && styles.pressed]}
    >
      <LinearGradient
        colors={["rgba(255,255,255,0.94)", "rgba(255,239,210,0.88)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.exportGradient}
      >
        <View style={styles.exportIconWrap}>
          {active ? (
            <ActivityIndicator size="small" color={Brand.ink} />
          ) : (
            <Ionicons name={icon} size={18} color={Brand.bronze} />
          )}
        </View>

        <Text style={styles.exportLabel}>{label}</Text>
        <Text style={styles.exportHelper}>
          {active ? "Preparing..." : helper}
        </Text>
      </LinearGradient>
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
    top: 250,
    left: -80,
    width: 210,
    height: 210,
    borderRadius: 999,
    backgroundColor: "rgba(255,229,180,0.34)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -100,
    right: 10,
    width: 270,
    height: 270,
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
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },

  topTitle: {
    marginTop: 2,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  loadingWrap: {
    minHeight: 160,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },

  loadingText: {
    color: Brand.muted,
    fontSize: 14,
    fontWeight: "700",
  },

  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },

  heroBody: {
    marginTop: 16,
  },

  dateChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.66)",
    borderWidth: 1,
    borderColor: "rgba(185,120,54,0.18)",
  },

  dateChipText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
  },

  statusChip: {
    minHeight: 34,
    paddingHorizontal: 11,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  statusText: {
    fontSize: 12,
    fontWeight: "800",
  },

  title: {
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  descriptorRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },

  metaPill: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metaPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  highlightStrip: {
    marginTop: 18,
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  highlightBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.7)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  highlightBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  highlightTitle: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 17,
    fontWeight: "900",
  },

  highlightText: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 20,
  },

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 19,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 250,
  },

  sectionBadge: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  sectionBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },

  detailGrid: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 110,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.64)",
  },

  infoCardLabel: {
    marginTop: 12,
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  infoCardValue: {
    marginTop: 6,
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },

  bodyText: {
    marginTop: 18,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 24,
    fontWeight: "500",
  },

  originalInputCard: {
    marginTop: 18,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  originalInputText: {
    color: Brand.ink,
    fontSize: 14,
    lineHeight: 23,
    fontWeight: "500",
  },

  systemList: {
    marginTop: 18,
    gap: 12,
  },

  systemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  systemRowIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  systemRowLabel: {
    color: Brand.muted,
    fontSize: 12,
    fontWeight: "700",
  },

  systemRowValue: {
    marginTop: 4,
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  exportHero: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.56)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  exportHeroIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  exportHeroTitle: {
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  exportHeroText: {
    marginTop: 4,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  actionGrid: {
    marginTop: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
  },

  exportCard: {
    width: "48%",
    borderRadius: 22,
    overflow: "hidden",
  },

  exportGradient: {
    minHeight: 132,
    borderRadius: 22,
    padding: 14,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  exportIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.68)",
  },

  exportLabel: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 15,
    fontWeight: "900",
  },

  exportHelper: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  bottomActionsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 18,
  },

  bottomActionSecondary: {
    flex: 1,
    minHeight: 52,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.64)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  bottomActionSecondaryText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "900",
  },

  bottomActionPrimary: {
    flex: 1.3,
    borderRadius: 18,
    overflow: "hidden",
  },

  bottomActionPrimaryInner: {
    minHeight: 52,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },

  bottomActionPrimaryText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  emptyWrap: {
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
  },

  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,229,180,0.60)",
  },

  emptyTitle: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
  },

  emptySubtitle: {
    marginTop: 8,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
  },

  emptyActionBtn: {
    marginTop: 18,
    minWidth: 154,
    minHeight: 46,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.ink,
  },

  emptyActionBtnText: {
    color: "#fff8ec",
    fontSize: 14,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});