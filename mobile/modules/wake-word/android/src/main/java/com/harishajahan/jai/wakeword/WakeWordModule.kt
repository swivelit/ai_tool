package com.harishajahan.jai.wakeword

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WakeWordModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
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

    Events("onState", "onWake", "onWakeScore", "onCommand", "onCommandAudio", "onWakeError")

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
