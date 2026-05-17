package com.harishajahan.jai.ondevice

private class JaiLlamaCppException(code: String, detail: String, cause: Throwable? = null) :
  IllegalStateException("JaiOnDeviceModel error [" + code + "]: " + detail, cause)


/**
 * JNI seam for the llama.cpp backend.
 *
 * Link a native library named `jai_llama_runtime` that exports the native
 * functions below. Until that library is added, native_on_device mode fails
 * loudly and never calls backend/OpenAI.
 */
object JaiLlamaCppBinding {
  private var loadFailure: Throwable? = null
  private val nativeLoaded: Boolean = try {
    System.loadLibrary("jai_llama_runtime")
    true
  } catch (error: Throwable) {
    loadFailure = error
    false
  }

  fun isNativeLibraryLoaded(): Boolean = nativeLoaded

  fun isBackendAvailable(): Boolean = nativeLoaded

  fun backendUnavailableReason(): String? {
    if (nativeLoaded) return null
    return "llama.cpp JNI library libjai_llama_runtime.so is not linked or could not be loaded. Cause: ${loadFailure?.message ?: "unknown"}"
  }

  fun diagnostics(): Map<String, Any?> {
    return mapOf(
      "nativeLibraryLoaded" to nativeLoaded,
      "llamaCppBackendAvailable" to nativeLoaded,
      "reason" to backendUnavailableReason(),
    )
  }

  fun completeChat(
    modelPath: String,
    prompt: String,
    contextSize: Int,
    threads: Int,
    temperature: Double,
    maxTokens: Int,
    requestId: String,
  ): String {
    ensureNativeLoaded()
    return nativeCompleteChat(modelPath, prompt, contextSize, threads, temperature, maxTokens, requestId)
  }

  fun embedText(
    modelPath: String,
    text: String,
    contextSize: Int,
    threads: Int,
  ): FloatArray {
    ensureNativeLoaded()
    return nativeEmbedText(modelPath, text, contextSize, threads)
  }

  fun releaseCachedModels() {
    if (!nativeLoaded) return
    nativeReleaseCachedModels()
  }

  fun cancelRequest(requestId: String) {
    if (!nativeLoaded) return
    nativeCancelRequest(requestId)
  }

  private fun ensureNativeLoaded() {
    if (nativeLoaded) return
    throw JaiLlamaCppException(
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JaiOnDeviceModel found the native bridge, but the llama.cpp JNI library `libjai_llama_runtime.so` is not linked. Add the llama.cpp CMake/JNI implementation for nativeCompleteChat/nativeEmbedText before claiming Gemma/Qwen runs on-device. Cause: ${loadFailure?.message ?: "unknown"}",
      loadFailure,
    )
  }

  private external fun nativeCompleteChat(
    modelPath: String,
    prompt: String,
    contextSize: Int,
    threads: Int,
    temperature: Double,
    maxTokens: Int,
    requestId: String,
  ): String

  private external fun nativeEmbedText(
    modelPath: String,
    text: String,
    contextSize: Int,
    threads: Int,
  ): FloatArray

  private external fun nativeReleaseCachedModels()

  private external fun nativeCancelRequest(requestId: String)
}
