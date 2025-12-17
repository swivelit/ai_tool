import { Tabs, router } from "expo-router";
import React from "react";
import { Platform, Pressable, Text } from "react-native";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useAssistant } from "@/components/AssistantProvider";

export default function TabLayout() {
  const { name } = useAssistant();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerTitleAlign: "left",
        headerStyle: { backgroundColor: "#0B1020" },
        headerTitleStyle: { color: "rgba(255,255,255,0.92)", fontWeight: "900", fontSize: 18 },
        headerShadowVisible: false,

        tabBarStyle: {
          backgroundColor: "#0B1020",
          borderTopWidth: 1,
          borderTopColor: "rgba(255,255,255,0.08)",
          height: Platform.OS === "ios" ? 88 : 68,
          paddingBottom: Platform.OS === "ios" ? 24 : 10,
        },
        tabBarActiveTintColor: "#22D3EE",
        tabBarInactiveTintColor: "rgba(255,255,255,0.45)",
        tabBarButton: HapticTab,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: `Ask ${name}`,
          tabBarLabel: "Home",
          headerRight: () => (
            <Pressable onPress={() => router.push("/modal")} style={{ paddingRight: 14 }}>
              <Text style={{ color: "rgba(255,255,255,0.80)", fontWeight: "800" }}>⚙︎</Text>
            </Pressable>
          ),
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: "History",
          tabBarLabel: "History",
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="paperplane.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
