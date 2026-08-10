package com.harishajahan.jai.wakeword

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WakeWordModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var realtimePcmSource: PcmAudioSource? = null
  private var realtimePcmPlayback: AudioTrack? = null
  private var realtimePcmSequence = 0
  private val engine: OpenWakeWordEngine by lazy {
    OpenWakeWordEngine()
  }
  private val handsFreeCallbacks = object : HandsFreeControllerCallbacks {
    override fun onState(event: HandsFreeStateEvent) {
      sendEventOnMain("onState", event.toBundle())
    }

    override fun onWake(event: WakeWordEvent) {
      sendEventOnMain("onWake", event.toBundle())
    }

    override fun onWakeScore(event: WakeWordEvent) {
      sendEventOnMain("onWakeScore", event.toBundle())
    }

    override fun onCommand(event: HandsFreeCommandEvent) {
      sendEventOnMain("onCommand", event.toBundle())
    }

    override fun onCommandAudio(event: HandsFreeCommandAudioEvent) {
      sendEventOnMain("onCommandAudio", event.toBundle())
    }

    override fun onError(event: HandsFreeWakeErrorEvent) {
      sendError(event)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("JaiWakeWord")

    Events("onState", "onWake", "onWakeScore", "onCommand", "onCommandAudio", "onWakeError", "onRealtimePcmFrame", "onRealtimePcmError", "onRealtimePcmStopped")

    AsyncFunction("startRealtimePcm") { config: Map<String, Any?> ->
      realtimePcmSource?.stop()
      val sampleRate = (config["sampleRate"] as? Number)?.toInt()?.takeIf { it > 0 } ?: 16000
      val frameSamples = (config["frameSamples"] as? Number)?.toInt()?.takeIf { it > 0 } ?: 512
      val frameMs = ((frameSamples * 1000.0) / sampleRate).toInt().coerceAtLeast(1)
      realtimePcmSequence = 0
      val source = PcmAudioSource(sampleRate = sampleRate, frameMs = frameMs, listener = object : PcmAudioSourceListener {
        override fun onCaptureError(error: PcmCaptureError) {
          val bundle = Bundle().apply { putString("code", error.code); putString("message", error.message); putBoolean("restartable", error.restartable) }
          sendEventOnMain("onRealtimePcmError", bundle)
        }
        override fun onCaptureStopped() { sendEventOnMain("onRealtimePcmStopped", Bundle()) }
      })
      realtimePcmSource = source
      try {
        source.start { frame ->
          val bytes = ByteArray(frame.size * 2)
          frame.forEachIndexed { index, value ->
            bytes[index * 2] = (value.toInt() and 0xff).toByte()
            bytes[index * 2 + 1] = ((value.toInt() shr 8) and 0xff).toByte()
          }
          val bundle = Bundle().apply {
            putString("encoding", "pcm_s16le")
            putInt("sampleRate", sampleRate)
            putInt("frameSamples", frame.size)
            putInt("sequence", ++realtimePcmSequence)
            putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
          }
          sendEventOnMain("onRealtimePcmFrame", bundle)
        }
      } catch (error: Throwable) {
        realtimePcmSource = null
        throw error
      }
      mapOf("ok" to true, "sampleRate" to sampleRate, "frameSamples" to frameSamples)
    }

    AsyncFunction("stopRealtimePcm") {
      realtimePcmSource?.stop()
      realtimePcmSource = null
      mapOf("ok" to true)
    }

    AsyncFunction("getRealtimePcmStatus") {
      realtimePcmSource?.status()?.let { status ->
        mapOf("running" to status.captureThreadAlive, "sampleRate" to 16000, "frameSamples" to 512, "aec" to status.acousticEchoCancelerEnabled, "noiseSuppression" to status.noiseSuppressorEnabled, "agc" to status.automaticGainControlEnabled)
      } ?: mapOf("running" to false, "sampleRate" to 16000, "frameSamples" to 512)
    }

    AsyncFunction("startRealtimePcmPlayback") { config: Map<String, Any?> ->
      stopRealtimePcmPlayback()
      val sampleRate = (config["sampleRate"] as? Number)?.toInt()?.takeIf { it in setOf(8000, 16000, 22050, 24000) }
        ?: throw IllegalArgumentException("Unsupported realtime PCM sample rate")
      val format = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build()
      val minimum = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minimum <= 0) throw IllegalStateException("Realtime PCM playback is unavailable")
      val track = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
        AudioTrack.Builder()
          .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setAudioFormat(format)
          .setBufferSizeInBytes((minimum * 2).coerceAtLeast(8192))
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()
      } else {
        @Suppress("DEPRECATION")
        AudioTrack(AudioTrack.MODE_STREAM, sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT, (minimum * 2).coerceAtLeast(8192), AudioTrack.MODE_STREAM)
      }
      if (track.state != AudioTrack.STATE_INITIALIZED) {
        track.release()
        throw IllegalStateException("Realtime PCM playback could not be initialized")
      }
      track.play()
      realtimePcmPlayback = track
      mapOf("ok" to true, "sampleRate" to sampleRate)
    }

    AsyncFunction("writeRealtimePcmPlayback") { base64: String ->
      val track = realtimePcmPlayback ?: throw IllegalStateException("Realtime PCM playback is not started")
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      if (bytes.isEmpty() || bytes.size % 2 != 0) throw IllegalArgumentException("Invalid realtime PCM audio")
      val written = track.write(bytes, 0, bytes.size, AudioTrack.WRITE_BLOCKING)
      if (written < 0) throw IllegalStateException("Realtime PCM playback write failed")
      mapOf("ok" to true, "bytes" to written)
    }

    AsyncFunction("stopRealtimePcmPlayback") {
      stopRealtimePcmPlayback()
      mapOf("ok" to true)
    }

    Function("isAvailable") {
      engine.isAvailable()
    }

    AsyncFunction("getStatus") {
      val engineStatus = engine.getStatus().toMutableMap()
      val sessionStatus = HandsFreeControllerRegistry.status()
      engineStatus["handsFree"] = sessionStatus
      engineStatus["sessionState"] = sessionStatus["state"]
      if (sessionStatus["running"] == true) {
        engineStatus["running"] = true
      }
      engineStatus
    }

    AsyncFunction("configure") { config: Map<String, Any?> ->
      HandsFreeControllerRegistry.configure(config)
      mapOf("ok" to true)
    }

    AsyncFunction("startSession") { config: Map<String, Any?> ->
      try {
        val context = appContext.reactContext
          ?: throw WakeWordException(
            "JAI_HANDS_FREE_CONTEXT_UNAVAILABLE",
            "React context is unavailable for hands-free wake-word service.",
          )
        HandsFreeControllerRegistry.setCallbacks(handsFreeCallbacks)
        HandsFreeForegroundService.startSession(context, config)
        mapOf("ok" to true)
      } catch (error: WakeWordException) {
        sendError(error.code, error.detail, permanent = true, restartable = false, source = "session")
        throw error
      }
    }

    AsyncFunction("startDemoSession") {
      try {
        val context = appContext.reactContext
          ?: throw WakeWordException(
            "JAI_HANDS_FREE_CONTEXT_UNAVAILABLE",
            "React context is unavailable for hands-free wake-word service.",
          )
        val config = mapOf(
          "phraseKey" to "e2e-mock",
          "wakePhrase" to "Hey Elli",
          "modelPaths" to mapOf("wakeModel" to "play-demo-fixture.onnx"),
          "threshold" to 0.5,
          "sampleRate" to 16000,
          "frameMs" to 80,
          "minWakeIntervalMs" to 1800,
        )
        HandsFreeControllerRegistry.setCallbacks(handsFreeCallbacks)
        HandsFreeForegroundService.startSession(context, config)
        mapOf("ok" to true)
      } catch (error: WakeWordException) {
        sendError(error.code, error.detail, permanent = true, restartable = false, source = "session")
        throw error
      }
    }

    AsyncFunction("stopSession") {
      appContext.reactContext?.let { context ->
        try {
          HandsFreeForegroundService.stopSession(context)
        } catch (_: Throwable) {
          HandsFreeControllerRegistry.stopSession()
        }
        HandsFreeControllerRegistry.stopSession()
        HandsFreeForegroundService.stopServiceIfRunning(context)
      } ?: HandsFreeControllerRegistry.stopSession()
      mapOf("ok" to true)
    }

    AsyncFunction("cancelCommand") {
      HandsFreeControllerRegistry.cancelCommand()
      mapOf("ok" to true)
    }

    AsyncFunction("notifyTtsStarted") {
      HandsFreeControllerRegistry.notifyTtsStarted()
      mapOf("ok" to true)
    }

    AsyncFunction("notifyTtsCompleted") {
      HandsFreeControllerRegistry.notifyTtsCompleted()
      mapOf("ok" to true)
    }

    AsyncFunction("start") { config: Map<String, Any?> ->
      try {
        engine.start(
          config = config,
          onWake = { event -> sendEventOnMain("onWake", event.toBundle()) },
          onScore = { event -> sendEventOnMain("onWakeScore", event.toBundle()) },
          onError = { code, message ->
            sendError(code, message, permanent = false, restartable = false, source = "capture")
          },
        )
        mapOf("ok" to true)
      } catch (error: WakeWordException) {
        sendError(error.code, error.detail, permanent = true, restartable = false, source = "model")
        throw error
      }
    }

    AsyncFunction("stop") {
      engine.stop()
      mapOf("ok" to true)
    }

    AsyncFunction("validateFixturePipeline") {
      engine.validateFixturePipeline()
    }

    AsyncFunction("validateModelBundle") { config: Map<String, Any?> ->
      try {
        engine.validateModelBundle(config)
      } catch (error: WakeWordException) {
        sendError(error.code, error.detail, permanent = true, restartable = false, source = "model")
        throw error
      }
    }
  }

  private fun stopRealtimePcmPlayback() {
    val track = realtimePcmPlayback ?: return
    realtimePcmPlayback = null
    try { track.pause() } catch (_: Throwable) { }
    try { track.flush() } catch (_: Throwable) { }
    try { track.stop() } catch (_: Throwable) { }
    try { track.release() } catch (_: Throwable) { }
  }

  private fun sendError(
    code: String,
    message: String,
    permanent: Boolean,
    restartable: Boolean,
    source: String,
    sessionActive: Boolean = false,
  ) {
    sendError(
      HandsFreeWakeErrorEvent(
        code = code,
        message = message,
        permanent = permanent,
        restartable = restartable,
        source = source,
        sessionActive = sessionActive,
      ),
    )
  }

  private fun sendError(event: HandsFreeWakeErrorEvent) {
    val bundle = Bundle()
    bundle.putString("code", event.code)
    bundle.putString("message", event.message)
    bundle.putBoolean("permanent", event.permanent)
    bundle.putBoolean("restartable", event.restartable)
    bundle.putBoolean("sessionActive", event.sessionActive)
    bundle.putString("source", event.source)
    bundle.putDouble("timestamp", event.timestamp.toDouble())
    sendEventOnMain("onWakeError", bundle)
  }

  private fun sendEventOnMain(name: String, bundle: Bundle) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      sendEvent(name, bundle)
      return
    }
    mainHandler.post {
      sendEvent(name, bundle)
    }
  }
}

private fun WakeWordEvent.toBundle(): Bundle {
  val bundle = Bundle()
  bundle.putDouble("score", score)
  bundle.putString("model", model)
  bundle.putDouble("timestamp", timestamp.toDouble())
  phraseKey?.let { bundle.putString("phraseKey", it) }
  return bundle
}

private fun HandsFreeStateEvent.toBundle(): Bundle {
  val bundle = Bundle()
  bundle.putString("state", state.wireName)
  bundle.putString("previousState", previousState.wireName)
  bundle.putString("reason", reason)
  bundle.putDouble("timestamp", timestamp.toDouble())
  return bundle
}

private fun HandsFreeCommandEvent.toBundle(): Bundle {
  val bundle = Bundle()
  bundle.putString("text", text)
  bundle.putBoolean("empty", empty)
  reason?.let { bundle.putString("reason", it) }
  bundle.putDouble("timestamp", timestamp.toDouble())
  return bundle
}

private fun HandsFreeCommandAudioEvent.toBundle(): Bundle {
  val bundle = Bundle()
  bundle.putString("uri", fileUri)
  bundle.putString("fileUri", fileUri)
  bundle.putDouble("durationMs", durationMs.toDouble())
  bundle.putInt("sampleRate", sampleRate)
  bundle.putString("mimeType", mimeType)
  bundle.putDouble("timestamp", timestamp.toDouble())
  return bundle
}
