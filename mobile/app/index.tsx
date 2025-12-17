import React, { useEffect } from "react";
import { router } from "expo-router";
import { getProfile } from "@/lib/account";
import { getAssistantName } from "@/lib/storage";

export default function Index() {
  useEffect(() => {
    (async () => {
      const assistant = await getAssistantName();
      if (!assistant) return router.replace("/setup");

      const profile = await getProfile();
      if (!profile?.userId) return router.replace("/onboarding/profile");

      router.replace("/(tabs)");
    })();
  }, []);

  return null;
}
