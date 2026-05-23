package com.harishajahan.jai.wakeword

import android.net.Uri
import ai.onnxruntime.NodeInfo
import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.io.File
import java.nio.FloatBuffer
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

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

private data class TensorInput(
  val name: String,
  val shape: LongArray,
  val role: String,
)

class OpenWakeWordEngine {
  private val running = AtomicBoolean(false)
  private var modelLoaded = false
  private var sampleRate = 16000
  private var frameMs = 80
  private var lastScore: Double? = null
  private var lastError: String? = null
  private var lastWakeAtMs = 0L
  private var lastScoreEventAtMs = 0L
  private var audioSource: PcmAudioSource? = null
  private var pipeline: WakeWordPipeline? = null

  fun isAvailable(): Boolean {
    return try {
      OrtEnvironment.getEnvironment()
      true
    } catch (error: Throwable) {
      lastError = "ONNX Runtime Android is unavailable: ${error.message ?: "unknown error"}"
      false
    }
  }

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
    lastWakeAtMs = 0L
    lastScoreEventAtMs = 0L

    if (parsed.sampleRate != 16000) {
      throw WakeWordException(
        "JAI_WAKE_SAMPLE_RATE_UNSUPPORTED",
        "OpenWakeWord wake detection requires 16 kHz PCM audio.",
      )
    }

    val wakeModel = resolveFilePath(parsed.wakeModelPath, "wakeModel")
    val melModel = parsed.melspectrogramModelPath?.let {
      resolveFilePath(it, "melspectrogramModel")
    } ?: throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "Wake model bundle is missing melspectrogram.onnx.",
    )
    val embeddingModel = parsed.embeddingModelPath?.let {
      resolveFilePath(it, "embeddingModel")
    } ?: throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "Wake model bundle is missing embedding_model.onnx.",
    )

    val nextPipeline = try {
      OnnxWakeWordPipeline(
        wakeModel = wakeModel,
        melModel = melModel,
        embeddingModel = embeddingModel,
        phraseKey = parsed.phraseKey.ifBlank { null },
        sampleRate = parsed.sampleRate,
        frameMs = parsed.frameMs,
      )
    } catch (error: WakeWordException) {
      lastError = error.detail
      throw error
    } catch (error: OrtException) {
      val detail = "Could not load OpenWakeWord ONNX models: ${error.message ?: "unknown ONNX error"}"
      lastError = detail
      throw WakeWordException("JAI_WAKE_MODEL_LOAD_FAILED", detail, error)
    }

    pipeline = nextPipeline
    modelLoaded = true
    running.set(true)

    val nextAudioSource = PcmAudioSource(parsed.sampleRate, parsed.frameMs)
    audioSource = nextAudioSource
    try {
      nextAudioSource.start { frame ->
        if (!running.get()) return@start
        try {
          val score = nextPipeline.processFrame(frame) ?: return@start
          lastScore = score
          val now = System.currentTimeMillis()
          val event = WakeWordEvent(
            score = score,
            model = nextPipeline.modelName,
            phraseKey = parsed.phraseKey.ifBlank { null },
            timestamp = now,
          )
          if (now - lastScoreEventAtMs >= 1000L) {
            lastScoreEventAtMs = now
            onScore(event)
          }
          if (score >= parsed.threshold && now - lastWakeAtMs >= parsed.minWakeIntervalMs) {
            lastWakeAtMs = now
            onWake(event)
          }
        } catch (error: WakeWordException) {
          lastError = error.detail
          onError(error.code, error.detail)
          stop()
        } catch (error: Throwable) {
          val detail = "Wake-word inference failed: ${error.message ?: "unknown error"}"
          lastError = detail
          onError("JAI_WAKE_INFERENCE_FAILED", detail)
          stop()
        }
      }
    } catch (error: Throwable) {
      stop()
      val detail = "Could not start wake-word audio capture: ${error.message ?: "unknown error"}"
      lastError = detail
      throw WakeWordException("JAI_WAKE_AUDIO_START_FAILED", detail, error)
    }
  }

  @Synchronized
  fun stop() {
    running.set(false)
    try {
      audioSource?.stop()
    } finally {
      audioSource = null
    }
    try {
      pipeline?.close()
    } finally {
      pipeline = null
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

  fun validateFixturePipeline(): Map<String, Any?> {
    val fixture = DeterministicWakeWordPipeline(
      modelName = "fixture-wake.onnx",
      phraseKey = "fixture-phrase",
      acceptedFrameSamples = 1280,
      scores = listOf(0.12, 0.93),
    )
    var processFrameRan = false
    var wakeEmitted = false
    var maxScore = 0.0

    fixture.use { pipeline ->
      repeat(2) {
        val score = pipeline.processFrame(ShortArray(1280) { index -> (index % 127).toShort() })
        if (score != null) {
          processFrameRan = true
          maxScore = max(maxScore, score)
          if (score >= 0.5) {
            wakeEmitted = true
          }
        }
      }
    }

    return mapOf(
      "ok" to true,
      "modelFilesLoaded" to fixture.modelFilesLoaded,
      "shapesAccepted" to fixture.shapesAccepted,
      "processFrameRan" to processFrameRan,
      "wakeEmitted" to wakeEmitted,
      "score" to maxScore,
      "model" to fixture.modelName,
      "phraseKey" to fixture.phraseKey,
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
}

private interface WakeWordPipeline : AutoCloseable {
  val modelName: String
  val phraseKey: String?
  fun processFrame(frame: ShortArray): Double?
}

private class DeterministicWakeWordPipeline(
  override val modelName: String,
  override val phraseKey: String?,
  private val acceptedFrameSamples: Int,
  private val scores: List<Double>,
) : WakeWordPipeline {
  var modelFilesLoaded = false
    private set
  var shapesAccepted = false
    private set
  private var frameCount = 0

  init {
    modelFilesLoaded = modelName.endsWith(".onnx")
    shapesAccepted = acceptedFrameSamples > 0 && scores.isNotEmpty()
  }

  override fun processFrame(frame: ShortArray): Double? {
    if (!modelFilesLoaded || !shapesAccepted) {
      throw WakeWordException(
        "JAI_WAKE_FIXTURE_INVALID",
        "Deterministic wake fixture is not configured correctly.",
      )
    }
    if (frame.size != acceptedFrameSamples) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "Fixture expected $acceptedFrameSamples samples but received ${frame.size}.",
      )
    }
    val score = scores[min(frameCount, scores.lastIndex)]
    frameCount += 1
    return score
  }

  override fun close() {
    // No native resources in the deterministic validation seam.
  }
}

private class OnnxWakeWordPipeline(
  wakeModel: File,
  melModel: File,
  embeddingModel: File,
  override val phraseKey: String?,
  sampleRate: Int,
  frameMs: Int,
) : WakeWordPipeline {
  override val modelName = wakeModel.name
  private val env = OrtEnvironment.getEnvironment()
  private val sessionOptions = OrtSession.SessionOptions()
  private val melSession = env.createSession(melModel.absolutePath, sessionOptions)
  private val embeddingSession = env.createSession(embeddingModel.absolutePath, sessionOptions)
  private val wakeSession = env.createSession(wakeModel.absolutePath, sessionOptions)
  private val melInput = firstFloatInput(melSession, "melspectrogram")
  private val embeddingInput = firstFloatInput(embeddingSession, "embedding")
  private val wakeInput = firstFloatInput(wakeSession, "wake")
  private val audioWindowSamples = melInput.expectedElementCount(
    defaultValue = sampleRate * frameMs / 1000,
    role = "melspectrogram audio",
  ).coerceAtLeast(1)
  private val rawAudio = WakeWordRingBuffer(audioWindowSamples)
  private val melHistory = FloatRingBuffer(
    embeddingInput.expectedElementCount(
      defaultValue = 76 * 32,
      role = "embedding mel history",
    ).coerceAtLeast(1),
  )
  private val wakeInputElements = wakeInput.expectedElementCount(
    defaultValue = 16 * 96,
    role = "wake embedding history",
  ).coerceAtLeast(1)
  private val embeddingWidth = wakeInput.featureWidth(defaultValue = 96).coerceAtLeast(1)
  private val embeddingSteps = max(1, wakeInputElements / embeddingWidth)
  private val embeddingHistory = ArrayDeque<FloatArray>()

  override fun processFrame(frame: ShortArray): Double? {
    rawAudio.append(frame)
    val audio = rawAudio.snapshot()
    if (audio.size < audioWindowSamples) return null

    val offset = audio.size - audioWindowSamples
    val pcm = FloatArray(audioWindowSamples) { index ->
      audio[offset + index].toFloat() / 32768.0f
    }
    val melFeatures = runFloatModel(melSession, melInput, pcm)
    melHistory.append(melFeatures)
    val melWindow = melHistory.snapshotOrNull() ?: return null

    val embedding = runFloatModel(embeddingSession, embeddingInput, melWindow)
    if (embedding.size < embeddingWidth) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "Embedding model returned ${embedding.size} values; wake model expects at least $embeddingWidth.",
      )
    }
    embeddingHistory.addLast(embedding.takeLastValues(embeddingWidth))
    while (embeddingHistory.size > embeddingSteps) {
      embeddingHistory.removeFirst()
    }
    if (embeddingHistory.size < embeddingSteps) return null

    val wakeFeatures = FloatArray(wakeInputElements)
    var cursor = 0
    embeddingHistory.forEach { vector ->
      val copyLength = min(vector.size, embeddingWidth)
      System.arraycopy(vector, 0, wakeFeatures, cursor, copyLength)
      cursor += embeddingWidth
    }

    val scores = runFloatModel(wakeSession, wakeInput, wakeFeatures)
    if (scores.isEmpty()) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "Wake model produced no score for ${phraseKey ?: "wake phrase"}.",
      )
    }
    return scores.maxOrNull()?.toDouble()
  }

  private fun firstFloatInput(session: OrtSession, role: String): TensorInput {
    val entry = session.inputInfo.entries.firstOrNull()
      ?: throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "$role model has no inputs.",
      )
    val tensorInfo = entry.value.tensorInfoOrNull()
      ?: throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "$role model input '${entry.key}' is not a tensor.",
      )
    if (tensorInfo.type != OnnxJavaType.FLOAT) {
      throw WakeWordException(
        "JAI_WAKE_MODEL_UNSUPPORTED",
        "$role model input '${entry.key}' must be float32, got ${tensorInfo.type}.",
      )
    }
    return TensorInput(entry.key, tensorInfo.shape ?: longArrayOf(), role)
  }

  private fun runFloatModel(session: OrtSession, input: TensorInput, values: FloatArray): FloatArray {
    val shape = input.resolveShape(values.size)
    OnnxTensor.createTensor(env, FloatBuffer.wrap(values), shape).use { tensor ->
      session.run(mapOf(input.name to tensor)).use { result ->
        val first = result.iterator().asSequence().firstOrNull()?.value
          ?: throw WakeWordException(
            "JAI_WAKE_MODEL_UNSUPPORTED",
            "${input.role} model produced no outputs.",
          )
        return flattenFloatOutput(first.value)
      }
    }
  }

  override fun close() {
    try {
      wakeSession.close()
    } catch (_: Throwable) {
    }
    try {
      embeddingSession.close()
    } catch (_: Throwable) {
    }
    try {
      melSession.close()
    } catch (_: Throwable) {
    }
    try {
      sessionOptions.close()
    } catch (_: Throwable) {
    }
  }
}

private class FloatRingBuffer(private val capacity: Int) {
  private val buffer = FloatArray(capacity.coerceAtLeast(1))
  private var writeIndex = 0
  private var filled = 0

  @Synchronized
  fun append(values: FloatArray) {
    for (value in values) {
      buffer[writeIndex] = value
      writeIndex = (writeIndex + 1) % buffer.size
      filled = min(filled + 1, buffer.size)
    }
  }

  @Synchronized
  fun snapshotOrNull(): FloatArray? {
    if (filled < buffer.size) return null
    val out = FloatArray(buffer.size)
    for (index in out.indices) {
      out[index] = buffer[(writeIndex + index) % buffer.size]
    }
    return out
  }
}

private fun NodeInfo.tensorInfoOrNull(): TensorInfo? = info as? TensorInfo

private fun TensorInput.expectedElementCount(defaultValue: Int, role: String): Int {
  val dims = nonBatchShape()
  if (dims.isEmpty()) return defaultValue
  if (dims.any { it <= 0L }) return defaultValue
  val product = dims.fold(1L) { acc, dim -> acc * dim }
  if (product <= 0L || product > Int.MAX_VALUE) {
    throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "$role input shape ${shape.joinToString(prefix = "[", postfix = "]")} is unsupported.",
    )
  }
  return product.toInt()
}

private fun TensorInput.featureWidth(defaultValue: Int): Int {
  val dims = nonBatchShape().filter { it > 0L }
  return dims.lastOrNull()?.takeIf { it <= Int.MAX_VALUE }?.toInt() ?: defaultValue
}

private fun TensorInput.nonBatchShape(): List<Long> {
  val dims = shape.filter { it != 0L }
  return if (dims.size > 1 && dims.first() == 1L) dims.drop(1) else dims
}

private fun TensorInput.resolveShape(valueCount: Int): LongArray {
  val raw = if (shape.isEmpty()) longArrayOf(1L, valueCount.toLong()) else shape.copyOf()
  val dynamicIndexes = raw.indices.filter { raw[it] <= 0L }
  if (dynamicIndexes.isEmpty()) {
    val product = raw.fold(1L) { acc, dim -> acc * dim }
    if (product == valueCount.toLong()) return raw
    throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "$role model input '${name}' expects shape ${raw.joinToString(prefix = "[", postfix = "]")} but received $valueCount values.",
    )
  }

  var knownProduct = 1L
  raw.forEachIndexed { index, dim ->
    if (dim > 0L) knownProduct *= dim
    if (dim <= 0L && index == 0) raw[index] = 1L
  }
  val remainingDynamic = raw.indices.filter { raw[it] <= 0L }
  if (remainingDynamic.size > 1 || knownProduct <= 0L || valueCount % knownProduct.toInt() != 0) {
    throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "$role model input '${name}' has unsupported dynamic shape ${shape.joinToString(prefix = "[", postfix = "]")}.",
    )
  }
  if (remainingDynamic.size == 1) {
    raw[remainingDynamic.first()] = valueCount / knownProduct
  }
  val product = raw.fold(1L) { acc, dim -> acc * dim }
  if (product != valueCount.toLong()) {
    throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "$role model input '${name}' resolved to ${raw.joinToString(prefix = "[", postfix = "]")} but received $valueCount values.",
    )
  }
  return raw
}

private fun flattenFloatOutput(value: Any?): FloatArray {
  return when (value) {
    null -> FloatArray(0)
    is FloatArray -> value
    is DoubleArray -> FloatArray(value.size) { value[it].toFloat() }
    is IntArray -> FloatArray(value.size) { value[it].toFloat() }
    is LongArray -> FloatArray(value.size) { value[it].toFloat() }
    is Number -> floatArrayOf(value.toFloat())
    is Array<*> -> {
      val parts = value.map { flattenFloatOutput(it) }
      val total = parts.sumOf { it.size }
      val out = FloatArray(total)
      var cursor = 0
      parts.forEach { part ->
        System.arraycopy(part, 0, out, cursor, part.size)
        cursor += part.size
      }
      out
    }
    else -> throw WakeWordException(
      "JAI_WAKE_MODEL_UNSUPPORTED",
      "OpenWakeWord model produced unsupported output type ${value.javaClass.name}.",
    )
  }
}

private fun FloatArray.takeLastValues(count: Int): FloatArray {
  if (size == count) return this
  val out = FloatArray(count)
  val copyLength = min(size, count)
  System.arraycopy(this, size - copyLength, out, count - copyLength, copyLength)
  return out
}
