import { getSettings } from "./storage";

export async function loadCloudFallbackConsent(): Promise<boolean> {
  const settings = await getSettings();
  return settings.allowCloudFallback === true;
}
