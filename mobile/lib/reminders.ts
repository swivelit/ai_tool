import * as Notifications from "expo-notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureNotifPerms() {
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    if (req.status !== "granted") throw new Error("Notification permission not granted");
  }
}

export async function scheduleReminder(title: string, body: string, when: Date) {
  await ensureNotifPerms();
  return Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: when,
  });
}
