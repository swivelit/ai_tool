import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(mobileRoot, "..");

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readMobile(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

describe("APK test harness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("contains the expected crash marker scan list", () => {
    const source = readRepo("test_apk.sh");

    [
      "FATAL EXCEPTION",
      " E AndroidRuntime:",
      "ANR in",
      "SIGSEGV",
      "SIGABRT",
      "ReactNativeJS.*Error",
      "Unhandled promise rejection",
      "Unhandled Promise Rejection",
      "Invariant Violation",
      "Unable to load script",
      "ReferenceError",
      "TypeError",
      "JNI DETECTED ERROR",
      "llama.*error",
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JAI_NATIVE_STT_NOT_IMPLEMENTED",
      "HTTP 500",
      "HTTP 502",
      "HTTP 503",
      "Sarvam",
    ].forEach((marker) => {
      expect(source).toContain(marker);
    });
  });

  it("does not treat normal adb helper AndroidRuntime startup as a crash", () => {
    const source = readRepo("test_apk.sh");

    expect(source).not.toContain('"AndroidRuntime"');
    expect(source).toContain('" E AndroidRuntime:"');
  });

  it("verifies chat messages are submitted and remain visible", () => {
    const source = readRepo("test_apk.sh");
    const chatSource = readMobile("app/(chat)/index.tsx");

    expect(source).toContain("wait_for_chat_input_cleared");
    expect(source).toContain("message-not-submitted");
    expect(source).toContain("first-message-not-visible-after-second");
    expect(source).toContain("second-message-not-visible");
    expect(source).toContain("input keyevent 111");
    expect(source).toContain('tap_desc_offset "chat-send-button" 0 35');
    expect(source).toContain("dismiss_expo_warning");
    expect(source).toContain("Open debugger to view warnings");
    expect(chatSource).toContain("activeChatSessionIdRef");
    expect(chatSource).toContain("!activeChatSessionIdRef.current && !activeChatRequestIdRef.current");
  });

  it("registers the chat index route without triggering the Expo Router warning overlay", () => {
    const source = readMobile("app/_layout.tsx");

    expect(source).toContain('<Stack.Screen name="(chat)/index" />');
    expect(source).not.toContain('<Stack.Screen name="(chat)" />');
  });

  it("suppresses LogBox only during E2E debug runs so warnings do not block the composer", () => {
    const source = readMobile("app/_layout.tsx");

    expect(source).toContain("isAnyE2eEnvEnabled");
    expect(source).toContain("LogBox.ignoreAllLogs(true)");
  });

  it("only skips 16 KB installs when APK validation itself failed", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("APK_16KB_VALIDATION_FAILED=0");
    expect(source).toContain("APK_16KB_VALIDATION_FAILED=1");
    expect(source).toContain('[[ "$DEVICE_REQUIRES_16KB_APK" == "1" && "$APK_16KB_VALIDATION_FAILED" == "1" ]]');
  });

  it("passes bash syntax validation", () => {
    const result = spawnSync("bash", ["-n", path.join(repoRoot, "test_apk.sh")], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.error && (result.error as any).code === "ENOENT") {
      return;
    }

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("launch-debug_apk supports RUN_APK_TESTS and writes logs under dist", () => {
    const source = readRepo("launch-debug_apk.sh");

    expect(source).toContain('RUN_APK_TESTS:-');
    expect(source).toContain("REUSE_APK=1 SKIP_PRECHECKS=1");
    expect(source).toContain("./test_apk.sh");
    expect(source).toContain('METRO_LOG="$DIST_DIR/launch-debug-metro-${METRO_PORT}.log"');
  });

  it("debug APK scripts default voice tests to backend routing and keep manual local opt-in", () => {
    const launchDebug = readRepo("launch-debug_apk.sh");
    const testApk = readRepo("test_apk.sh");

    for (const source of [launchDebug, testApk]) {
      expect(source).toContain(
        'export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-false}"',
      );
      expect(source).toContain("Debug APK voice routing: backend Sarvam (default)");
      expect(source).toContain("local/native STT (manual development opt-in)");
      expect(source).not.toContain('EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-true');
    }
  });

  it("release app config rejects E2E mock auth env", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_AUTH", "1");

    await expect(import("../app.config")).rejects.toThrow(
      /Release\/production builds cannot enable debug E2E flags/,
    );
  });

  it("chat screen exposes automation labels", () => {
    const source = readMobile("app/(chat)/index.tsx");

    [
      "chat-input",
      "chat-send-button",
      "chat-mic-button",
      "chat-drawer-button",
      "chat-voice-button",
      "chat-assistant-response",
      "chat-thinking-indicator",
    ].forEach((label) => {
      expect(source).toContain(label);
    });
  });

  it("auth, model setup, and alert screens expose automation labels", () => {
    const combined = [
      readMobile("app/auth/login.tsx"),
      readMobile("app/auth/signup.tsx"),
      readMobile("app/model-setup.tsx"),
      readMobile("app/_layout.tsx"),
    ].join("\n");

    [
      "login-email-input",
      "login-password-input",
      "login-submit-button",
      "signup-name-input",
      "signup-email-input",
      "signup-password-input",
      "signup-submit-button",
      "boot-loading-screen",
      "model-setup-status",
      "model-setup-retry-button",
      "model-setup-download-button",
      "app-alert-button-",
    ].forEach((label) => {
      expect(combined).toContain(label);
    });
  });

  it("chat drawer history items and action sheet expose automation labels", () => {
    const source = readMobile("app/(chat)/index.tsx");

    [
      "chat-history-item",
      "chat-delete-button",
      "chat-actions-cancel-button",
    ].forEach((label) => {
      expect(source).toContain(label);
    });
  });

  it("verifies chat deletion automation is present in the APK test harness", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("chat deletion test");
    expect(source).toContain("delete-drawer-opened");
    expect(source).toContain("delete-no-chat-history-item");
    expect(source).toContain("delete-action-sheet-button-not-found");
    expect(source).toContain("delete-native-alert-not-shown");
    expect(source).toContain("delete-native-alert-confirm-not-found");
    expect(source).toContain("delete-verify-drawer");
    expect(source).toContain("delete-complete");
  });

  it("voice orb and modal expose automation labels", () => {
  const orbSource = readMobile("components/Orb.tsx");
  const chatSource = readMobile("app/(chat)/index.tsx");

  expect(orbSource).toContain("voice-orb");
  expect(chatSource).toContain("voice-modal-close-button");
});

it("verifies voice automation exists in APK harness", () => {
  const source = readRepo("test_apk.sh");

  expect(source).toContain("voice automation test");
  expect(source).toContain("voice-orb-not-found");
  expect(source).toContain("voice-response-not-visible");
  expect(source).toContain("voice-modal-closed");
});

it("captures failure context artifacts for QA diagnostics", () => {
  const source = readRepo("test_apk.sh");

  expect(source).toContain("failure-summary.log");
  expect(source).toContain("failure-context.log");
  expect(source).toContain("capture_step");
  expect(source).toContain("tail -n 120");
});

});
