import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AssistantProvider } from "@/components/AssistantProvider";

export default function RootLayout() {
  return (
    <AssistantProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen name="setup" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" />
        <Stack.Screen name="modal" options={{ presentation: "modal" }} />
      </Stack>
    </AssistantProvider>
  );
}
