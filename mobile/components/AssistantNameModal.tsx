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
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import { Brand } from "@/constants/theme";

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

        <BlurView
          intensity={22}
          tint="light"
          style={[
            styles.cardWrap,
            {
              width: Math.min(width - 28, 520),
            },
          ]}
        >
          <LinearGradient
            colors={["rgba(255,255,255,0.96)", "rgba(255,236,204,0.92)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.card}
          >
            <View style={styles.topRow}>
              <View style={styles.topPill}>
                <Ionicons name="sparkles-outline" size={14} color={Brand.bronze} />
                <Text style={styles.topPillText}>Quick setup</Text>
              </View>

              <Pressable onPress={onSkip} style={styles.closeBtn}>
                <Ionicons name="close" size={18} color={Brand.cocoa} />
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
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={Brand.bronze} />
              </View>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Eg: Kavi, Tara, Aruvi..."
                placeholderTextColor="rgba(124, 99, 80, 0.45)"
                style={styles.input}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={20}
                returnKeyType="done"
                onSubmitEditing={finalSave}
              />
            </View>

            <LinearGradient
              colors={["rgba(255,255,255,0.84)", "rgba(255,239,210,0.70)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.previewCard}
            >
              <View style={styles.previewBadge}>
                <Ionicons name="mic-outline" size={14} color={Brand.bronze} />
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
            </LinearGradient>

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
                  colors={Brand.gradients.button}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.primaryBtn}
                >
                  <Text style={styles.primaryBtnText}>Save name</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </LinearGradient>
        </BlurView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    padding: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(72, 46, 18, 0.22)",
  },

  cardWrap: {
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,249,239,0.78)",
  },

  card: {
    borderRadius: 28,
    padding: 18,
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
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  topPillText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  title: {
    marginTop: 16,
    color: Brand.ink,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "900",
  },

  subtitle: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  subtitleStrong: {
    color: Brand.cocoa,
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
    backgroundColor: "rgba(255,255,255,0.62)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  metricChipText: {
    color: Brand.cocoa,
    fontSize: 12,
    fontWeight: "800",
  },

  inputWrap: {
    marginTop: 18,
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.78)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
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
    color: Brand.ink,
    fontSize: 15,
    paddingRight: 14,
  },

  previewCard: {
    marginTop: 18,
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadge: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  previewBadgeText: {
    color: Brand.cocoa,
    fontSize: 11,
    fontWeight: "900",
  },

  previewName: {
    marginTop: 14,
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  exampleList: {
    marginTop: 10,
    gap: 8,
  },

  exampleText: {
    color: Brand.muted,
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
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },

  secondaryBtnText: {
    color: Brand.cocoa,
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
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  pressed: {
    opacity: 0.95,
    transform: [{ scale: 0.995 }],
  },
});