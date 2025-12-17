import React, { useState } from "react";
import { router } from "expo-router";
import { SafeAreaView, Text, TextInput, View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useAssistant } from "@/components/AssistantProvider";

export default function Setup() {
  const { updateName, name } = useAssistant();
  const [input, setInput] = useState("");

  async function onContinue() {
    const trimmed = input.trim();
    await updateName(trimmed.length ? trimmed : "Elli");
    router.replace("/(tabs)");
  }

  async function onSkip() {
    await updateName("Elli");
    router.replace("/(tabs)");
  }

  return (
    <LinearGradient
      colors={["#070A14", "#0B1020", "#121A33"]}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1, padding: 20, justifyContent: "center" }}>
        <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 34, fontWeight: "900" }}>
          Name your assistant
        </Text>
        <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.65)", fontSize: 15 }}>
          You can change this anytime in Settings.
        </Text>

        <View style={{ marginTop: 22 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={`Default: ${name || "Elli"}`}
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{
              height: 56,
              borderRadius: 16,
              paddingHorizontal: 14,
              color: "white",
              backgroundColor: "rgba(255,255,255,0.08)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
            }}
          />
        </View>

        <Pressable
          onPress={onContinue}
          style={{
            marginTop: 16,
            height: 54,
            borderRadius: 16,
            backgroundColor: "rgba(34,211,238,0.22)",
            borderWidth: 1,
            borderColor: "rgba(34,211,238,0.35)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "white", fontWeight: "800", fontSize: 16 }}>Continue</Text>
        </Pressable>

        <Pressable onPress={onSkip} style={{ marginTop: 12, alignItems: "center" }}>
          <Text style={{ color: "rgba(255,255,255,0.60)", fontWeight: "700" }}>
            Skip (use Elli)
          </Text>
        </Pressable>
      </SafeAreaView>
    </LinearGradient>
  );
}
