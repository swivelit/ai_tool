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
      "OutOfMemoryError",
      "ReactNativeJS.*Error",
      "ReactNativeJS.*Requiring unknown module",
      'Requiring unknown module \\"react-native\\"',
      "localIdleQueue.ts",
      "Unable to load script",
      "ReferenceError",
      "TypeError",
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JAI_NATIVE_STT_NOT_IMPLEMENTED",
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

    expect(source).toContain('"hello" "what can you do" "tell me about solo leveling"');
    expect(source).toContain("wait_for_chat_input_cleared");
    expect(source).toContain("message-not-submitted");
    expect(source).toContain("first-message-not-visible-after-second");
    expect(source).toContain("second-message-not-visible");
    expect(source).toContain("general-message-not-visible");
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

  it("checks app liveness and backend/native safety markers for general questions", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("assert_app_alive");
    expect(source).toContain('adb shell pidof "$PACKAGE_NAME"');
    expect(source).toContain("input_clear_timeout=90");
    expect(source).toContain("result_wait_seconds=90");
    expect(source).toContain("scan_general_question_route_markers");
    expect(source).toContain("client_local_path_skipped_for_safety");
    expect(source).toContain("client_backend_fallback_started");
    expect(source).toContain("client_backend_fallback_completed");
    expect(source).toContain("chat_turn_completed");
    expect(source).toContain("general-question-no-route-marker-or-response");
    expect(source).toContain("chat-input-not-found-after-launch");
  });

  it("passes bash syntax validation", () => {
    for (const script of ["launch-debug_apk.sh", "test_apk.sh"]) {
      const result = spawnSync("bash", ["-n", path.join(repoRoot, script)], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  it("launch-debug_apk supports RUN_APK_TESTS and writes logs under dist", () => {
    const source = readRepo("launch-debug_apk.sh");

    expect(source).toContain('RUN_APK_TESTS:-');
    expect(source).toContain("REUSE_APK=1 SKIP_PRECHECKS=1");
    expect(source).toContain("./test_apk.sh");
    expect(source).toContain('METRO_LOG="$DIST_DIR/launch-debug-metro-${METRO_PORT}.log"');
  });

  it("launch-debug_apk enables E2E and native safety envs before building for APK tests", () => {
    const source = readRepo("launch-debug_apk.sh");
    const envIndex = source.indexOf('if is_truthy "${RUN_APK_TESTS:-}"');
    const buildIndex = source.indexOf("BUILD_TYPE=debug ./build-apk.sh");
    const testIndex = source.indexOf("REUSE_APK=1 SKIP_PRECHECKS=1");

    expect(envIndex).toBeGreaterThanOrEqual(0);
    expect(envIndex).toBeLessThan(buildIndex);
    expect(envIndex).toBeLessThan(testIndex);
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_MOCK_AUTH="${EXPO_PUBLIC_E2E_MOCK_AUTH:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="${EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT:-false}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS:-false}"',
    );
  });

  it("passes E2E and native safety envs into Metro", () => {
    const launchDebug = readRepo("launch-debug_apk.sh");
    const testApk = readRepo("test_apk.sh");

    for (const source of [launchDebug, testApk]) {
      expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_AUTH=");
      expect(source).toContain("EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP=");
      expect(source).toContain("EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=");
      expect(source).toContain("EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT=");
      expect(source).toContain("EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS=");
      expect(source).toContain("npx expo start --dev-client");
    }
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
});
