import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import { Elevation, type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";

type Props = {
  visible: boolean;
  defaultName?: string;
  onSave: (name: string) => void;
  onSkip: () => void;
};

const EXAMPLES = [
  "Hey Elli, remind me at 7 PM",
  "Elli, help me plan tomorrow",
  "Can you organize my day?",
];

export default function AssistantNameModal({
  visible,
  defaultName = "Elli",
  onSave,
  onSkip,
}: Props) {
  const [name, setName] = useState("");
  const { width } = useWindowDimensions();
  const { palette } = useAppTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);

  useEffect(() => {
    if (visible) {
      setName("");
    }
  }, [visible]);

  const trimmed = name.trim();
  const resolvedName = trimmed.length >= 2 ? trimmed : defaultName;
  const quality = useMemo(() => {
    if (!trimmed) return "Using default";
    if (trimmed.length < 4) return "Easy";
    if (trimmed.length < 8) return "Balanced";
    return "Distinctive";
  }, [trimmed]);

  function finalSave() {
    onSave(trimmed.length >= 2 ? trimmed : defaultName);
  }

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onSkip} />

        <View style={[styles.panel, { width: Math.min(width - 28, 520) }]}>
          <View style={styles.topRow}>
            <View style={styles.topPill}>
              <Ionicons name="sparkles-outline" size={14} color={palette.bronze} />
              <Text style={styles.topPillText}>Quick setup</Text>
            </View>

            <Pressable onPress={onSkip} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={palette.cocoa} />
            </Pressable>
          </View>

          <Text style={styles.title}>Name your assistant</Text>
          <Text style={styles.subtitle}>
            Choose a name that feels natural to say and type. If you skip,
            we’ll use <Text style={styles.subtitleStrong}>{defaultName}</Text>.
          </Text>

          <View style={styles.metricRow}>
            <View style={styles.metricChip}>
              <Text style={styles.metricChipText}>Optional</Text>
            </View>
            <View style={styles.metricChip}>
              <Text style={styles.metricChipText}>{quality}</Text>
            </View>
            <View style={styles.metricChip}>
              <Text style={styles.metricChipText}>Default: {defaultName}</Text>
            </View>
          </View>

          <View style={styles.inputWrap}>
            <View style={styles.inputIconWrap}>
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={palette.bronze} />
            </View>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Eg: Kavi, Tara, Aruvi..."
              placeholderTextColor={palette.placeholder}
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={finalSave}
            />
          </View>

          <View style={styles.previewCard}>
            <View style={styles.previewBadge}>
              <Ionicons name="mic-outline" size={14} color={palette.bronze} />
              <Text style={styles.previewBadgeText}>Preview</Text>
            </View>

            <Text style={styles.previewName}>{resolvedName}</Text>

            <View style={styles.exampleList}>
              {EXAMPLES.map((example, index) => (
                <Text key={index} style={styles.exampleText}>
                  {example.replace(/Elli/g, resolvedName)}
                </Text>
              ))}
            </View>
          </View>

          <View style={styles.actionsRow}>
            <Pressable
              onPress={onSkip}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Skip</Text>
            </Pressable>

            <Pressable
              onPress={finalSave}
              style={({ pressed }) => [styles.primaryShell, pressed && styles.pressed]}
            >
              <LinearGradient
                colors={palette.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryBtn}
              >
                <Text style={styles.primaryBtnText}>Save name</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(t: Palette) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      padding: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.overlay,
    },

    // Opaque, theme-aware panel (was BlurView + softCard gradient — same haze
    // as the old GlassCard). Solid fill, hairline border and a soft elevation
    // shadow so it reads as a clean card floating over the dimmed backdrop.
    panel: {
      borderRadius: 28,
      borderWidth: 1,
      borderColor: t.lineStrong,
      backgroundColor: t.isDark ? t.raised : t.surfaceStrong,
      padding: 18,
      ...Elevation.medium,
    },

    topRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },

    topPill: {
      minHeight: 34,
      paddingHorizontal: 12,
      borderRadius: 999,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line,
    },

    topPillText: {
      color: t.cocoa,
      fontSize: 12,
      fontWeight: "800",
    },

    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line,
    },

    title: {
      marginTop: 16,
      color: t.ink,
      fontSize: 24,
      lineHeight: 30,
      fontWeight: "900",
    },

    subtitle: {
      marginTop: 10,
      color: t.muted,
      fontSize: 14,
      lineHeight: 22,
    },

    subtitleStrong: {
      color: t.cocoa,
      fontWeight: "900",
    },

    metricRow: {
      marginTop: 16,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
    },

    metricChip: {
      minHeight: 34,
      paddingHorizontal: 12,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line,
    },

    metricChipText: {
      color: t.cocoa,
      fontSize: 12,
      fontWeight: "800",
    },

    inputWrap: {
      marginTop: 18,
      minHeight: 56,
      borderRadius: 18,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.lineStrong,
      flexDirection: "row",
      alignItems: "center",
      overflow: "hidden",
    },

    inputIconWrap: {
      width: 46,
      alignItems: "center",
      justifyContent: "center",
    },

    input: {
      flex: 1,
      color: t.ink,
      fontSize: 15,
      paddingRight: 14,
    },

    previewCard: {
      marginTop: 18,
      borderRadius: 22,
      padding: 16,
      borderWidth: 1,
      borderColor: t.line,
      backgroundColor: t.accentSoft,
    },

    previewBadge: {
      alignSelf: "flex-start",
      minHeight: 30,
      paddingHorizontal: 10,
      borderRadius: 999,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.line,
    },

    previewBadgeText: {
      color: t.cocoa,
      fontSize: 11,
      fontWeight: "900",
    },

    previewName: {
      marginTop: 14,
      color: t.ink,
      fontSize: 18,
      fontWeight: "900",
    },

    exampleList: {
      marginTop: 10,
      gap: 8,
    },

    exampleText: {
      color: t.muted,
      fontSize: 13,
      lineHeight: 19,
    },

    actionsRow: {
      marginTop: 18,
      flexDirection: "row",
      gap: 12,
    },

    secondaryBtn: {
      flex: 1,
      minHeight: 50,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.lineStrong,
    },

    secondaryBtnText: {
      color: t.cocoa,
      fontSize: 14,
      fontWeight: "900",
    },

    primaryShell: {
      flex: 1.15,
      borderRadius: 16,
      overflow: "hidden",
    },

    primaryBtn: {
      minHeight: 50,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
    },

    primaryBtnText: {
      color: t.ink,
      fontSize: 14,
      fontWeight: "900",
    },

    pressed: {
      opacity: 0.95,
      transform: [{ scale: 0.995 }],
    },
  });
}
