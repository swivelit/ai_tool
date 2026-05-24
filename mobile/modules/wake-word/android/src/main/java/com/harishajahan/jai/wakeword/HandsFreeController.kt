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

interface HandsFreeControllerCallbacks {
  fun onState(event: HandsFreeStateEvent)
  fun onWake(event: WakeWordEvent)
  fun onWakeScore(event: WakeWordEvent)
  fun onCommand(event: HandsFreeCommandEvent)
  fun onCommandAudio(event: HandsFreeCommandAudioEvent)
  fun onError(code: String, message: String)
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
  private var captureRestartCount = 0L
  private var vadSpeechFrames = 0L
  private var vadSkippedWakeFrames = 0L
  private var vadHangoverFrames = 0L
  private var wakeVadHangoverRemainingMs = 0L

  fun startSession(rawConfig: Map<String, Any?>) {
    stopSession(emitIdle = false)
    val parsed = engine.parseConfig(rawConfig)
    val nextPipeline = try {
      engine.createPipeline(parsed)
    } catch (error: WakeWordException) {
      lastError = error.detail
      emitError(error.code, error.detail)
      throw error
    } catch (error: Throwable) {
      val detail = "Could not load OpenWakeWord ONNX models: ${error.message ?: "unknown ONNX error"}"
      lastError = detail
      emitError("JAI_WAKE_MODEL_LOAD_FAILED", detail)
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
      onError = { code, message ->
        synchronized(lock) {
          lastError = message
          lastInferenceError = message
        }
        emitError(code, message)
        transition(HandsFreeNativeState.IDLE, "wake_inference_error")
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
      vadSpeechFrames = 0L
      vadSkippedWakeFrames = 0L
      vadHangoverFrames = 0L
      wakeVadHangoverRemainingMs = 0L
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
      emitError("JAI_HANDS_FREE_SESSION_START_FAILED", detail)
      throw WakeWordException("JAI_HANDS_FREE_SESSION_START_FAILED", detail, error)
    }
  }

  fun stopSession(emitIdle: Boolean = true) {
    routing.set(false)
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
    }
    if (emitIdle) {
      transition(HandsFreeNativeState.IDLE, "session_stopped")
    }
  }

  fun cancelCommand() {
    synchronized(lock) {
      commandFrames = mutableListOf()
      commandLiveDurationMs = 0L
      commandSilenceMs = 0L
      commandSpeechDetected = false
    }
    transition(HandsFreeNativeState.WAKE_LISTENING, "command_cancelled")
  }

  fun notifyTtsStarted() {
    transition(HandsFreeNativeState.SPEAKING, "tts_started")
  }

  fun notifyTtsCompleted() {
    if (stateMachine.currentState() != HandsFreeNativeState.IDLE) {
      transition(HandsFreeNativeState.WAKE_LISTENING, "tts_completed")
    }
  }

  fun status(): Map<String, Any?> {
    val captureStats = captureQueue?.stats()
    val wakeStats = wakeQueue?.stats()
    val currentConfig = config
    val captureStatus = audioSource?.status()
    val inferenceStatus = inferenceWorker?.status()
    return mapOf(
      "running" to (stateMachine.currentState() != HandsFreeNativeState.IDLE),
      "state" to stateMachine.currentState().wireName,
      "sampleRate" to (currentConfig?.sampleRate ?: 16000),
      "frameMs" to (currentConfig?.frameMs ?: 80),
      "lastError" to lastError,
      "captureDroppedFrames" to (captureStats?.droppedFrames ?: 0L),
      "wakeDroppedFrames" to (wakeStats?.droppedFrames ?: 0L),
      "captureQueuedFrames" to (captureStats?.queuedFrames ?: 0),
      "wakeQueuedFrames" to (wakeStats?.queuedFrames ?: 0),
      "vadSpeechFrames" to vadSpeechFrames,
      "vadSkippedWakeFrames" to vadSkippedWakeFrames,
      "vadHangoverFrames" to vadHangoverFrames,
      "captureThreadAlive" to (captureStatus?.captureThreadAlive ?: false),
      "lastCaptureError" to (lastCaptureError ?: captureStatus?.lastCaptureError),
      "lastCaptureErrorCode" to captureStatus?.lastCaptureErrorCode,
      "captureRestartCount" to captureRestartCount,
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
        shouldInfer = true
      } else if (wakeVadHangoverRemainingMs > 0L) {
        vadHangoverFrames += 1
        wakeVadHangoverRemainingMs = (wakeVadHangoverRemainingMs - frameMs).coerceAtLeast(0L)
        shouldInfer = true
      } else {
        vadSkippedWakeFrames += 1
        shouldInfer = false
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
        commandFrames = preRollFrames.map { it.copyOf() }.toMutableList()
        commandLiveDurationMs = 0L
        commandSilenceMs = 0L
        commandSpeechDetected = false
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
      emitError("JAI_HANDS_FREE_COMMAND_AUDIO_FAILED", detail)
      transition(HandsFreeNativeState.WAKE_LISTENING, "command_audio_failed")
    }
  }

  private fun transition(nextState: HandsFreeNativeState, reason: String) {
    callbacks()?.onState(stateMachine.transition(nextState, reason))
  }

  private fun emitError(code: String, message: String) {
    callbacks()?.onError(code, message)
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
            emitError("JAI_WAKE_AUDIO_STOPPED", message)
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
    emitError(error.code, error.message)
    if (error.restartable && !error.permanent) {
      scheduleCaptureRestart(parsed, queue)
      return
    }
    routing.set(false)
    transition(HandsFreeNativeState.IDLE, "capture_error")
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
        emitError("JAI_WAKE_AUDIO_RESTART_FAILED", detail)
        routing.set(false)
        transition(HandsFreeNativeState.IDLE, "capture_restart_failed")
      } finally {
        captureRestartScheduled.set(false)
      }
    }
  }

  companion object {
    private const val CAPTURE_RESTART_COOLDOWN_MS = 250L
    private const val WAKE_VAD_HANGOVER_MS = 400L
  }
}

object HandsFreeControllerRegistry {
  private val lock = Object()
  private var controller: HandsFreeController? = null
  private var callbacks: HandsFreeControllerCallbacks? = null
  private var configuredConfig: Map<String, Any?>? = null
  private var pendingStartConfig: Map<String, Any?>? = null

  fun setCallbacks(nextCallbacks: HandsFreeControllerCallbacks?) {
    synchronized(lock) {
      callbacks = nextCallbacks
    }
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
