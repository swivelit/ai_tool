package com.harishajahan.jai.wakeword

import android.content.Context
import android.net.Uri
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

data class HandsFreeCommandEvent(
  val text: String,
  val empty: Boolean,
  val reason: String?,
  val timestamp: Long = System.currentTimeMillis(),
)

data class HandsFreeCommandAudioEvent(
  val fileUri: String,
  val durationMs: Long,
  val sampleRate: Int,
  val mimeType: String = "audio/wav",
  val timestamp: Long = System.currentTimeMillis(),
)

data class HandsFreeWakeErrorEvent(
  val code: String,
  val message: String,
  val permanent: Boolean,
  val restartable: Boolean,
  val sessionActive: Boolean,
  val source: String,
  val timestamp: Long = System.currentTimeMillis(),
)

interface HandsFreeControllerCallbacks {
  fun onState(event: HandsFreeStateEvent)
  fun onWake(event: WakeWordEvent)
  fun onWakeScore(event: WakeWordEvent)
  fun onCommand(event: HandsFreeCommandEvent)
  fun onCommandAudio(event: HandsFreeCommandAudioEvent)
  fun onError(event: HandsFreeWakeErrorEvent)
}

class HandsFreeController(
  context: Context,
  private val callbacks: () -> HandsFreeControllerCallbacks?,
) {
  private val appContext = context.applicationContext
  private val lock = Any()
  private val stateMachine = HandsFreeStateMachine()
  private val engine = OpenWakeWordEngine()
  private val routing = AtomicBoolean(false)
  private val captureRestartScheduled = AtomicBoolean(false)
  private val fatalCleanupInFlight = AtomicBoolean(false)
  private val vad = EnergyVoiceActivityDetector()

  private var config: WakeWordConfig? = null
  private var pipeline: WakeWordPipeline? = null
  private var audioSource: PcmAudioSource? = null
  private var captureQueue: AudioFrameQueue? = null
  private var wakeQueue: AudioFrameQueue? = null
  private var inferenceWorker: WakeInferenceWorker? = null
  private var routerThread: Thread? = null
  private var preRollBuffer: PreRollBuffer? = null
  private var commandFrames: MutableList<ShortArray> = mutableListOf()
  private var commandLiveDurationMs = 0L
  private var commandSilenceMs = 0L
  private var commandSpeechDetected = false
  private var lastError: String? = null
  private var lastCaptureError: String? = null
  private var lastInferenceError: String? = null
  private var fatalErrorCode: String? = null
  private var fatalErrorMessage: String? = null
  private var captureRestartCount = 0L
  private var vadSpeechFrames = 0L
  private var vadSkippedWakeFrames = 0L
  private var vadHangoverFrames = 0L
  private var vadFailOpenFrames = 0L
  private var wakeVadHangoverRemainingMs = 0L
  private var wakeVadSkippedSinceFailOpenMs = 0L
  private var commandPreRollSpeechFrames = 0L
  private var lastCommandPreRollMs = 0L
  private var staleNotificationCount = 0L
  private var commandReadyTimeoutCount = 0L
  private var commandReadyWatchdogToken = 0L
  private var commandReadyWatchdogThread: Thread? = null

  fun startSession(rawConfig: Map<String, Any?>) {
    stopSession(emitIdle = false)
    fatalCleanupInFlight.set(false)

    val parsed: WakeWordConfig
    val nextPipeline: WakeWordPipeline
    try {
      parsed = engine.parseConfig(rawConfig)
      vad.speechRmsThreshold = parsed.vadRmsThreshold
      nextPipeline = engine.createPipeline(parsed)
    } catch (error: WakeWordException) {
      handleStartModelFailure(
        code = error.code,
        message = error.detail,
      )
      throw error
    } catch (error: Throwable) {
      val detail = "Could not load OpenWakeWord ONNX models: ${error.message ?: "unknown ONNX error"}"
      handleStartModelFailure(
        code = "JAI_WAKE_MODEL_LOAD_FAILED",
        message = detail,
      )
      throw WakeWordException("JAI_WAKE_MODEL_LOAD_FAILED", detail, error)
    }

    val nextCaptureQueue = AudioFrameQueue(capacityFrames = 32)
    val nextWakeQueue = AudioFrameQueue(capacityFrames = 16)
    val nextPreRoll = PreRollBuffer(parsed.sampleRate, durationMs = 1500)
    val nextAudioSource = createAudioSource(parsed, nextCaptureQueue)
    val nextInferenceWorker = WakeInferenceWorker(
      frameQueue = nextWakeQueue,
      pipeline = nextPipeline,
      threshold = parsed.threshold,
      minWakeIntervalMs = parsed.minWakeIntervalMs,
      onWake = { event -> handleWakeDetected(event) },
      onScore = { event -> callbacks()?.onWakeScore(event) },
      onError = { error ->
        synchronized(lock) {
          lastError = error.message
          lastInferenceError = error.message
        }
        stopAfterFatalError(
          code = error.code,
          message = error.message,
          source = "inference",
          permanent = error.permanent,
          restartable = error.restartable,
          reason = "wake_inference_error",
        )
      },
      onStopped = { reason ->
        if (reason != null) {
          synchronized(lock) {
            lastInferenceError = reason
          }
        }
      },
    )

    synchronized(lock) {
      config = parsed
      pipeline = nextPipeline
      captureQueue = nextCaptureQueue
      wakeQueue = nextWakeQueue
      preRollBuffer = nextPreRoll
      audioSource = nextAudioSource
      inferenceWorker = nextInferenceWorker
      commandFrames = mutableListOf()
      commandLiveDurationMs = 0L
      commandSilenceMs = 0L
      commandSpeechDetected = false
      lastError = null
      lastCaptureError = null
      lastInferenceError = null
      fatalErrorCode = null
      fatalErrorMessage = null
      vadSpeechFrames = 0L
      vadSkippedWakeFrames = 0L
      vadHangoverFrames = 0L
      vadFailOpenFrames = 0L
      wakeVadHangoverRemainingMs = 0L
      wakeVadSkippedSinceFailOpenMs = 0L
      commandPreRollSpeechFrames = 0L
      lastCommandPreRollMs = 0L
    }

    try {
      routing.set(true)
      nextInferenceWorker.start()
      startRouter(nextCaptureQueue, nextWakeQueue, nextPreRoll, parsed)
      nextAudioSource.start(nextCaptureQueue)
      transition(HandsFreeNativeState.WAKE_LISTENING, "session_started")
    } catch (error: Throwable) {
      stopSession(emitIdle = true)
      val detail = "Could not start hands-free microphone session: ${error.message ?: "unknown error"}"
      lastError = detail
      emitError(
        code = "JAI_HANDS_FREE_SESSION_START_FAILED",
        message = detail,
        permanent = isPermanentSessionStartError(error),
        restartable = !isPermanentSessionStartError(error),
        source = "session",
        sessionActive = false,
      )
      throw WakeWordException("JAI_HANDS_FREE_SESSION_START_FAILED", detail, error)
    }
  }

  fun stopSession(emitIdle: Boolean = true) {
    releaseSessionResources(clearFatal = false)
    if (emitIdle) {
      transitionIdleIfNeeded("session_stopped")
    }
  }

  private fun releaseSessionResources(clearFatal: Boolean) {
    cancelCommandReadyWatchdog()
    routing.set(false)
    captureRestartScheduled.set(false)
    val router = routerThread
    try {
      audioSource?.stop()
    } catch (_: Throwable) {
    }
    try {
      captureQueue?.close()
    } catch (_: Throwable) {
    }
    try {
      wakeQueue?.close()
    } catch (_: Throwable) {
    }
    if (router != null && Thread.currentThread() != router) {
      try {
        router.join(250L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    try {
      inferenceWorker?.stop()
    } catch (_: Throwable) {
    }
    try {
      pipeline?.close()
    } catch (_: Throwable) {
    }
    synchronized(lock) {
      audioSource = null
      captureQueue = null
      wakeQueue = null
      inferenceWorker = null
      routerThread = null
      pipeline = null
      preRollBuffer = null
      commandFrames = mutableListOf()
      commandLiveDurationMs = 0L
      commandSilenceMs = 0L
      commandSpeechDetected = false
      config = null
      wakeVadHangoverRemainingMs = 0L
      wakeVadSkippedSinceFailOpenMs = 0L
      if (clearFatal) {
        fatalErrorCode = null
        fatalErrorMessage = null
      }
    }
  }

  fun cancelCommand() {
    synchronized(lock) {
      if (!isSessionActiveLocked()) {
        staleNotificationCount += 1
        return
      }
      commandFrames = mutableListOf()
      commandLiveDurationMs = 0L
      commandSilenceMs = 0L
      commandSpeechDetected = false
      commandPreRollSpeechFrames = 0L
      lastCommandPreRollMs = 0L
    }
    transition(HandsFreeNativeState.WAKE_LISTENING, "command_cancelled")
  }

  fun notifyTtsStarted() {
    synchronized(lock) {
      if (!isSessionActiveLocked() || stateMachine.currentState() != HandsFreeNativeState.COMMAND_READY) {
        staleNotificationCount += 1
        return
      }
    }
    transition(HandsFreeNativeState.SPEAKING, "tts_started")
  }

  fun notifyTtsCompleted() {
    synchronized(lock) {
      val state = stateMachine.currentState()
      if (!isSessionActiveLocked() || state == HandsFreeNativeState.IDLE || state == HandsFreeNativeState.WAKE_LISTENING) {
        staleNotificationCount += 1
        return
      }
    }
    transition(HandsFreeNativeState.WAKE_LISTENING, "tts_completed")
  }

  fun status(): Map<String, Any?> {
    val captureStats = captureQueue?.stats()
    val wakeStats = wakeQueue?.stats()
    val currentConfig = config
    val captureStatus = audioSource?.status()
    val inferenceStatus = inferenceWorker?.status()
    return mapOf(
      "running" to (routing.get() && stateMachine.currentState() != HandsFreeNativeState.IDLE),
      "state" to stateMachine.currentState().wireName,
      "sampleRate" to (currentConfig?.sampleRate ?: 16000),
      "frameMs" to (currentConfig?.frameMs ?: 80),
      "lastError" to lastError,
      "fatalErrorCode" to fatalErrorCode,
      "fatalErrorMessage" to fatalErrorMessage,
      "captureDroppedFrames" to (captureStats?.droppedFrames ?: 0L),
      "wakeDroppedFrames" to (wakeStats?.droppedFrames ?: 0L),
      "captureQueuedFrames" to (captureStats?.queuedFrames ?: 0),
      "wakeQueuedFrames" to (wakeStats?.queuedFrames ?: 0),
      "vadSpeechFrames" to vadSpeechFrames,
      "vadSkippedWakeFrames" to vadSkippedWakeFrames,
      "vadHangoverFrames" to vadHangoverFrames,
      "vadFailOpenFrames" to vadFailOpenFrames,
      "vadRmsThreshold" to (currentConfig?.vadRmsThreshold ?: vad.speechRmsThreshold),
      "commandPreRollSpeechFrames" to commandPreRollSpeechFrames,
      "lastCommandPreRollMs" to lastCommandPreRollMs,
      "staleNotificationCount" to staleNotificationCount,
      "commandReadyTimeoutCount" to commandReadyTimeoutCount,
      "captureThreadAlive" to (captureStatus?.captureThreadAlive ?: false),
      "lastCaptureError" to (lastCaptureError ?: captureStatus?.lastCaptureError),
      "lastCaptureErrorCode" to captureStatus?.lastCaptureErrorCode,
      "captureRestartCount" to captureRestartCount,
      "captureRestartScheduled" to captureRestartScheduled.get(),
      "audioSessionId" to captureStatus?.audioSessionId,
      "acousticEchoCancelerEnabled" to (captureStatus?.acousticEchoCancelerEnabled ?: false),
      "noiseSuppressorEnabled" to (captureStatus?.noiseSuppressorEnabled ?: false),
      "automaticGainControlEnabled" to (captureStatus?.automaticGainControlEnabled ?: false),
      "inferenceThreadAlive" to (inferenceStatus?.inferenceThreadAlive ?: false),
      "lastInferenceError" to (lastInferenceError ?: inferenceStatus?.lastInferenceError),
      "inferenceDroppedFrames" to (inferenceStatus?.inferenceDroppedFrames ?: 0L),
      "inferenceErrorCount" to (inferenceStatus?.inferenceErrorCount ?: 0L),
    )
  }

  private fun startRouter(
    nextCaptureQueue: AudioFrameQueue,
    nextWakeQueue: AudioFrameQueue,
    nextPreRoll: PreRollBuffer,
    parsed: WakeWordConfig,
  ) {
    routerThread = thread(name = "JaiHandsFreeRouter", isDaemon = true) {
      while (routing.get()) {
        val frame = nextCaptureQueue.take(100L) ?: continue
        nextPreRoll.append(frame)
        when (stateMachine.currentState()) {
          HandsFreeNativeState.WAKE_LISTENING,
          HandsFreeNativeState.SPEAKING -> routeWakeFrame(frame, nextWakeQueue, parsed)
          HandsFreeNativeState.COMMAND_LISTENING -> handleCommandFrame(frame, parsed)
          else -> Unit
        }
      }
    }
  }

  private fun routeWakeFrame(
    frame: ShortArray,
    nextWakeQueue: AudioFrameQueue,
    parsed: WakeWordConfig,
  ) {
    val frameMs = samplesToMs(frame.size, parsed.sampleRate).coerceAtLeast(parsed.frameMs.toLong())
    val isSpeech = vad.isSpeech(frame)
    var shouldInfer = false
    synchronized(lock) {
      if (isSpeech) {
        vadSpeechFrames += 1
        wakeVadHangoverRemainingMs = WAKE_VAD_HANGOVER_MS
        wakeVadSkippedSinceFailOpenMs = 0L
        shouldInfer = true
      } else if (wakeVadHangoverRemainingMs > 0L) {
        vadHangoverFrames += 1
        wakeVadHangoverRemainingMs = (wakeVadHangoverRemainingMs - frameMs).coerceAtLeast(0L)
        wakeVadSkippedSinceFailOpenMs = 0L
        shouldInfer = true
      } else {
        vadSkippedWakeFrames += 1
        wakeVadSkippedSinceFailOpenMs += frameMs
        if (wakeVadSkippedSinceFailOpenMs >= WAKE_VAD_FAIL_OPEN_INTERVAL_MS) {
          vadFailOpenFrames += 1
          wakeVadSkippedSinceFailOpenMs = 0L
          shouldInfer = true
        } else {
          shouldInfer = false
        }
      }
    }
    if (shouldInfer) {
      nextWakeQueue.offer(frame)
    }
  }

  private fun handleWakeDetected(event: WakeWordEvent) {
    val accepted = synchronized(lock) {
      val state = stateMachine.currentState()
      if (state != HandsFreeNativeState.WAKE_LISTENING && state != HandsFreeNativeState.SPEAKING) {
        false
      } else {
        val preRollFrames = preRollBuffer?.snapshotFrames() ?: emptyList()
        val parsed = config
        val preRollSpeechFrames = preRollFrames.count { vad.isSpeech(it) }
        commandFrames = preRollFrames.map { it.copyOf() }.toMutableList()
        commandLiveDurationMs = 0L
        commandSilenceMs = 0L
        commandSpeechDetected = preRollSpeechFrames > 0
        commandPreRollSpeechFrames = preRollSpeechFrames.toLong()
        lastCommandPreRollMs = preRollFrames.sumOf { frame ->
          samplesToMs(frame.size, parsed?.sampleRate ?: 16000)
        }
        wakeQueue?.clear()
        true
      }
    }
    if (!accepted) return
    transition(HandsFreeNativeState.WAKE_DETECTED, "wake_detected")
    callbacks()?.onWake(event)
    transition(HandsFreeNativeState.COMMAND_LISTENING, "command_listening")
  }

  private fun handleCommandFrame(frame: ShortArray, parsed: WakeWordConfig) {
    val frameMs = samplesToMs(frame.size, parsed.sampleRate).coerceAtLeast(parsed.frameMs.toLong())
    val isSpeech = vad.isSpeech(frame)
    var framesToWrite: List<ShortArray>? = null
    var emptyReason: String? = null

    synchronized(lock) {
      if (stateMachine.currentState() != HandsFreeNativeState.COMMAND_LISTENING) return
      commandFrames.add(frame.copyOf())
      commandLiveDurationMs += frameMs
      if (isSpeech) {
        commandSpeechDetected = true
        commandSilenceMs = 0L
      } else {
        commandSilenceMs += frameMs
      }

      val minCommandMs = 900L
      val sustainedSilenceMs = 1500L
      val maxCommandMs = 12_000L
      val emptyTimeoutMs = 2400L
      val shouldFinish =
        commandLiveDurationMs >= maxCommandMs ||
          (commandSpeechDetected && commandLiveDurationMs >= minCommandMs && commandSilenceMs >= sustainedSilenceMs) ||
          (!commandSpeechDetected && commandLiveDurationMs >= emptyTimeoutMs)

      if (shouldFinish) {
        framesToWrite = commandFrames.map { it.copyOf() }
        emptyReason = if (commandSpeechDetected) null else "silence"
        commandFrames = mutableListOf()
        commandLiveDurationMs = 0L
        commandSilenceMs = 0L
        commandSpeechDetected = false
      }
    }

    val frames = framesToWrite ?: return
    if (emptyReason != null) {
      callbacks()?.onCommand(
        HandsFreeCommandEvent(
          text = "",
          empty = true,
          reason = emptyReason,
        ),
      )
      transition(HandsFreeNativeState.WAKE_LISTENING, "command_empty")
      return
    }

    transition(HandsFreeNativeState.COMMAND_READY, "command_audio_ready")
    try {
      val audio = writeCommandWav(appContext, frames, parsed.sampleRate)
      callbacks()?.onCommandAudio(audio)
    } catch (error: Throwable) {
      val detail = "Could not write hands-free command audio: ${error.message ?: "unknown error"}"
      lastError = detail
      emitError(
        code = "JAI_HANDS_FREE_COMMAND_AUDIO_FAILED",
        message = detail,
        permanent = false,
        restartable = true,
        source = "session",
      )
      transition(HandsFreeNativeState.WAKE_LISTENING, "command_audio_failed")
    }
  }

  private fun transition(nextState: HandsFreeNativeState, reason: String) {
    val event = stateMachine.transition(nextState, reason)
    if (event.state == HandsFreeNativeState.COMMAND_READY) {
      startCommandReadyWatchdog()
    } else if (event.previousState == HandsFreeNativeState.COMMAND_READY) {
      cancelCommandReadyWatchdog()
    }
    callbacks()?.onState(event)
  }

  private fun transitionIdleIfNeeded(reason: String) {
    if (stateMachine.currentState() != HandsFreeNativeState.IDLE) {
      transition(HandsFreeNativeState.IDLE, reason)
    }
  }

  private fun handleStartModelFailure(code: String, message: String) {
    releaseSessionResources(clearFatal = false)
    synchronized(lock) {
      lastError = message
      fatalErrorCode = code
      fatalErrorMessage = message
      lastInferenceError = message
    }
    emitError(
      code = code,
      message = message,
      permanent = true,
      restartable = false,
      source = "model",
      sessionActive = false,
    )
    transitionIdleIfNeeded("model_load_failed")
  }

  private fun clearCommandBuffersLocked() {
    commandFrames = mutableListOf()
    commandLiveDurationMs = 0L
    commandSilenceMs = 0L
    commandSpeechDetected = false
    commandPreRollSpeechFrames = 0L
    lastCommandPreRollMs = 0L
  }

  private fun hasSessionResourcesLocked(): Boolean {
    return captureQueue != null &&
      wakeQueue != null &&
      inferenceWorker != null &&
      pipeline != null &&
      (audioSource != null || captureRestartScheduled.get())
  }

  private fun isSessionActiveLocked(): Boolean {
    return routing.get() &&
      stateMachine.currentState() != HandsFreeNativeState.IDLE &&
      hasSessionResourcesLocked()
  }

  private fun startCommandReadyWatchdog() {
    val token: Long
    synchronized(lock) {
      commandReadyWatchdogToken += 1
      token = commandReadyWatchdogToken
      commandReadyWatchdogThread?.interrupt()
      commandReadyWatchdogThread = thread(name = "JaiHandsFreeCommandReadyWatchdog", isDaemon = true) {
        try {
          Thread.sleep(COMMAND_READY_TIMEOUT_MS)
        } catch (_: InterruptedException) {
          return@thread
        }
        var shouldTimeout = false
        synchronized(lock) {
          if (
            token == commandReadyWatchdogToken &&
            isSessionActiveLocked() &&
            stateMachine.currentState() == HandsFreeNativeState.COMMAND_READY
          ) {
            commandReadyTimeoutCount += 1
            clearCommandBuffersLocked()
            commandReadyWatchdogThread = null
            shouldTimeout = true
          }
        }
        if (!shouldTimeout) return@thread
        emitError(
          code = "JAI_HANDS_FREE_COMMAND_READY_TIMEOUT",
          message = "Hands-free command audio was not handled before the timeout.",
          permanent = false,
          restartable = true,
          source = "session",
          sessionActive = true,
        )
        transition(HandsFreeNativeState.WAKE_LISTENING, "command_ready_timeout")
      }
    }
  }

  private fun cancelCommandReadyWatchdog() {
    synchronized(lock) {
      commandReadyWatchdogToken += 1
      commandReadyWatchdogThread?.interrupt()
      commandReadyWatchdogThread = null
    }
  }

  private fun emitError(
    code: String,
    message: String,
    permanent: Boolean,
    restartable: Boolean,
    source: String,
    sessionActive: Boolean = stateMachine.currentState() != HandsFreeNativeState.IDLE && routing.get(),
  ): HandsFreeWakeErrorEvent {
    val event = HandsFreeWakeErrorEvent(
      code = code,
      message = message,
      permanent = permanent,
      restartable = restartable,
      sessionActive = sessionActive,
      source = source,
    )
    callbacks()?.onError(event)
    return event
  }

  private fun stopAfterFatalError(
    code: String,
    message: String,
    source: String,
    permanent: Boolean,
    restartable: Boolean,
    reason: String,
  ) {
    if (!fatalCleanupInFlight.compareAndSet(false, true)) return
    synchronized(lock) {
      lastError = message
      fatalErrorCode = code
      fatalErrorMessage = message
      when (source) {
        "capture" -> lastCaptureError = message
        "inference", "model" -> lastInferenceError = message
      }
    }
    releaseSessionResources(clearFatal = false)
    val event = emitError(
      code = code,
      message = message,
      permanent = permanent,
      restartable = restartable,
      source = source,
      sessionActive = false,
    )
    transitionIdleIfNeeded(reason)
    HandsFreeControllerRegistry.stopServiceAfterFatalError(event)
  }

  private fun createAudioSource(parsed: WakeWordConfig, queue: AudioFrameQueue): PcmAudioSource {
    return PcmAudioSource(
      sampleRate = parsed.sampleRate,
      frameMs = parsed.frameMs,
      listener = object : PcmAudioSourceListener {
        override fun onCaptureError(error: PcmCaptureError) {
          handleCaptureError(error, parsed, queue)
        }

        override fun onCaptureStopped() {
          if (captureRestartScheduled.get()) return
          if (routing.get() && stateMachine.currentState() != HandsFreeNativeState.IDLE) {
            val message = "Microphone capture stopped unexpectedly."
            synchronized(lock) {
              lastCaptureError = message
              lastError = message
            }
            emitError(
              code = "JAI_WAKE_AUDIO_STOPPED",
              message = message,
              permanent = false,
              restartable = true,
              source = "capture",
              sessionActive = true,
            )
            scheduleCaptureRestart(parsed, queue)
          }
        }
      },
    )
  }

  private fun handleCaptureError(
    error: PcmCaptureError,
    parsed: WakeWordConfig,
    queue: AudioFrameQueue,
  ) {
    synchronized(lock) {
      lastCaptureError = error.message
      lastError = error.message
    }
    if (error.restartable && !error.permanent) {
      emitError(
        code = error.code,
        message = error.message,
        permanent = false,
        restartable = true,
        source = "capture",
        sessionActive = true,
      )
      scheduleCaptureRestart(parsed, queue)
      return
    }
    stopAfterFatalError(
      code = error.code,
      message = error.message,
      source = "capture",
      permanent = error.permanent,
      restartable = false,
      reason = "capture_error",
    )
  }

  private fun scheduleCaptureRestart(parsed: WakeWordConfig, queue: AudioFrameQueue) {
    if (!routing.get()) return
    if (!captureRestartScheduled.compareAndSet(false, true)) return
    thread(name = "JaiHandsFreeCaptureRestart", isDaemon = true) {
      try {
        Thread.sleep(CAPTURE_RESTART_COOLDOWN_MS)
        if (!routing.get()) return@thread
        val nextAudioSource = createAudioSource(parsed, queue)
        try {
          audioSource?.stop()
        } catch (_: Throwable) {
        }
        nextAudioSource.start(queue)
        synchronized(lock) {
          audioSource = nextAudioSource
          captureRestartCount += 1
          lastCaptureError = null
        }
        transition(HandsFreeNativeState.WAKE_LISTENING, "capture_restarted")
      } catch (error: Throwable) {
        val detail = "Could not restart hands-free microphone capture: ${error.message ?: "unknown error"}"
        synchronized(lock) {
          lastCaptureError = detail
          lastError = detail
        }
        stopAfterFatalError(
          code = "JAI_WAKE_AUDIO_RESTART_FAILED",
          message = detail,
          source = "capture",
          permanent = false,
          restartable = false,
          reason = "capture_restart_failed",
        )
      } finally {
        captureRestartScheduled.set(false)
      }
    }
  }

  private fun isPermanentSessionStartError(error: Throwable): Boolean {
    val value = "${error.message ?: ""} ${(error as? WakeWordException)?.code ?: ""}".lowercase()
    return value.contains("permission") ||
      value.contains("denied") ||
      value.contains("unsupported") ||
      value.contains("model") ||
      value.contains("init")
  }

  companion object {
    private const val CAPTURE_RESTART_COOLDOWN_MS = 250L
    private const val WAKE_VAD_HANGOVER_MS = 400L
    private const val WAKE_VAD_FAIL_OPEN_INTERVAL_MS = 2400L
    private const val COMMAND_READY_TIMEOUT_MS = 18_000L
  }
}

object HandsFreeControllerRegistry {
  private val lock = Object()
  private var controller: HandsFreeController? = null
  private var callbacks: HandsFreeControllerCallbacks? = null
  private var configuredConfig: Map<String, Any?>? = null
  private var pendingStartConfig: Map<String, Any?>? = null
  private var serviceStopper: ((HandsFreeWakeErrorEvent) -> Unit)? = null

  fun setCallbacks(nextCallbacks: HandsFreeControllerCallbacks?) {
    synchronized(lock) {
      callbacks = nextCallbacks
    }
  }

  fun setServiceStopper(nextStopper: ((HandsFreeWakeErrorEvent) -> Unit)?) {
    synchronized(lock) {
      serviceStopper = nextStopper
    }
  }

  fun stopServiceAfterFatalError(event: HandsFreeWakeErrorEvent) {
    synchronized(lock) {
      serviceStopper
    }?.invoke(event)
  }

  fun configure(config: Map<String, Any?>) {
    synchronized(lock) {
      configuredConfig = deepCopyMap(config)
    }
  }

  fun enqueueStartConfig(config: Map<String, Any?>) {
    synchronized(lock) {
      pendingStartConfig = deepCopyMap(config)
    }
  }

  fun startPendingSession(context: Context) {
    val config = synchronized(lock) {
      val next = pendingStartConfig ?: configuredConfig
      pendingStartConfig = null
      next
    } ?: throw WakeWordException(
      "JAI_HANDS_FREE_CONFIG_REQUIRED",
      "startSession(config) requires a wake-word model configuration.",
    )
    controller(context).startSession(config)
  }

  fun stopSession() {
    synchronized(lock) {
      controller
    }?.stopSession()
  }

  fun cancelCommand() {
    synchronized(lock) {
      controller
    }?.cancelCommand()
  }

  fun notifyTtsStarted() {
    synchronized(lock) {
      controller
    }?.notifyTtsStarted()
  }

  fun notifyTtsCompleted() {
    synchronized(lock) {
      controller
    }?.notifyTtsCompleted()
  }

  fun status(): Map<String, Any?> {
    return synchronized(lock) {
      controller
    }?.status() ?: mapOf(
      "running" to false,
      "state" to HandsFreeNativeState.IDLE.wireName,
      "sampleRate" to 16000,
      "frameMs" to 80,
    )
  }

  private fun controller(context: Context): HandsFreeController {
    synchronized(lock) {
      val existing = controller
      if (existing != null) return existing
      val created = HandsFreeController(context) {
        synchronized(lock) { callbacks }
      }
      controller = created
      return created
    }
  }

  private fun deepCopyMap(input: Map<String, Any?>): Map<String, Any?> {
    val copy = LinkedHashMap<String, Any?>()
    input.forEach { (key, value) ->
      copy[key] = if (value is Map<*, *>) {
        val nested = LinkedHashMap<String, Any?>()
        value.forEach { (nestedKey, nestedValue) ->
          nested[String.format(Locale.US, "%s", nestedKey)] = nestedValue
        }
        nested
      } else {
        value
      }
    }
    return copy
  }
}

internal fun samplesToMs(samples: Int, sampleRate: Int): Long {
  if (sampleRate <= 0) return 0L
  return samples.toLong() * 1000L / sampleRate.toLong()
}

private fun writeCommandWav(
  context: Context,
  frames: List<ShortArray>,
  sampleRate: Int,
): HandsFreeCommandAudioEvent {
  var totalSamples = 0
  for (frame in frames) {
    totalSamples += frame.size
  }
  val dataSize = totalSamples * 2
  val file = File.createTempFile("jai-handsfree-command-", ".wav", context.cacheDir)
  DataOutputStream(BufferedOutputStream(FileOutputStream(file))).use { output ->
    writeAscii(output, "RIFF")
    writeIntLe(output, 36 + dataSize)
    writeAscii(output, "WAVE")
    writeAscii(output, "fmt ")
    writeIntLe(output, 16)
    writeShortLe(output, 1)
    writeShortLe(output, 1)
    writeIntLe(output, sampleRate)
    writeIntLe(output, sampleRate * 2)
    writeShortLe(output, 2)
    writeShortLe(output, 16)
    writeAscii(output, "data")
    writeIntLe(output, dataSize)
    for (frame in frames) {
      for (sample in frame) {
        writeShortLe(output, sample.toInt())
      }
    }
  }
  return HandsFreeCommandAudioEvent(
    fileUri = Uri.fromFile(file).toString(),
    durationMs = samplesToMs(totalSamples, sampleRate),
    sampleRate = sampleRate,
  )
}

private fun writeAscii(output: DataOutputStream, value: String) {
  output.write(value.toByteArray(Charsets.US_ASCII))
}

private fun writeIntLe(output: DataOutputStream, value: Int) {
  output.writeByte(value and 0xff)
  output.writeByte((value ushr 8) and 0xff)
  output.writeByte((value ushr 16) and 0xff)
  output.writeByte((value ushr 24) and 0xff)
}

private fun writeShortLe(output: DataOutputStream, value: Int) {
  output.writeByte(value and 0xff)
  output.writeByte((value ushr 8) and 0xff)
}
