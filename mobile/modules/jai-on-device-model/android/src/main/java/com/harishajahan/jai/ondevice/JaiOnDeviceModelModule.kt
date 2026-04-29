package com.harishajahan.jai.ondevice

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Modules bridge consumed by mobile/lib/nativeOnDeviceModelBridge.ts.
 *
 * This module never calls OpenAI or the backend. It only verifies local GGUF
 * assets and then delegates to the app-owned llama.cpp JNI binding scaffold in
 * JaiLlamaCppBinding. The JNI binding intentionally fails clearly until the
 * native llama.cpp library is linked into the custom dev-client/prebuild app.
 */
class JaiOnDeviceModelModule : Module() {
  private val engine: JaiOnDeviceModelEngine by lazy {
    JaiOnDeviceModelEngine(requireNotNull(appContext.reactContext) { "React context unavailable" })
  }

  override fun definition() = ModuleDefinition {
    Name("JaiOnDeviceModel")

    Function("isAvailable") {
      true
    }

    Function("isSpeechToTextAvailable") {
      false
    }

    AsyncFunction("initialize") { config: Map<String, Any?> ->
      engine.initialize(config)
    }

    AsyncFunction("completeChat") { input: Map<String, Any?> ->
      engine.completeChat(input)
    }

    AsyncFunction("embedTexts") { input: Map<String, Any?> ->
      engine.embedTexts(input)
    }

    AsyncFunction("transcribeAudio") { input: Map<String, Any?> ->
      engine.transcribeAudio(input)
    }

    AsyncFunction("sha256File") { input: Map<String, Any?> ->
      engine.sha256File(input)
    }
  }
}
