import React, { useEffect } from "react";
import { router } from "expo-router";
import { getAssistantName } from "@/lib/storage";

export default function Index() {
  useEffect(() => {
    (async () => {
      const name = await getAssistantName();
      if (!name) router.replace("/setup");
      else router.replace("/(tabs)");
    })();
  }, []);

  return null;
}