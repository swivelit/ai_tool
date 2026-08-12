import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("JaiWakeWord native module", () => {
  it("defines a local Expo module with Android audio capture and native ONNX inference", () => {
    const config = read("modules/wake-word/expo-module.config.json");
    const gradle = read("modules/wake-word/android/build.gradle");
    const manifest = read("modules/wake-word/android/src/main/AndroidManifest.xml");
    const module = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/WakeWordModule.kt",
    );
    const engine = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/OpenWakeWordEngine.kt",
    );
    const audio = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/PcmAudioSource.kt",
    );
    const vad = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/EnergyVoiceActivityDetector.kt",
    );

    expect(config).toContain("WakeWordModule");
    expect(gradle).toContain("onnxruntime-android:1.25.1");
    expect(manifest).toContain("android.permission.RECORD_AUDIO");
    expect(manifest).not.toContain("android.permission.FOREGROUND_SERVICE");
    expect(manifest).not.toContain("android.permission.FOREGROUND_SERVICE_MICROPHONE");
    expect(manifest).not.toContain("android.permission.POST_NOTIFICATIONS");
    expect(manifest).not.toContain("HandsFreeForegroundService");
    expect(manifest).not.toContain('android:foregroundServiceType="microphone"');
    expect(module).toContain('Name("JaiWakeWord")');
    expect(module).toContain("onCommandAudio");
    expect(module).toContain("onWakeError");
    expect(module).toContain('bundle.putBoolean("permanent"');
    expect(module).toContain('bundle.putBoolean("restartable"');
    expect(module).toContain('bundle.putBoolean("sessionActive"');
    expect(module).toContain('bundle.putString("source"');
    expect(module).toContain("startSession");
    expect(module).toContain("JAI_HANDS_FREE_UNAVAILABLE");
    expect(module).not.toContain("HandsFreeForegroundService");
    expect(module).toContain("stopSession");
    expect(module).toContain("notifyTtsStarted");
    expect(module).toContain("notifyTtsCompleted");
    expect(module).toContain("engine.isAvailable()");
    expect(module).toContain("Handler(Looper.getMainLooper())");
    expect(module).toContain("sendEventOnMain");
    expect(module).toContain("validateFixturePipeline");
    expect(module).toContain("validateModelBundle");
    expect(module).toContain('AsyncFunction("startRealtimePcm")');
    expect(module).toContain('AsyncFunction("stopRealtimePcm")');
    expect(module).toContain('frameSamples');
    expect(module).toContain('pcm_s16le');
    expect(module).toContain('onRealtimePcmFrame');
    expect(engine).not.toContain("fun isAvailable(): Boolean = false");
    expect(engine).toContain("OrtEnvironment");
    expect(engine).toContain("OrtSession");
    expect(engine).toContain("OnnxTensor.createTensor");
    expect(engine).toContain("OnnxWakeWordPipeline");
    expect(engine).toContain("processFrame");
    expect(engine).toContain("WakeInferenceWorker");
    expect(engine).toContain("AudioFrameQueue");
    expect(engine).toContain("parsed.minWakeIntervalMs");
    expect(engine).toContain("vadRmsThreshold");
    expect(engine).toContain('config["vadRmsThreshold"]');
    expect(engine).toContain('config["vadThreshold"]');
    expect(engine).toContain("DeterministicWakeWordPipeline");
    expect(engine).toContain('"deterministicTestSeam" to true');
    expect(engine).toContain('"realOpenWakeWordModelCompatibility" to false');
    expect(engine).toContain("fun validateModelBundle");
    expect(engine).toContain("manifestRoles");
    expect(engine).toContain("JAI_WAKE_MANIFEST_ROLES_REQUIRED");
    expect(engine).toContain('"realOpenWakeWordModelCompatibility" to true');
    expect(engine).toContain('"modelShapesAccepted" to true');
    expect(engine).toContain('"modelFilesLoaded"');
    expect(engine).toContain('"shapesAccepted"');
    expect(engine).toContain('"processFrameRan"');
    expect(engine).toContain('"wakeEmitted"');
    expect(engine).not.toContain("Native OpenWakeWord inference is not enabled");
    expect(engine).not.toContain("return false");
    expect(audio).toContain("AudioRecord");
    expect(audio).toContain("AudioFrameQueue");
    expect(audio).toContain("frameQueue.offer");
    expect(audio).toContain("MediaRecorder.AudioSource.VOICE_RECOGNITION");
    expect(vad).toContain("DEFAULT_SPEECH_RMS_THRESHOLD = 0.011");
    const controller = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/HandsFreeController.kt",
    );
    expect(controller).toContain("PreRollBuffer");
    expect(controller).toContain("EnergyVoiceActivityDetector");
    expect(controller).toContain("writeCommandWav");
    expect(controller).toContain("onCommandAudio");
    expect(controller).toContain("Uri.fromFile(file).toString()");
    expect(controller).toContain("COMMAND_LISTENING");
    expect(controller).toContain("captureRestartCount");
    expect(controller).toContain("HandsFreeWakeErrorEvent");
    expect(controller).toContain("fun stopAfterFatalError");
    expect(controller).toContain("releaseSessionResources");
    expect(controller).not.toContain("stopServiceAfterFatalError");
    expect(controller).toContain("lastCaptureError");
    expect(controller).toContain("inferenceThreadAlive");
    expect(controller).toContain("lastInferenceError");
    expect(controller).toContain("fatalErrorCode");
    expect(controller).toContain("fatalErrorMessage");
    expect(controller).toContain("vadSpeechFrames");
    expect(controller).toContain("vadSkippedWakeFrames");
    expect(controller).toContain("vadHangoverFrames");
    expect(controller).toContain("vadFailOpenFrames");
    expect(controller).toContain("vadRmsThreshold");
    expect(controller).toContain("commandPreRollSpeechFrames");
    expect(controller).toContain("staleNotificationCount");
    expect(controller).toContain("commandReadyTimeoutCount");
    expect(controller).toContain("COMMAND_READY_TIMEOUT_MS");
    expect(controller).toContain("startCommandReadyWatchdog");
    expect(controller).toContain("cancelCommandReadyWatchdog");
    expect(controller).toContain("preRollFrames.count { vad.isSpeech(it) }");
    expect(controller).toContain("commandSpeechDetected = preRollSpeechFrames > 0");
    const cancelCommand = controller.slice(
      controller.indexOf("fun cancelCommand()"),
      controller.indexOf("fun notifyTtsStarted()"),
    );
    expect(cancelCommand).toContain("!isSessionActiveLocked()");
    expect(cancelCommand).toContain("staleNotificationCount += 1");
    expect(cancelCommand.indexOf("!isSessionActiveLocked()")).toBeLessThan(
      cancelCommand.indexOf('transition(HandsFreeNativeState.WAKE_LISTENING, "command_cancelled")'),
    );
    const notifyTtsStarted = controller.slice(
      controller.indexOf("fun notifyTtsStarted()"),
      controller.indexOf("fun notifyTtsCompleted()"),
    );
    expect(notifyTtsStarted).toContain("stateMachine.currentState() != HandsFreeNativeState.COMMAND_READY");
    expect(notifyTtsStarted).toContain("staleNotificationCount += 1");
    const notifyTtsCompleted = controller.slice(
      controller.indexOf("fun notifyTtsCompleted()"),
      controller.indexOf("fun status()"),
    );
    expect(notifyTtsCompleted).toContain("!isSessionActiveLocked()");
    expect(notifyTtsCompleted).toContain("state == HandsFreeNativeState.IDLE");
    expect(notifyTtsCompleted).toContain("state == HandsFreeNativeState.WAKE_LISTENING");
    expect(notifyTtsCompleted).toContain("staleNotificationCount += 1");
    expect(controller).toContain('"running" to (routing.get() && stateMachine.currentState() != HandsFreeNativeState.IDLE)');
    const startSessionModelFailure = controller.slice(
      controller.indexOf("fun startSession"),
      controller.indexOf("val nextCaptureQueue"),
    );
    expect(startSessionModelFailure).toContain("handleStartModelFailure");
    const modelFailureCleanup = controller.slice(
      controller.indexOf("private fun handleStartModelFailure"),
      controller.indexOf("private fun clearCommandBuffersLocked"),
    );
    expect(modelFailureCleanup).toContain("releaseSessionResources(clearFatal = false)");
    expect(modelFailureCleanup).toContain('source = "model"');
    expect(modelFailureCleanup).toContain("sessionActive = false");
    expect(modelFailureCleanup).toContain('transitionIdleIfNeeded("model_load_failed")');
    const commandReadyWatchdog = controller.slice(
      controller.indexOf("private fun startCommandReadyWatchdog"),
      controller.indexOf("private fun cancelCommandReadyWatchdog"),
    );
    expect(commandReadyWatchdog).toContain("Thread.sleep(COMMAND_READY_TIMEOUT_MS)");
    expect(commandReadyWatchdog).toContain("stateMachine.currentState() == HandsFreeNativeState.COMMAND_READY");
    expect(commandReadyWatchdog).toContain("commandReadyTimeoutCount += 1");
    expect(commandReadyWatchdog).toContain('source = "session"');
    expect(commandReadyWatchdog).toContain('transition(HandsFreeNativeState.WAKE_LISTENING, "command_ready_timeout")');
    const routeWakeFrame = controller.slice(
      controller.indexOf("private fun routeWakeFrame"),
      controller.indexOf("private fun createAudioSource"),
    );
    expect(routeWakeFrame).toContain("vad.isSpeech(frame)");
    expect(routeWakeFrame).toContain("wakeVadHangoverRemainingMs");
    expect(routeWakeFrame).toContain("vadSkippedWakeFrames");
    expect(routeWakeFrame).toContain("WAKE_VAD_FAIL_OPEN_INTERVAL_MS");
    expect(routeWakeFrame).toContain("vadFailOpenFrames");
    expect(routeWakeFrame.indexOf("vad.isSpeech(frame)")).toBeLessThan(
      routeWakeFrame.indexOf("nextWakeQueue.offer(frame)"),
    );
    const fatalCleanup = controller.slice(
      controller.indexOf("private fun stopAfterFatalError"),
      controller.indexOf("private fun createAudioSource"),
    );
    expect(fatalCleanup.indexOf("releaseSessionResources(clearFatal = false)")).toBeLessThan(
      fatalCleanup.indexOf("transitionIdleIfNeeded(reason)"),
    );
    expect(fatalCleanup).toContain("sessionActive = false");
    expect(fatalCleanup).not.toContain("stopServiceAfterFatalError");
    const inferenceErrorPath = controller.slice(
      controller.indexOf("onError = { error ->"),
      controller.indexOf("onStopped = { reason ->"),
    );
    expect(inferenceErrorPath).toContain("stopAfterFatalError");
    expect(inferenceErrorPath).not.toContain("transition(HandsFreeNativeState.IDLE");
    const captureErrorPath = controller.slice(
      controller.indexOf("private fun handleCaptureError"),
      controller.indexOf("private fun scheduleCaptureRestart"),
    );
    expect(captureErrorPath).toContain("scheduleCaptureRestart(parsed, queue)");
    expect(captureErrorPath).toContain("stopAfterFatalError");
    expect(captureErrorPath).not.toContain("transition(HandsFreeNativeState.IDLE");
    const stopSessionModule = module.slice(
      module.indexOf('AsyncFunction("stopSession")'),
      module.indexOf('AsyncFunction("cancelCommand")'),
    );
    expect(stopSessionModule).toContain("HandsFreeControllerRegistry.stopSession()");
    expect(stopSessionModule).not.toContain("HandsFreeForegroundService");
    const inferenceWorker = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/WakeInferenceWorker.kt",
    );
    expect(inferenceWorker).toContain("pipeline.processFrame");
    expect(inferenceWorker).toContain("score >= threshold");
    expect(inferenceWorker).toContain("WakeInferenceWorkerStatus");
    expect(inferenceWorker).toContain("WakeInferenceError");
    expect(inferenceWorker).toContain("consecutiveErrors");
    expect(inferenceWorker).toContain("isFatalInferenceError");
    expect(inferenceWorker).toContain("permanent = true");
    expect(audio).toContain("PcmAudioSourceListener");
    expect(audio).toContain("filledSamples");
    expect(audio).toContain("AcousticEchoCanceler.create");
    expect(audio).toContain("NoiseSuppressor.create");
    expect(audio).toContain("AutomaticGainControl.create");
    expect(audio).toContain("ERROR_INVALID_OPERATION");
    expect(audio).toContain("ERROR_BAD_VALUE");
  });

  it("keeps iOS structurally wired and clearly unsupported until ONNX Runtime is linked", () => {
    const podspec = read("modules/wake-word/ios/JaiWakeWord.podspec");
    const module = read("modules/wake-word/ios/WakeWordModule.swift");
    const engine = read("modules/wake-word/ios/OpenWakeWordEngine.swift");

    expect(podspec).toContain("ExpoModulesCore");
    expect(module).toContain('Name("JaiWakeWord")');
    expect(module).toContain("validateModelBundle");
    expect(engine).toContain("JAI_WAKE_MODEL_UNSUPPORTED");
    expect(engine).toContain('"status": "unsupported"');
    expect(engine).toContain("ONNX Runtime wake pipeline is not linked");
  });

  it("keeps real bundle validation separate from the deterministic fixture seam", () => {
    const script = path.join(root, "scripts", "validate-wake-model-bundle.mjs");
    const scriptSource = fs.readFileSync(script, "utf8");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        JAI_WAKE_MODEL_BUNDLE_DIR: "",
        JAI_HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR: "",
        HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR: "",
        OPENWAKEWORD_HEY_ELLI_BUNDLE_DIR: "",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP wake model bundle validation");
    expect(scriptSource).toContain("safeFlatOnnxFileName");
    expect(scriptSource).toContain("SHA-256 mismatch");
    expect(scriptSource).toContain("byte length mismatch");
    expect(scriptSource).toContain("unsafe file path");
  });
});
