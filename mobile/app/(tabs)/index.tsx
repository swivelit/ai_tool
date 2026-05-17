import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";

export default function ChatTabRedirect() {
  useEffect(() => {
    router.replace("/(chat)" as any);
  }, []);

  return <View style={{ flex: 1, backgroundColor: "transparent" }} />;
}
