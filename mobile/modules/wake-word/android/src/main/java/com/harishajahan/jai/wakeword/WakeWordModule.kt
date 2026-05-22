package com.harishajahan.jai.wakeword

import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WakeWordModule : Module() {
  private val engine: OpenWakeWordEngine by lazy {
    OpenWakeWordEngine()
  }

  override fun definition() = ModuleDefinition {
    Name("JaiWakeWord")

    Events("onWake", "onWakeScore", "onWakeError")

    Function("isAvailable") {
      true
    }

    AsyncFunction("getStatus") {
      engine.getStatus()
    }

    AsyncFunction("start") { config: Map<String, Any?> ->
      try {
        engine.start(
          config = config,
          onWake = { event -> sendEvent("onWake", event.toBundle()) },
          onScore = { event -> sendEvent("onWakeScore", event.toBundle()) },
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
  }

  private fun sendError(code: String, message: String) {
    val bundle = Bundle()
    bundle.putString("code", code)
    bundle.putString("message", message)
    sendEvent("onWakeError", bundle)
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
