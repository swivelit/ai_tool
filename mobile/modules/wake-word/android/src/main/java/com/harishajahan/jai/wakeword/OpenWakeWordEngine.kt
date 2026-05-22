package com.harishajahan.jai.wakeword

import android.net.Uri
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class WakeWordException(val code: String, val detail: String, cause: Throwable? = null) :
  IllegalStateException("JaiWakeWord error [$code]: $detail", cause)

data class WakeWordEvent(
  val score: Double,
  val model: String,
  val phraseKey: String?,
  val timestamp: Long,
)

private data class WakeWordConfig(
  val phraseKey: String,
  val wakePhrase: String,
  val wakeModelPath: String,
  val melspectrogramModelPath: String?,
  val embeddingModelPath: String?,
  val threshold: Double,
  val sampleRate: Int,
  val frameMs: Int,
  val minWakeIntervalMs: Long,
)

class OpenWakeWordEngine {
  private val running = AtomicBoolean(false)
  private var modelLoaded = false
  private var sampleRate = 16000
  private var frameMs = 80
  private var lastScore: Double? = null
  private var lastError: String? = null
  private var audioSource: PcmAudioSource? = null
  private var environment: OrtEnvironment? = null
  private var wakeSession: OrtSession? = null
  private var melSession: OrtSession? = null
  private var embeddingSession: OrtSession? = null

  @Synchronized
  fun start(
    config: Map<String, Any?>,
    onWake: (WakeWordEvent) -> Unit,
    onScore: (WakeWordEvent) -> Unit,
    onError: (String, String) -> Unit,
  ) {
    stop()
    val parsed = parseConfig(config)
    sampleRate = parsed.sampleRate
    frameMs = parsed.frameMs
    lastError = null
    lastScore = null

    val wakeModel = resolveFilePath(parsed.wakeModelPath, "wakeModel")
    val melModel = parsed.melspectrogramModelPath?.let { resolveFilePath(it, "melspectrogramModel") }
    val embeddingModel = parsed.embeddingModelPath?.let { resolveFilePath(it, "embeddingModel") }

    if (melModel == null || embeddingModel == null) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "OpenWakeWord wake detection requires melspectrogram.onnx, embedding_model.onnx, and an ONNX wake prediction model in the local bundle.",
      )
    }

    try {
      val env = OrtEnvironment.getEnvironment()
      environment = env
      val sessionOptions = OrtSession.SessionOptions()
      melSession = env.createSession(melModel.absolutePath, sessionOptions)
      embeddingSession = env.createSession(embeddingModel.absolutePath, sessionOptions)
      wakeSession = env.createSession(wakeModel.absolutePath, sessionOptions)
      modelLoaded = true

      val diagnostic = buildPipelineDiagnostic()
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "OpenWakeWord ONNX artifacts loaded, but this build does not yet enable the full mel/embedding/wake tensor pipeline. Diagnostics: $diagnostic",
      )
    } catch (error: WakeWordException) {
      lastError = error.detail
      releaseSessions()
      modelLoaded = false
      throw error
    } catch (error: Throwable) {
      val detail = "Could not initialize OpenWakeWord ONNX Runtime sessions: ${error.message ?: error.javaClass.simpleName}"
      lastError = detail
      releaseSessions()
      modelLoaded = false
      throw WakeWordException("JAI_WAKE_MODEL_LOAD_FAILED", detail, error)
    }
  }

  @Synchronized
  fun stop() {
    running.set(false)
    try {
      audioSource?.stop()
    } finally {
      audioSource = null
      releaseSessions()
      modelLoaded = false
    }
  }

  fun getStatus(): Map<String, Any?> {
    return mapOf(
      "running" to running.get(),
      "modelLoaded" to modelLoaded,
      "sampleRate" to sampleRate,
      "frameMs" to frameMs,
      "lastScore" to lastScore,
      "error" to lastError,
    )
  }

  private fun parseConfig(config: Map<String, Any?>): WakeWordConfig {
    val modelPaths = config["modelPaths"] as? Map<*, *>
      ?: throw WakeWordException("JAI_WAKE_MODEL_PATHS_REQUIRED", "start(config) requires modelPaths.")
    val wakeModelPath = (modelPaths["wakeModel"] as? String)?.trim().orEmpty()
    if (wakeModelPath.isEmpty()) {
      throw WakeWordException("JAI_WAKE_MODEL_REQUIRED", "modelPaths.wakeModel is required.")
    }
    return WakeWordConfig(
      phraseKey = (config["phraseKey"] as? String)?.trim().orEmpty(),
      wakePhrase = (config["wakePhrase"] as? String)?.trim().orEmpty(),
      wakeModelPath = wakeModelPath,
      melspectrogramModelPath = (modelPaths["melspectrogramModel"] as? String)?.trim()?.ifEmpty { null },
      embeddingModelPath = (modelPaths["embeddingModel"] as? String)?.trim()?.ifEmpty { null },
      threshold = (config["threshold"] as? Number)?.toDouble() ?: 0.5,
      sampleRate = (config["sampleRate"] as? Number)?.toInt() ?: 16000,
      frameMs = (config["frameMs"] as? Number)?.toInt() ?: 80,
      minWakeIntervalMs = (config["minWakeIntervalMs"] as? Number)?.toLong() ?: 1800L,
    )
  }

  private fun resolveFilePath(value: String, label: String): File {
    val raw = value.trim()
    val path = when {
      raw.startsWith("file://", ignoreCase = true) -> Uri.parse(raw).path.orEmpty()
      raw.startsWith("/") -> raw
      else -> throw WakeWordException(
        "JAI_WAKE_MODEL_PATH_INVALID",
        "$label must be a file:// URI or absolute local path.",
      )
    }
    val file = File(path)
    if (!file.exists() || !file.isFile || file.length() <= 0L) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_NOT_FOUND",
        "$label does not point to a readable non-empty model file.",
      )
    }
    if (file.extension.lowercase(Locale.US) != "onnx") {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "$label must be an ONNX model file.",
      )
    }
    return file
  }

  private fun buildPipelineDiagnostic(): String {
    fun describe(session: OrtSession?, label: String): String {
      if (session == null) return "$label=missing"
      val inputs = session.inputInfo.keys.joinToString(",")
      val outputs = session.outputInfo.keys.joinToString(",")
      return "$label(inputs=[$inputs], outputs=[$outputs])"
    }
    return listOf(
      describe(melSession, "melspectrogram"),
      describe(embeddingSession, "embedding"),
      describe(wakeSession, "wake"),
    ).joinToString("; ")
  }

  private fun releaseSessions() {
    try {
      wakeSession?.close()
    } catch (_: Throwable) {
    }
    try {
      melSession?.close()
    } catch (_: Throwable) {
    }
    try {
      embeddingSession?.close()
    } catch (_: Throwable) {
    }
    wakeSession = null
    melSession = null
    embeddingSession = null
  }
}
