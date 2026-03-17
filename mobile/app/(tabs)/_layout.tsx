import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

import { HapticTab } from "@/components/haptic-tab";
import { Brand } from "@/constants/theme";

function TabIcon({
  focused,
  color,
  name,
}: {
  focused: boolean;
  color: string;
  name: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      {focused ? (
        <LinearGradient
          colors={["#ffeec9", "#ffd99d", "#e4a85d"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.iconGradient}
        >
          <Ionicons name={name} size={18} color={Brand.ink} />
        </LinearGradient>
      ) : (
        <Ionicons name={name} size={18} color={color} />
      )}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarButton: HapticTab,
        sceneStyle: { backgroundColor: "transparent" },
        tabBarActiveTintColor: Brand.ink,
        tabBarInactiveTintColor: "rgba(124, 99, 80, 0.68)",
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "800",
          marginTop: 2,
          marginBottom: Platform.OS === "ios" ? 0 : 4,
        },
        tabBarItemStyle: {
          paddingTop: 6,
        },
        tabBarStyle: {
          height: Platform.OS === "ios" ? 84 : 74,
          paddingTop: 8,
          paddingBottom: Platform.OS === "ios" ? 12 : 10,
          borderTopWidth: 0,
          backgroundColor: "transparent",
          elevation: 0,
          shadowColor: "#c8863d",
          shadowOpacity: 0.12,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: -6 },
        },
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView intensity={18} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={[
                "rgba(255,250,242,0.96)",
                "rgba(255,239,208,0.95)",
                "rgba(255,229,180,0.97)",
              ]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.topBorder} />
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "AI",
          tabBarStyle: { display: "none" },
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} name="sparkles-outline" />
          ),
        }}
      />

      <Tabs.Screen
        name="explore"
        options={{
          title: "Schedule",
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} name="calendar-clear-outline" />
          ),
        }}
      />

      <Tabs.Screen
        name="routine"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} name="settings-outline" />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  topBorder: {
    position: "absolute",
    top: 0,
    left: 16,
    right: 16,
    height: 1,
    backgroundColor: "rgba(124, 84, 52, 0.10)",
  },

  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },

  iconWrapActive: {
    shadowColor: "#d4924e",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },

  iconGradient: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.58)",
  },
});