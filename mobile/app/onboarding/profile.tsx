import React, { useState } from "react";
import { SafeAreaView, Text, TextInput, View, Pressable, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { createProfileOnBackend } from "@/lib/account";
import { useAssistant } from "@/components/AssistantProvider";

export default function Profile() {
  const { name: assistantName } = useAssistant();
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");

  async function next() {
    if (!name.trim()) return Alert.alert("Name required", "Please enter your name.");
    try {
      await createProfileOnBackend({
        name: name.trim(),
        place: place.trim(),
        assistantName,
        timezone: "Asia/Kolkata",
      });
      router.replace("/onboarding/questionnaire");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed");
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 18, justifyContent: "center" }}>
        <Text style={{ color: "white", fontSize: 30, fontWeight: "900" }}>Create your account</Text>
        <Text style={{ color: "rgba(255,255,255,0.65)", marginTop: 8 }}>
          This helps {assistantName} talk to you personally.
        </Text>

        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
        />
        <TextInput
          value={place}
          onChangeText={setPlace}
          placeholder="Place (optional)"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
        />

        <Pressable onPress={next} style={btn}>
          <Text style={{ color: "white", fontWeight: "900" }}>Next</Text>
        </Pressable>
      </SafeAreaView>
    </LinearGradient>
  );
}

const input = {
  marginTop: 12,
  height: 54,
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
};

const btn = {
  marginTop: 16,
  height: 54,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(34,211,238,0.22)",
  borderWidth: 1,
  borderColor: "rgba(34,211,238,0.35)",
};
