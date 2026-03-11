import React from "react";
import { Tabs, router } from "expo-router";
import { Platform, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { HapticTab } from "@/components/haptic-tab";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: "#8BE7FF",
        tabBarInactiveTintColor: "rgba(255,255,255,0.42)",
        tabBarStyle: {
          position: "absolute",
          left: 14,
          right: 14,
          bottom: Platform.OS === "ios" ? 18 : 12,
          height: Platform.OS === "ios" ? 74 : 64,
          borderTopWidth: 0,
          borderRadius: 22,
          backgroundColor: "rgba(9,18,40,0.96)",
          paddingTop: 8,
          paddingBottom: Platform.OS === "ios" ? 16 : 8,
          shadowColor: "#000",
          shadowOpacity: 0.24,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 8 },
          elevation: 14,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "800",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "AI",
          tabBarLabel: "AI",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="sparkles-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="explore"
        options={{
          title: "Schedule",
          tabBarLabel: "Schedule",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-clear-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="routine"
        options={{
          title: "Routine",
          tabBarLabel: "Routine",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}