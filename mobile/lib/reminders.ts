import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

// Always show notifications even if app is foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const ANDROID_CHANNEL_ID = "checkins";

export async function ensureNotificationsReady(): Promise<boolean> {
  // Android needs a channel
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Daily Check-ins",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const settings = await Notifications.getPermissionsAsync();
  if (settings.status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    return req.status === "granted";
  }
  return true;
}

export async function scheduleReminder(title: string, body: string, when: Date) {
  // ✅ SDK 54+: trigger must be object with `type`
  // ✅ Android: channelId MUST be on trigger (reliable), not only content
  const trigger: Notifications.NotificationTriggerInput =
    Platform.OS === "android"
      ? {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
          channelId: ANDROID_CHANNEL_ID,
        }
      : {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
        };

  return Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: "default",
    },
    trigger,
  });
}

// Useful during onboarding to avoid duplicates
export async function cancelAllReminders() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

// Debug helper: see what is scheduled
export async function getScheduledReminders() {
  return Notifications.getAllScheduledNotificationsAsync();
}
