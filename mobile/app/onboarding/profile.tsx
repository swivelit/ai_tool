import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";

import { createProfileOnBackend } from "@/lib/account";
import { useAssistant } from "@/components/AssistantProvider";
import { useAuth } from "@/components/AuthProvider";

export default function ProfileScreen() {
  const { name: currentAssistantName, refresh, updateName } = useAssistant();
  const { user } = useAuth();

  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [assistantName, setAssistantName] = useState(currentAssistantName || "J AI");
  const [busy, setBusy] = useState(false);

  const provider = useMemo(() => {
    if (user?.providerData?.some((item) => item.providerId === "google.com")) {
      return "google" as const;
    }
    return "password" as const;
  }, [user?.providerData]);

  useEffect(() => {
    setName(user?.displayName || "");
  }, [user?.displayName]);

  useEffect(() => {
    if (currentAssistantName) {
      setAssistantName(currentAssistantName);
    }
  }, [currentAssistantName]);

  async function saveProfile() {
    if (!user) {
      return Alert.alert("Login required", "Please login again and then continue.");
    }
    if (!name.trim()) {
      return Alert.alert("Name required", "Please enter your name.");
    }
    if (!assistantName.trim()) {
      return Alert.alert("Assistant name required", "Please enter an assistant name.");
    }

    try {
      setBusy(true);
      await updateName(assistantName.trim());
      await createProfileOnBackend({
        firebaseUid: user.uid,
        firebaseEmailVerified: user.emailVerified,
        email: user.email || "",
        avatarUrl: user.photoURL || undefined,
        authProvider: provider,
        name: name.trim(),
        place: place.trim(),
        assistantName: assistantName.trim(),
        timezone: "Asia/Kolkata",
      });
      await refresh();
      router.replace("/onboarding/questionnaire");
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Failed to save profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={["#070A14", "#0B1020", "#121A33"]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1, padding: 18, justifyContent: "center" }}>
        <Text style={{ color: "white", fontSize: 30, fontWeight: "900" }}>Complete your profile</Text>
        <Text style={{ color: "rgba(255,255,255,0.65)", marginTop: 8, lineHeight: 22 }}>
          Your login is ready. Add a few profile details so {assistantName || "J AI"} can
          personalize the app.
        </Text>

        <Text style={label}>Email</Text>
        <View style={readonlyBox}>
          <Text style={{ color: "rgba(255,255,255,0.88)", fontSize: 15 }}>{user?.email || "-"}</Text>
        </View>

        <Text style={label}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Text style={label}>Place</Text>
        <TextInput
          value={place}
          onChangeText={setPlace}
          placeholder="Place (optional)"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Text style={label}>Assistant name</Text>
        <TextInput
          value={assistantName}
          onChangeText={setAssistantName}
          placeholder="J AI"
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={input}
          editable={!busy}
        />

        <Pressable onPress={saveProfile} style={[btn, busy && { opacity: 0.7 }]} disabled={busy}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={{ color: "white", fontWeight: "900" }}>Continue</Text>}
        </Pressable>
      </SafeAreaView>
    </LinearGradient>
  );
}

const label = {
  marginTop: 14,
  marginBottom: 8,
  color: "rgba(255,255,255,0.92)",
  fontSize: 14,
  fontWeight: "800" as const,
};

const input = {
  height: 54,
  borderRadius: 16,
  paddingHorizontal: 14,
  color: "white",
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.12)",
};

const readonlyBox = {
  minHeight: 54,
  borderRadius: 16,
  paddingHorizontal: 14,
  alignItems: "flex-start" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.10)",
};

const btn = {
  marginTop: 18,
  height: 54,
  borderRadius: 16,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(34,211,238,0.22)",
  borderWidth: 1,
  borderColor: "rgba(34,211,238,0.35)",
};