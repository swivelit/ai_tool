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

  override fun definition() = ModuleDefinition {
    Name("JaiWakeWord")

    Events("onWake", "onWakeScore", "onWakeError")

    Function("isAvailable") {
      engine.isAvailable()
    }

    AsyncFunction("getStatus") {
      engine.getStatus()
    }

    AsyncFunction("start") { config: Map<String, Any?> ->
      try {
        engine.start(
          config = config,
          onWake = { event -> sendEventOnMain("onWake", event.toBundle()) },
          onScore = { event -> sendEventOnMain("onWakeScore", event.toBundle()) },
          onError = { code, message -> sendError(code, message) },
        )
        mapOf("ok" to true)
      } catch (error: WakeWordException) {
        sendError(error.code, error.detail)
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
  }

  private fun sendError(code: String, message: String) {
    val bundle = Bundle()
    bundle.putString("code", code)
    bundle.putString("message", message)
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
