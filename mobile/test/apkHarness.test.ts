import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const readRepo = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const readMobile = (file: string) => fs.readFileSync(path.join(repoRoot, "mobile", file), "utf8");

describe("current native Swico APK E2E contract", () => {
  it("uses current Swico selectors and surfaces", () => {
    const chat = readMobile("components/swico/SwicoChatScreen.tsx");
    const settings = readMobile("components/swico/SwicoSettings.tsx");
    const billing = readMobile("components/swico/SwicoBilling.tsx");
    const legal = readMobile("components/swico/SwicoLegalScreen.tsx");
    for (const selector of [
      "swico-chat-input", "swico-send-button", "swico-drawer-button", "swico-settings-button",
      "swico-new-chat", "swico-search-input", "swico-tier-button", "swico-attachment-button",
      "swico-repository-button", "swico-dictation-button", "swico-realtime-voice-button",
      "swico-settings-modal", "swico-billing-modal", "Voice Mode", "swico-legal-screen",
    ]) {
      expect([chat, settings, billing, legal].join("\n")).toContain(selector);
    }
  });

  it("does not preserve abandoned orb or legacy history assertions", () => {
    const harness = readRepo("test_apk.sh");
    expect(harness).not.toContain("e2e-open-voice-button");
    expect(harness).not.toContain("voice-assistant");
    expect(harness).not.toContain("Hold the assistant to talk");
    expect(harness).not.toContain("voice-session-transcript");
    expect(harness).not.toContain("e2e-hands-free-trigger-button");
    expect(harness).not.toContain("history-voice-kind-label-missing");
    expect(harness).not.toContain("agent_local_greeting");
  });

  it("retains Android safety checks while targeting current flows", () => {
    const harness = readRepo("test_apk.sh");
    for (const marker of [
      "adb devices -l", "adb reverse --list", "uiautomator dump", "screencap",
      "FATAL EXCEPTION", "OutOfMemoryError", "app-process-alive-after-launch",
      "offline-state-visible", "voice-mode-opens", "billing-opens-without-payment",
      "external-system-ui-anr-blocked-current-ui",
    ]) expect(harness).toContain(marker);
  });

  it("configures Metro to watch the authoritative website legal source", () => {
    const metro = readMobile("metro.config.js");
    const legal = readMobile("components/swico/SwicoLegalScreen.tsx");
    expect(metro).toContain("watchFolders");
    expect(metro).toContain("../web");
    expect(legal).toContain("legalContent.json");
  });

  it("passes the canonical debug API fixture flag and keeps it out of release builds", () => {
    const launch = readRepo("launch-debug_apk.sh");
    const config = readMobile("app.config.ts");
    const mode = readMobile("lib/e2eMode.ts");
    expect(launch).toContain("EXPO_PUBLIC_E2E_MOCK_API");
    expect(config).toContain("EXPO_PUBLIC_E2E_MOCK_API");
    expect(mode).toContain("isE2eApiFixtureEnabled");
    expect(config).toContain("Release/production builds cannot enable debug E2E flags");
  });

  it("keeps every recognized E2E-only flag blocked in release configuration", () => {
    const config = readMobile("app.config.ts");
    const releaseScript = readRepo("scripts/build-android_release-apk.sh");
    const mode = readMobile("lib/e2eMode.ts");
    expect(mode).toContain("EXPO_PUBLIC_PLAY_FGS_MICROPHONE_DEMO");
    expect(config).toContain("E2E_PLAY_FGS_MICROPHONE_DEMO");
    expect(config).toContain("EXPO_PUBLIC_PLAY_FGS_MICROPHONE_DEMO:");
    expect(releaseScript).toContain("EXPO_PUBLIC_PLAY_FGS_MICROPHONE_DEMO");
  });

  it("uses a device-compatible ABI and captures standalone release diagnostics", () => {
    const launcher = readRepo("launch-release_apk.sh");
    expect(launcher).toContain("jai_android_read_device_abilist");
    expect(launcher).toContain('JAI_ANDROID_ABIS="$QA_ABI" BUILD_TYPE=release');
    expect(launcher).toContain("adb shell am start -W -n");
    expect(launcher).toContain("release-smoke-");
    expect(launcher).toContain("logcat-crash.log");
    expect(launcher).not.toContain("adb shell monkey");
  });

  it("keeps the production entry backend-first", () => {
    const route = readMobile("app/(chat)/index.tsx");
    const chat = readMobile("components/swico/SwicoChatScreen.tsx");
    const api = readMobile("lib/swicoApi.ts");
    expect(route).toContain("SwicoChatScreen");
    expect(chat).not.toContain("runLocalAssistantTurn");
    expect(chat).not.toContain("nativeOnDeviceModelBridge");
    expect(api).toContain("/api/web/chat/stream");
  });

  it("guards the auth redirect until the Expo Router root is mounted", () => {
    const layout = readMobile("app/_layout.tsx");
    expect(layout).toContain("const [rootMounted, setRootMounted] = useState(false)");
    expect(layout).toContain("requestAnimationFrame(() => setRootMounted(true))");
    expect(layout).toContain("if (!rootMounted || loading || !navigation?.key) return;");
  });

  it("release config rejects the E2E fixture flag", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_API", "1");
    await expect(import("../app.config")).rejects.toThrow(/EXPO_PUBLIC_E2E_MOCK_API/);
  });
});
