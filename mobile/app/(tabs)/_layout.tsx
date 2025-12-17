import { Tabs } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform } from "react-native";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

import AsyncStorage from "@react-native-async-storage/async-storage";

const ASSISTANT_NAME_KEY = "assistant_name_v1";
const DEFAULT_ASSISTANT_NAME = "Elli";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem(ASSISTANT_NAME_KEY);
      if (stored) setAssistantName(stored);
    })();
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: true,

        // ----- Header styling -----
        headerTitleAlign: "left",
        headerStyle: {
          backgroundColor: "#0B1020",
        },
        headerTitleStyle: {
          color: "rgba(255,255,255,0.92)",
          fontWeight: "900",
          fontSize: 18,
        },
        headerShadowVisible: false,

        // ----- Tab bar styling -----
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
          title: `Ask ${assistantName}`,
          tabBarLabel: "Home",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="house.fill" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="explore"
        options={{
          title: "Explore",
          tabBarLabel: "Explore",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="paperplane.fill" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
