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
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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
    };
  }

  if (date.getTime() < Date.now()) {
    return {
      label: "Completed",
      text: "#7b6552",
      bg: "rgba(124, 99, 80, 0.10)",
      border: "rgba(124, 99, 80, 0.16)",
      dot: "rgba(124, 99, 80, 0.70)",
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

function formatWhen(value?: string | null) {
  const d = parseItemDate(value);
  if (!d) return value || "No time assigned";

  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateChip(value?: string | null) {
  const d = parseItemDate(value);
  if (!d) return "ANYTIME";

  return d
    .toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
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
  const titleSize = isVerySmallPhone ? 25 : isSmallPhone ? 29 : 33;

  const status = useMemo(() => (item ? getStatus(item) : null), [item]);

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
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to load item");
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
      const filename = kind === "ppt" ? `item_${itemId}.pptx` : `item_${itemId}.docx`;
      const url =
        kind === "ppt"
          ? `${API_BASE}/files/ppt/${category}/${filename}`
          : `${API_BASE}/files/docx/${category}/${filename}`;

      const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
      if (!baseDir) throw new Error("No writable directory available on this device.");

      const localPath = `${baseDir}${filename}`;
      const dl = await FileSystem.downloadAsync(url, localPath);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri);
      } else {
        Alert.alert("Saved", `File saved at: ${dl.uri}`);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Document generation failed");
    } finally {
      setExporting(null);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
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
            <Text style={styles.topTitle}>Details</Text>
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
          <GlassCard style={{ borderRadius: 28, marginTop: 14 }}>
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={Brand.bronze} />
              <Text style={styles.loadingText}>Loading item details...</Text>
            </View>
          </GlassCard>
        ) : item ? (
          <>
            <GlassCard style={{ borderRadius: 30, marginTop: 14 }}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.dateChip}>
                  <Text style={styles.dateChipText}>{formatDateChip(item.datetime)}</Text>
                </View>

                {status ? (
                  <View
                    style={[
                      styles.statusChip,
                      { backgroundColor: status.bg, borderColor: status.border },
                    ]}
                  >
                    <View style={[styles.statusDot, { backgroundColor: status.dot }]} />
                    <Text style={[styles.statusText, { color: status.text }]}>
                      {status.label}
                    </Text>
                  </View>
                ) : null}
              </View>

              <Text
                style={[styles.title, { fontSize: titleSize, lineHeight: titleSize + 6 }]}
              >
                {item.title || `Item #${item.id}`}
              </Text>

              <Text style={styles.subtitle}>
                A cleaner, richer detail view for your reminder, event, or schedule item.
              </Text>

              <View style={styles.metaGrid}>
                <InfoCard
                  label="When"
                  value={formatWhen(item.datetime)}
                  icon="time-outline"
                />
                <InfoCard
                  label="Intent"
                  value={item.intent || "General"}
                  icon="sparkles-outline"
                />
                <InfoCard
                  label="Category"
                  value={item.category || "General"}
                  icon="layers-outline"
                />
                <InfoCard
                  label="ID"
                  value={`#${item.id}`}
                  icon="pricetag-outline"
                />
              </View>
            </GlassCard>

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Summary</Text>
                  <Text style={styles.sectionSubtitle}>
                    Main details presented with clearer hierarchy.
                  </Text>
                </View>
                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>Primary</Text>
                </View>
              </View>

              <Text style={styles.bodyText}>
                {item.details || item.raw_text || "No details available."}
              </Text>
            </GlassCard>

            {item.raw_text && item.raw_text !== item.details ? (
              <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
                <View style={styles.sectionHeaderRow}>
                  <View>
                    <Text style={styles.sectionTitle}>Original input</Text>
                    <Text style={styles.sectionSubtitle}>
                      The raw request that created this item.
                    </Text>
                  </View>
                  <View style={styles.sectionBadge}>
                    <Text style={styles.sectionBadgeText}>Input</Text>
                  </View>
                </View>

                <Text style={styles.bodyText}>{item.raw_text}</Text>
              </GlassCard>
            ) : null}

            <GlassCard style={{ borderRadius: 28, marginTop: 16 }}>
              <View style={styles.sectionHeaderRow}>
                <View>
                  <Text style={styles.sectionTitle}>Export options</Text>
                  <Text style={styles.sectionSubtitle}>
                    Share this item in a polished document format.
                  </Text>
                </View>
                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>Share</Text>
                </View>
              </View>

              <View style={styles.actionGrid}>
                <ExportCard
                  label="PDF"
                  helper="Local export"
                  icon="document-text-outline"
                  active={exporting === "pdf"}
                  onPress={() => gen("pdf")}
                />
                <ExportCard
                  label="Word"
                  helper="Server export"
                  icon="reader-outline"
                  active={exporting === "docx"}
                  onPress={() => gen("docx")}
                />
                <ExportCard
                  label="CSV"
                  helper="Local export"
                  icon="grid-outline"
                  active={exporting === "excel"}
                  onPress={() => gen("excel")}
                />
                <ExportCard
                  label="PPT"
                  helper="Server export"
                  icon="easel-outline"
                  active={exporting === "ppt"}
                  onPress={() => gen("ppt")}
                />
              </View>
            </GlassCard>
          </>
        ) : (
          <GlassCard style={{ borderRadius: 28, marginTop: 14 }}>
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
                This schedule entry could not be loaded. Go back and try opening it
                again.
              </Text>
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
        colors={["rgba(255,255,255,0.92)", "rgba(255,239,210,0.86)"]}
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
        <Text style={styles.exportHelper}>{active ? "Preparing..." : helper}</Text>
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
    minHeight: 140,
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
    marginTop: 18,
    color: Brand.ink,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  metaGrid: {
    marginTop: 20,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  infoCard: {
    width: "48.5%",
    minHeight: 104,
    borderRadius: 20,
    padding: 14,
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  infoIconWrap: {
    width: 32,
    height: 32,
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

  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },

  sectionTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  sectionSubtitle: {
    marginTop: 6,
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
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

  bodyText: {
    marginTop: 18,
    color: Brand.ink,
    fontSize: 15,
    lineHeight: 24,
    fontWeight: "500",
  },

  actionGrid: {
    marginTop: 18,
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
    minHeight: 130,
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

  emptyWrap: {
    minHeight: 220,
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

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});