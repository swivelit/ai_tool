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
      "ANR in",
      "SIGSEGV",
      "SIGABRT",
      "OutOfMemoryError",
      "lowmemorykiller",
      "Kill '${PACKAGE_NAME}'",
      "WINDOW DIED",
      "Process ${PACKAGE_NAME}",
      "has died",
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
    expect(source).toContain("memory-pressure.log");
    expect(source).toContain("memory-pressure-package.log");
    expect(source).toContain("memory-pressure-system.log");
    expect(source).toContain('lowmemorykiller:.*(Kill \'${PACKAGE_NAME}\'|${PACKAGE_NAME})');
    expect(source).toContain("Process ${PACKAGE_NAME} .*has died");
    expect(source).toContain("WINDOW DIED.*${PACKAGE_NAME}");
    expect(source).toContain("android-runtime-app-markers.log");
    expect(source).toContain("UiAutomationService");
  });

  it("does not treat normal adb helper AndroidRuntime startup as a crash", () => {
    const source = readRepo("test_apk.sh");

    expect(source).not.toContain('"AndroidRuntime"');
    expect(source).toContain('"FATAL EXCEPTION"');
    expect(source).toContain("com.android.commands.uiautomator");
    expect(source).toContain("if package_name not in text:");
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
    expect(source).toContain("submit_chat_input_via_keyboard");
    expect(source).toContain("input keyevent 66");
    expect(source).toContain("input keyevent 111");
    expect(source).not.toContain('local_start="$(now_ms)"\n  adb shell input keyevent 111');
    expect(source).toContain('tap_desc_offset "chat-send-button" 0 35');
    expect(source).toContain("tap_chat_send_button");
    expect(source).toContain("chat-send-retries");
    expect(source).toContain("ensure_chat_input_ready");
    expect(source).toContain("relaunch_app_for_recovery");
    expect(source).toContain('monkey -p "$PACKAGE_NAME"');
    expect(source).toContain('record_skip_once "${label}-used-app-relaunch"');
    expect(source).toContain('rm -f "$xml_path"');
    expect(source).not.toContain('adb shell rm -f "$UI_XML_DEVICE_PATH"');
    expect(source).toContain("chat-input-not-ready-after-hands-free");
    expect(source).toContain("chat-input-not-ready-${label}");
    expect(source).toContain('if ! current_text="$(chat_input_text');
    expect(source).toContain("tap_chat_input_fallback");
    expect(source).toContain("tap_chat_send_fallback");
    expect(source).toContain("tap_chat_drawer_fallback");
    expect(source).toContain("dismiss_expo_warning");
    expect(source).toContain("Open debugger to view warnings");
    expect(chatSource).toContain("activeChatSessionIdRef");
    expect(chatSource).toContain('returnKeyType="send"');
    expect(chatSource).toContain('submitBehavior="submit"');
    expect(chatSource).toContain("onSubmitEditing");
    expect(chatSource).toContain("!activeChatSessionIdRef.current && !activeChatRequestIdRef.current");
    expect(chatSource).not.toContain('from "@/lib/localAgents"');
    expect(chatSource).toContain('from "@/lib/localTaskStore"');
    expect(chatSource).toContain("getCachedDeviceCapabilitiesLazy");
    expect(chatSource).toContain("import(");
    expect(chatSource).toContain("@/lib/nativeOnDeviceModelBridge");
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
    expect(source).toContain("input_clear_timeout=30");
    expect(source).toContain("input_clear_timeout=90");
    expect(source).toContain("result_wait_seconds=90");
    expect(source).toContain("deadline=$((SECONDS + 240))");
    expect(source).toContain("APK_LAUNCH_CHAT_READY_TIMEOUT");
    expect(source).toContain("launch_chat_ready_timeout");
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
    expect(source).toContain("stop_old_metro");
    expect(source).toContain('adb shell am force-stop "$PACKAGE_NAME"');
    expect(source).toContain('adb shell pm clear "$PACKAGE_NAME"');
    expect(source).toContain('app-pid-during-voice-test.log');
    expect(source).toContain('hands-free-markers.log');
    expect(source).toContain('ui-chat-ready.xml');
    expect(source).toContain("print_debug_env");
  });

  it("launch-debug_apk enables E2E and native safety envs before building for APK tests", () => {
    const source = readRepo("launch-debug_apk.sh");
    const envIndex = source.indexOf('if is_truthy "${RUN_APK_TESTS:-}"');
    const buildIndex = source.indexOf("BUILD_TYPE=debug ./build-apk.sh");
    const testIndex = source.lastIndexOf("run_apk_harness_scenario");

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
      'export EXPO_PUBLIC_E2E_MOCK_VOICE_TURN="${EXPO_PUBLIC_E2E_MOCK_VOICE_TURN:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_MOCK_HANDS_FREE="${EXPO_PUBLIC_E2E_MOCK_HANDS_FREE:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO="${EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT="${EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT:-}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_VOICE_QUERY="${EXPO_PUBLIC_E2E_VOICE_QUERY:-spitzola}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_VOICE_SURFACE="${EXPO_PUBLIC_E2E_VOICE_SURFACE:-live}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT="${EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT:-1}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE="${EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE:-Hey Elli}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND="${EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND:-tell me about Spitzola}"',
    );
    expect(source).toContain(
      'export EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT="${EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT:-1}"',
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
      expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN=");
      expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE=");
      expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO=");
      expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT=");
      expect(source).toContain("EXPO_PUBLIC_E2E_REPLY_LANGUAGE=");
      expect(source).toContain("EXPO_PUBLIC_E2E_TAMIL_STYLE=");
      expect(source).toContain("EXPO_PUBLIC_E2E_VOICE_QUERY=");
      expect(source).toContain("EXPO_PUBLIC_E2E_VOICE_SURFACE=");
      expect(source).toContain("EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT=");
      expect(source).toContain("EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE=");
      expect(source).toContain("EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND=");
      expect(source).toContain("EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT=");
      expect(source).toContain("EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=");
      expect(source).toContain("EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT=");
      expect(source).toContain("EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS=");
      expect(source).toContain("npx expo start --dev-client");
    }
  });

  it("sets each APK language before starting Metro for that scenario", () => {
    const source = readRepo("launch-debug_apk.sh");
    const englishExportIndex = source.indexOf('export EXPO_PUBLIC_E2E_REPLY_LANGUAGE="en"');
    const englishRunIndex = source.indexOf('run_apk_harness_scenario "en" "English Settings"');
    const tamilExportIndex = source.indexOf('export EXPO_PUBLIC_E2E_REPLY_LANGUAGE="ta"');
    const metroRestartAfterTamilExportIndex = source.indexOf("start_metro", tamilExportIndex);
    const tamilRunIndex = source.indexOf('run_apk_harness_scenario "ta" "Tamil Settings"');

    expect(englishExportIndex).toBeGreaterThanOrEqual(0);
    expect(englishExportIndex).toBeLessThan(englishRunIndex);
    expect(tamilExportIndex).toBeGreaterThan(englishRunIndex);
    expect(metroRestartAfterTamilExportIndex).toBeGreaterThan(tamilExportIndex);
    expect(metroRestartAfterTamilExportIndex).toBeLessThan(tamilRunIndex);
  });

  it("keeps APK precheck Vitest runs isolated from APK E2E env flags", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain('run_step "mobile-tests" env');
    expect(source).toContain("-u EXPO_PUBLIC_E2E_MOCK_VOICE_TURN");
    expect(source).toContain("-u EXPO_PUBLIC_E2E_MOCK_HANDS_FREE");
    expect(source).toContain("-u EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO");
    expect(source).toContain("-u EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT");
    expect(source).toContain("-u EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE");
    expect(source).toContain("-u EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND");
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

  it("APK harness exercises the live voice reply path with the E2E mock", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("android.permission.RECORD_AUDIO");
    expect(source).toContain("device_window_size");
    expect(source).toContain("swipe_chat_to_voice");
    expect(source).toContain("swipe_voice_to_chat");
    expect(source).toContain('start_x=$((width * 80 / 100))');
    expect(source).toContain('end_x=$((width * 20 / 100))');
    expect(source).toContain('start_x=$((width * 20 / 100))');
    expect(source).toContain('end_x=$((width * 80 / 100))');
    expect(source).toContain("swipe-chat-to-voice");
    expect(source).toContain("e2e-open-voice-button");
    expect(source).toContain("voice_orb_center_from_window");
    expect(source).toContain("strict voice telemetry markers were used");
    expect(source).toContain("voice-swipe-right-close");
    expect(source).not.toContain("tap-voice-entry-button");
    expect(source).toContain("Hold the orb to record");
    expect(source).toContain("input swipe");
    expect(source).toContain("voice-session-transcript");
    expect(source).toContain("voice-session-user-turn");
    expect(source).toContain("voice-session-assistant-turn");
    expect(source).toContain("strict command-audio telemetry markers were used");
    expect(source).toContain("E2E voice reply ready.");
    expect(source).toContain("Seri, unga voice reply ready.");
    expect(source).toContain("Spitzola");
    expect(source).toContain("not finding");
    expect(source).toContain("misheard");
    expect(source).toContain("agent_local_greeting");
    expect(source).toContain("assert_desc_absent");
    expect(source).toContain("chat-mic-button-absent-after-launch");
    expect(source).toContain("chat-mic-button-absent-after-voice");
    expect(source).toContain("chat-voice-button-absent-after-launch");
    expect(source).toContain("open-voice-mode-button-absent-after-launch");
    expect(source).toContain("voice-modal-open");
    expect(source).toContain("voice-closed");
    expect(source).toContain("voice-reply-status-visible");
    expect(source).toContain("voice-last-reply-visible");
    expect(source).not.toContain("voice-reply-status-not-ready");
    expect(source).not.toContain("Reply ready");
    expect(source).toContain("Scenario 1: English Settings");
    expect(source).toContain("Scenario 2: Tamil Settings");
    expect(source).toContain("requested_reply_language");
    expect(source).toContain("tts_language_code");
    expect(source).toContain("en-IN");
    expect(source).toContain("ta-IN");
    expect(source).toContain("client_voice_reply_tts_started");
    expect(source).toContain("client_voice_reply_tts_completed");
    expect(source).toContain("client_voice_reply_playback_started");
    expect(source).toContain("client_voice_reply_playback_finished");
    expect(source).toContain("client_voice_reply_tts_failed");
    expect(source).toContain("client_voice_reply_playback_failed");
    expect(source).toContain("voice-tts-failed");
    expect(source).toContain("voice-tts-failures.log");
    expect(source).toContain("voice-greeting-misroute.log");
    expect(source).toContain("e2e_voice_mock");
    expect(source).toContain("voice-markers.log");
    expect(source).toContain("voice-ui-clean");
    expect(source).toContain("history-kind-labels");
  });

  it("APK harness exercises mocked life context chat when enabled", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT");
    expect(source).toContain("How much did I walk today and how long did I use my phone?");
    expect(source).toContain("இன்று நான் எவ்வளவு நடந்தேன்?");
    expect(source).toContain("life-context-steps-missing");
    expect(source).toContain("life-context-distance-missing");
    expect(source).toContain("life-context-screen-time-missing");
    expect(source).toContain("7,420");
    expect(source).toContain("5.7");
    expect(source).toContain("3.5 hours");
  });

  it("test_apk.sh checks Spitzola orb transcript and both TTS languages", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("EXPO_PUBLIC_E2E_VOICE_QUERY");
    expect(source).toContain("voice-session-transcript");
    expect(source).toContain("voice-session-user-turn");
    expect(source).toContain("voice-session-assistant-turn");
    expect(source).toContain("voice-spitzola-routed-to-greeting");
    expect(source).toContain("voice-greeting-misroute");
    expect(source).toContain("en-IN");
    expect(source).toContain("ta-IN");
    expect(source).toContain("local_tamil");
    expect(source).toContain("client_voice_reply_tts_failed");
    expect(source).toContain("client_voice_reply_playback_failed");
  });

  it("APK harness exercises hands-free wake phrase conversation without a composer mic", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE");
    expect(source).toContain("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO");
    expect(source).toContain("EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE");
    expect(source).toContain("EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND");
    expect(source).toContain("e2e-hands-free-trigger-button");
    expect(source).toContain("e2e-hands-free-stop-button");
    expect(source).toContain("tap_e2e_hands_free_trigger_fallback");
    expect(source).toContain("tap_e2e_hands_free_stop_fallback");
    expect(source).toContain("tap_chat_input_fallback");
    expect(source).toContain("e2e-hands-free-trigger-desc-not-found; used coordinate fallback");
    expect(source).toContain("e2e-hands-free-stop-desc-not-found; used coordinate fallback");
    expect(source).toContain('tap_text "E2E hands-free"');
    expect(source).toContain('tap_text "E2E stop"');
    expect(source).toContain("width * 78 / 100");
    expect(source).toContain("width * 72 / 100");
    expect(source).toContain("width * 50 / 100");
    expect(source).toContain("scan_hands_free_reply_markers");
    expect(source).toContain("onCommandAudio");
    expect(source).toContain("/api/transcribe-and-analyze");
    expect(source).toContain("client_source");
    expect(source).toContain("client_voice_upload_started");
    expect(source).toContain("client_voice_upload_completed");
    expect(source).toContain("hands-free-before");
    expect(source).toContain("hands-free-after-reply");
    expect(source).toContain("hands-free-after-stop");
    expect(source).toContain("Listening");
    expect(source).toContain("hands-free-listening-resumed");
    expect(source).toContain("hands-free-telemetry-markers-missing");
    expect(source).toContain("hands-free-tts-failed");
    expect(source).toContain("chat-mic-button-absent-before-hands-free");
    expect(source).toContain("chat-mic-button-absent-after-hands-free");
  });

  it("APK harness captures memory and only retries external pre-test low-memory kills", () => {
    const launchDebug = readRepo("launch-debug_apk.sh");
    const testApk = readRepo("test_apk.sh");

    expect(launchDebug).toContain("external emulator/System UI instability before the app E2E path");
    expect(launchDebug).toContain('adb shell am force-stop "$PACKAGE_NAME"');
    expect(launchDebug).toContain('adb shell pm clear "$PACKAGE_NAME"');
    expect(launchDebug).toContain("lowmemorykiller");
    expect(launchDebug).toContain("FATAL EXCEPTION");
    expect(launchDebug).toContain("external-system-ui-anr|external-system-app-anr|external-emulator-disconnected|no-android-device");
    expect(launchDebug).toContain("memory-pressure-system.log");
    expect(launchDebug).toContain("memory-pressure-package.log");
    expect(testApk).toContain("dumpsys-meminfo-before-launch");
    expect(testApk).toContain("dumpsys-meminfo-package-before-launch");
    expect(testApk).toContain("dumpsys-meminfo-package-after-launch");
    expect(testApk).toContain("dumpsys-meminfo-after-launch");
    expect(testApk).toContain("dumpsys-meminfo-before-voice");
    expect(testApk).toContain("final-dumpsys-meminfo");
    expect(testApk).toContain("adb-reverse-list");
    expect(testApk).toContain("metro-status-before-launch");
  });

  it("dismisses only external System UI ANR overlays without hiding app crashes", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("dismiss_external_system_ui_anr");
    expect(source).toContain("System UI isn't responding");
    expect(source).toContain("Pixel Launcher isn't responding");
    expect(source).toContain("Android System isn't responding");
    expect(source).toContain("android:id/aerr_wait");
    expect(source).toContain("external-system-ui-anr");
    expect(source).toContain("external-system-app-anr");
    expect(source).toContain("external-system-ui-anr-dismissed");
    expect(source).toContain("com\\\\.google\\\\.android\\\\.");
    expect(source).toContain("external-emulator-disconnected");
    expect(source).toContain("record_external_disconnect_if_previous_system_anr");
    expect(source).toContain("external-system-anr.log");
    expect(source).toContain("system-ui-anr.log");
    expect(source).toContain("metro-disconnect-warning");
    expect(source).toContain("react-native-error-markers.log");
    expect(source).toContain("Cannot connect to Metro.");
    expect(source).toContain('"ANR in"');
    expect(source).toContain("WINDOW DIED.*${PACKAGE_NAME}");
    expect(source).toContain("scan_crashes");
    expect(source).not.toContain("aerr_close");
  });

  it("APK automation rejects the removed quick composer mic", () => {
    const source = readRepo("test_apk.sh");

    expect(source).toContain("chat-mic-button");
    expect(source).toContain("assert_desc_absent");
    expect(source).toContain("chat-mic-button-absent-after-launch");
    expect(source).toContain("chat-mic-button-absent-after-voice");
    expect(source).not.toContain("quick-mic-long-press");
    expect(source).not.toContain("quick-mic-normal-chat-not-visible");
    expect(source).not.toContain("quick-mic-not-found");
  });

  it("release app config rejects E2E mock auth env", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_AUTH", "1");

    await expect(import("../app.config")).rejects.toThrow(
      /Release\/production builds cannot enable debug E2E flags/,
    );
  });

  it("release app config rejects E2E mock voice turns", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN", "1");

    await expect(import("../app.config")).rejects.toThrow(
      /EXPO_PUBLIC_E2E_MOCK_VOICE_TURN/,
    );
  });

  it("release app config rejects E2E mock hands-free flags", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");

    await expect(import("../app.config")).rejects.toThrow(
      /EXPO_PUBLIC_E2E_MOCK_HANDS_FREE/,
    );
  });

  it("release app config rejects E2E mock life context", async () => {
    vi.stubEnv("JAI_BUILD_TYPE", "release");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT", "1");

    await expect(import("../app.config")).rejects.toThrow(
      /EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT/,
    );
  });

  it("chat screen exposes automation labels", () => {
    const source = readMobile("app/(chat)/index.tsx");

    [
      "chat-input",
      "chat-send-button",
      "chat-swipe-surface",
      "voice-swipe-surface",
      "chat-drawer-button",
      "e2e-hands-free-trigger-button",
      "e2e-hands-free-stop-button",
      "chat-assistant-response",
      "chat-thinking-indicator",
    ].forEach((label) => {
      expect(source).toContain(label);
    });
    expect(source).not.toContain("open-voice-mode-button");
    expect(source).not.toContain("chat-voice-button");
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
