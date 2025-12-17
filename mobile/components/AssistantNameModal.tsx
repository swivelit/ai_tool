import React, { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

type Props = {
  visible: boolean;
  defaultName?: string;
  onSave: (name: string) => void;
  onSkip: () => void;
};

export default function AssistantNameModal({
  visible,
  defaultName = "Elli",
  onSave,
  onSkip,
}: Props) {
  const [name, setName] = useState("");

  if (!visible) return null;

  const finalSave = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      onSave(defaultName);
      return;
    }
    onSave(trimmed);
  };

  return (
    <View
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 999,
        justifyContent: "center",
        alignItems: "center",
        padding: 18,
        backgroundColor: "rgba(0,0,0,0.55)",
      }}
    >
      <BlurView
        intensity={24}
        tint="dark"
        style={{
          width: "100%",
          maxWidth: 460,
          borderRadius: 22,
          padding: 16,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.12)",
          backgroundColor: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "700" }}>
          Setup
        </Text>

        <Text
          style={{
            color: "rgba(255,255,255,0.92)",
            fontSize: 18,
            fontWeight: "900",
            marginTop: 10,
            lineHeight: 24,
          }}
        >
          Name your assistant
        </Text>

        <Text style={{ color: "rgba(255,255,255,0.6)", marginTop: 8, lineHeight: 20 }}>
          You can choose any name you like.{"\n"}If you skip, we’ll call it <Text style={{ fontWeight: "900" }}>{defaultName}</Text>.
        </Text>

        <View
          style={{
            marginTop: 14,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.12)",
            backgroundColor: "rgba(0,0,0,0.18)",
            padding: 12,
          }}
        >
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Eg: Kavi, Tara, Aruvi..."
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{ color: "rgba(255,255,255,0.92)", fontSize: 15 }}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={20}
          />
        </View>

        <View style={{ flexDirection: "row", gap: 12, marginTop: 14 }}>
          <Pressable
            onPress={onSkip}
            style={({ pressed }) => [
              {
                flex: 1,
                borderRadius: 16,
                paddingVertical: 14,
                alignItems: "center",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.14)",
                backgroundColor: "rgba(255,255,255,0.06)",
              },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Text style={{ color: "rgba(255,255,255,0.85)", fontWeight: "900" }}>Skip</Text>
          </Pressable>

          <Pressable
            onPress={finalSave}
            style={({ pressed }) => [
              {
                flex: 1,
                borderRadius: 16,
                paddingVertical: 14,
                alignItems: "center",
                overflow: "hidden",
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <LinearGradient
              colors={["#7C3AED", "#22D3EE"]}
              start={{ x: 0.1, y: 0 }}
              end={{ x: 0.9, y: 1 }}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.18)",
              }}
            />
            <Text style={{ color: "white", fontWeight: "900" }}>Save</Text>
          </Pressable>
        </View>
      </BlurView>
    </View>
  );
}
