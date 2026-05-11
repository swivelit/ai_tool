package com.harishajahan.jai.ondevice

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import java.io.File
import java.io.FileNotFoundException
import java.net.URI
import java.security.MessageDigest
import java.util.Locale

private class CodedException(code: String, detail: String, cause: Throwable? = null) :
  IllegalStateException("JaiOnDeviceModel error [" + code + "]: " + detail, cause)

/**
 * Local-only GGUF model loader for JaiOnDeviceModel.
 *
 * Production model files are normally downloaded by modelDownloadManager.ts into
 * app-private storage and passed as file:// paths. Optional bundled_assets dev
 * builds can still copy GGUF files from mobile/models into android/app/src/main/assets.
 *
 * Production native_on_device mode must fail clearly when a file is missing;
 * it must not call the backend and must not synthesize fake embeddings.
 */
class JaiOnDeviceModelEngine(private val context: Context) {
  private var backend: String = "llama_cpp"
  private var modelRoot: String = "asset://models"
  private val models: MutableMap<String, Map<String, Any?>> = mutableMapOf()

  fun initialize(config: Map<String, Any?>): Map<String, Any?> {
    backend = config.stringValue("backend") ?: "llama_cpp"
    modelRoot = config.stringValue("modelRoot") ?: "asset://models"

    if (!backend.equals("llama_cpp", ignoreCase = true)) {
      throw CodedException(
        "JAI_UNSUPPORTED_NATIVE_BACKEND",
        "JaiOnDeviceModel only supports backend=llama_cpp in this scaffold. Requested backend=$backend.",
        null,
      )
    }

    val rawModels = config["models"] as? Map<*, *>
      ?: throw CodedException(
        "JAI_NATIVE_MODELS_MISSING",
        "JaiOnDeviceModel.initialize(config) requires a models map with local GGUF model assets.",
        null,
      )

    val nextModels: MutableMap<String, Map<String, Any?>> = mutableMapOf()
    rawModels.forEach { (key, value) ->
      val modelId = key?.toString()?.trim().orEmpty()
      val asset = value as? Map<*, *> ?: return@forEach
      if (modelId.isNotEmpty()) {
        @Suppress("UNCHECKED_CAST")
        nextModels[modelId] = asset as Map<String, Any?>
      }
    }

    if (nextModels.isEmpty()) {
      throw CodedException(
        "JAI_NATIVE_MODELS_MISSING",
        "JaiOnDeviceModel config has no selected local model entries. The JS runtime should pass only installed models for the selected Lite/Standard/Pro tier.",
        null,
      )
    }

    if (models.isNotEmpty() && modelCacheSignature(models) != modelCacheSignature(nextModels)) {
      JaiLlamaCppBinding.releaseCachedModels()
    }
    models.clear()
    models.putAll(nextModels)

    // Verify all configured local model files now, so production failures are clear.
    models.forEach { (modelId, asset) ->
      ensureModelFile(modelId, asset)
    }

    return mapOf(
      "ok" to true,
      "backend" to backend,
      "modelRoot" to modelRoot,
      "models" to models.keys.sorted(),
    )
  }

  private fun modelCacheSignature(value: Map<String, Map<String, Any?>>): String {
    return value.entries
      .map { (modelId, asset) -> modelId + ":" + (asset["modelPath"]?.toString()?.trim().orEmpty()) }
      .sorted()
      .joinToString("|")
  }

  fun completeChat(input: Map<String, Any?>): Map<String, Any?> {
    val modelId = input.stringValue("model")
      ?: throw CodedException("JAI_MODEL_REQUIRED", "completeChat(input) requires input.model.", null)
    val asset = input.assetValue(modelId, models)
    val modelFile = ensureModelFile(modelId, asset)
    val messages = input.messageList("messages")
    val prompt = input.stringValue("prompt") ?: buildChatPrompt(messages, asset)
    val temperature = input.doubleValue("temperature") ?: 0.2
    val maxTokens = input.intValue("maxTokens") ?: input.intValue("max_tokens") ?: 768

    val text = JaiLlamaCppBinding.completeChat(
      modelPath = modelFile.absolutePath,
      prompt = prompt,
      contextSize = asset.intValue("contextSize") ?: 4096,
      threads = asset.intValue("threads") ?: Runtime.getRuntime().availableProcessors().coerceAtMost(6),
      temperature = temperature,
      maxTokens = maxTokens,
    )

    return mapOf(
      "text" to text,
      "model" to modelId,
      "runtime" to "native_on_device",
      "backend" to backend,
    )
  }

  fun embedTexts(input: Map<String, Any?>): Map<String, Any?> {
    val modelId = input.stringValue("model")
      ?: throw CodedException("JAI_MODEL_REQUIRED", "embedTexts(input) requires input.model.", null)
    val asset = input.assetValue(modelId, models)
    val modelFile = ensureModelFile(modelId, asset)
    val texts = input.stringList("texts")
    if (texts.isEmpty()) {
      return mapOf("data" to emptyList<Map<String, Any?>>(), "model" to modelId)
    }

    val data = texts.mapIndexed { index, text ->
      mapOf(
        "index" to index,
        "embedding" to JaiLlamaCppBinding.embedText(
          modelPath = modelFile.absolutePath,
          text = text,
          contextSize = asset.intValue("contextSize") ?: 4096,
          threads = asset.intValue("threads") ?: Runtime.getRuntime().availableProcessors().coerceAtMost(6),
        ).map { it.toDouble() },
      )
    }

    return mapOf(
      "data" to data,
      "model" to modelId,
      "runtime" to "native_on_device",
      "backend" to backend,
    )
  }

  fun transcribeAudio(input: Map<String, Any?>): Map<String, Any?> {
    val fileUri = input.stringValue("fileUri")
      ?: input.stringValue("uri")
      ?: throw CodedException(
        "JAI_STT_AUDIO_FILE_REQUIRED",
        "transcribeAudio(input) requires input.fileUri for recorded voice.",
        null,
      )
    val model = input.stringValue("model") ?: "whisper"
    val language = input.stringValue("language") ?: "auto"
    throw CodedException(
      "JAI_NATIVE_STT_NOT_IMPLEMENTED",
      "Recorded voice reached JaiOnDeviceModel.transcribeAudio(fileUri=$fileUri, model=$model, language=$language), but no native phone-local STT backend is linked yet. Add a whisper.cpp-backed STT binding or use runtime.mode=local_adapter with a configured phone-local /audio/transcriptions endpoint for development. This native_on_device path never calls backend/OpenAI automatically.",
      null,
    )
  }

  fun sha256File(input: Map<String, Any?>): Map<String, Any?> {
    val fileUri = input.stringValue("fileUri")
      ?: input.stringValue("uri")
      ?: throw CodedException(
        "JAI_SHA256_FILE_REQUIRED",
        "sha256File(input) requires input.fileUri with a file:// URI or absolute local path.",
        null,
      )
    val file = resolveLocalFileForSha256(fileUri)
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(1024 * 1024)

    file.inputStream().use { inputStream ->
      while (true) {
        val read = inputStream.read(buffer)
        if (read < 0) break
        if (read > 0) digest.update(buffer, 0, read)
      }
    }

    return mapOf(
      "sha256" to digest.digest().joinToString("") { byte ->
        "%02x".format(byte.toInt() and 0xff)
      },
    )
  }

  fun getDeviceCapabilities(): Map<String, Any?> {
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val memoryInfo = ActivityManager.MemoryInfo()
    activityManager?.getMemoryInfo(memoryInfo)

    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
    val batteryLevel = readBatteryLevel(batteryManager)

    return mapOf(
      "totalMemoryBytes" to memoryInfo.totalMem,
      "availableMemoryBytes" to memoryInfo.availMem,
      "freeStorageBytes" to readFreeStorageBytes(),
      "lowMemory" to memoryInfo.lowMemory,
      "lowRamDevice" to (activityManager?.isLowRamDevice ?: false),
      "lowPowerMode" to (powerManager?.isPowerSaveMode ?: false),
      "batteryLevel" to batteryLevel,
      "thermalState" to readThermalState(powerManager),
      "cpuCoreCount" to Runtime.getRuntime().availableProcessors(),
      "supportedAbis" to Build.SUPPORTED_ABIS.toList(),
    )
  }

  private fun readFreeStorageBytes(): Long {
    return try {
      StatFs(context.noBackupFilesDir.absolutePath).availableBytes
    } catch (_: Exception) {
      0L
    }
  }

  private fun readBatteryLevel(batteryManager: BatteryManager?): Double? {
    val capacity = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    } else {
      null
    }
    if (capacity != null && capacity >= 0) {
      return capacity.toDouble() / 100.0
    }

    val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?: return null
    val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (level < 0 || scale <= 0) return null
    return level.toDouble() / scale.toDouble()
  }

  private fun readThermalState(powerManager: PowerManager?): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || powerManager == null) {
      return "unknown"
    }
    return when (powerManager.currentThermalStatus) {
      PowerManager.THERMAL_STATUS_NONE -> "nominal"
      PowerManager.THERMAL_STATUS_LIGHT,
      PowerManager.THERMAL_STATUS_MODERATE -> "fair"
      PowerManager.THERMAL_STATUS_SEVERE -> "serious"
      PowerManager.THERMAL_STATUS_CRITICAL,
      PowerManager.THERMAL_STATUS_EMERGENCY,
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
      else -> "unknown"
    }
  }

  private fun ensureModelFile(modelId: String, asset: Map<String, Any?>): File {
    val rawPath = asset.stringValue("modelPath")
      ?: asset.stringValue("fileName")
      ?: throw CodedException(
        "JAI_MODEL_PATH_MISSING",
        "Model $modelId does not define modelPath/fileName in mobile/data/config/models.json.",
        null,
      )

    if (rawPath.startsWith("/") || rawPath.startsWith("file://")) {
      val file = File(rawPath.removePrefix("file://"))
      if (!file.exists() || file.length() <= 0L) {
        throw missingModelException(modelId, rawPath)
      }
      return file
    }

    val assetPath = androidAssetPath(rawPath, asset.stringValue("fileName"))
    val outDir = File(context.noBackupFilesDir, "jai-models")
    if (!outDir.exists()) outDir.mkdirs()
    val outFile = File(outDir, File(assetPath).name)
    if (outFile.exists() && outFile.length() > 0L) {
      return outFile
    }

    try {
      context.assets.open(assetPath).use { input ->
        outFile.outputStream().use { output -> input.copyTo(output) }
      }
    } catch (error: FileNotFoundException) {
      throw missingModelException(modelId, "asset://$assetPath")
    }

    if (!outFile.exists() || outFile.length() <= 0L) {
      throw missingModelException(modelId, "asset://$assetPath")
    }
    return outFile
  }

  private fun androidAssetPath(modelPath: String, fileName: String?): String {
    val normalizedRoot = modelRoot.removePrefix("asset://").trim('/').ifBlank { "models" }
    val normalizedPath = modelPath.removePrefix("asset://").trim('/')
    val resolved = when {
      normalizedPath.startsWith("$normalizedRoot/") -> normalizedPath
      normalizedPath.startsWith("models/") -> normalizedPath
      normalizedPath.endsWith(".gguf", ignoreCase = true) -> "$normalizedRoot/${File(normalizedPath).name}"
      !fileName.isNullOrBlank() -> "$normalizedRoot/$fileName"
      else -> "$normalizedRoot/$normalizedPath"
    }
    return resolved.replace("//", "/")
  }

  private fun missingModelException(modelId: String, path: String): CodedException {
    return CodedException(
      "JAI_MODEL_FILE_MISSING",
      "Missing local GGUF model file for $modelId at $path. In production, let the app download required GGUF files into app-private storage and pass file:// paths through modelDelivery=download_on_first_launch. For optional bundled_assets development builds, place files in mobile/models/ before prebuild. Production native_on_device mode does not fall back to backend/OpenAI or hash embeddings for this error.",
      null,
    )
  }

  private fun resolveLocalFileForSha256(fileUri: String): File {
    val trimmed = fileUri.trim()
    if (trimmed.isEmpty()) {
      throw CodedException(
        "JAI_SHA256_FILE_REQUIRED",
        "sha256File(input) requires a non-empty file:// URI or absolute local path.",
        null,
      )
    }

    val file = when {
      trimmed.startsWith("file://") -> try {
        File(URI(trimmed))
      } catch (_: Exception) {
        File(trimmed.removePrefix("file://"))
      }
      trimmed.startsWith("/") -> File(trimmed)
      else -> throw CodedException(
        "JAI_SHA256_FILE_PATH_INVALID",
        "sha256File(input) only accepts file:// URIs or absolute local file paths. Received: $trimmed",
        null,
      )
    }

    if (!file.exists()) {
      throw CodedException(
        "JAI_SHA256_FILE_MISSING",
        "Cannot compute SHA-256 because the local file does not exist: ${file.absolutePath}",
        null,
      )
    }
    if (!file.isFile) {
      throw CodedException(
        "JAI_SHA256_FILE_NOT_FILE",
        "Cannot compute SHA-256 because the path is not a regular file: ${file.absolutePath}",
        null,
      )
    }

    return file
  }

  private fun buildChatPrompt(messages: List<Map<String, String>>, asset: Map<String, Any?>): String {
    return when (promptTemplate(asset)) {
      "qwen3" -> buildQwenPrompt(messages)
      "gemma3" -> buildGemmaPrompt(messages)
      else -> buildGenericPrompt(messages)
    }
  }

  private fun promptTemplate(asset: Map<String, Any?>): String {
    val explicit = (asset.stringValue("chatTemplate") ?: asset.stringValue("promptFormat") ?: "")
      .lowercase(Locale.US)
      .replace(Regex("[_\\s-]+"), "")
    if (explicit == "qwen" || explicit == "qwen3" || explicit == "chatml") return "qwen3"
    if (explicit == "gemma" || explicit == "gemma3") return "gemma3"

    val modelId = (asset.stringValue("id") ?: "").lowercase(Locale.US)
    if (modelId.contains("qwen")) return "qwen3"
    if (modelId.contains("gemma")) return "gemma3"
    return "generic"
  }

  private fun roleOf(message: Map<String, String>): String {
    val role = message["role"]?.lowercase(Locale.US) ?: "user"
    return when (role) {
      "system", "assistant" -> role
      else -> "user"
    }
  }

  private fun buildQwenPrompt(messages: List<Map<String, String>>): String {
    val turns = messages.mapNotNull { message ->
      val content = (message["content"] ?: "").trim()
      if (content.isEmpty()) null else "<|im_start|>${roleOf(message)}\n$content\n<|im_end|>"
    }
    return turns.joinToString("\n") + "\n<|im_start|>assistant\n"
  }

  private fun buildGemmaPrompt(messages: List<Map<String, String>>): String {
    val system = messages
      .filter { roleOf(it) == "system" }
      .map { (it["content"] ?: "").trim() }
      .filter { it.isNotEmpty() }
      .joinToString("\n\n")
    val turns = mutableListOf<String>()
    if (system.isNotEmpty()) {
      turns.add("<start_of_turn>user\nSystem instructions:\n$system<end_of_turn>")
    }
    messages.forEach { message ->
      val role = roleOf(message)
      if (role == "system") return@forEach
      val content = (message["content"] ?: "").trim()
      if (content.isNotEmpty()) {
        turns.add("<start_of_turn>${if (role == "assistant") "model" else "user"}\n$content<end_of_turn>")
      }
    }
    return turns.joinToString("\n") + "\n<start_of_turn>model\n"
  }

  private fun buildGenericPrompt(messages: List<Map<String, String>>): String {
    val turns = messages.mapNotNull { message ->
      val content = (message["content"] ?: "").trim()
      if (content.isEmpty()) {
        null
      } else {
        when (roleOf(message)) {
          "system" -> "<|system|>\n$content"
          "assistant" -> "<|assistant|>\n$content"
          else -> "<|user|>\n$content"
        }
      }
    }
    return turns.joinToString("\n") + "\n<|assistant|>\n"
  }
}

private fun Map<String, Any?>.assetValue(
  modelId: String,
  models: Map<String, Map<String, Any?>>,
): Map<String, Any?> {
  val inlineAsset = this["asset"] as? Map<*, *>
  if (inlineAsset != null) {
    @Suppress("UNCHECKED_CAST")
    return inlineAsset as Map<String, Any?>
  }
  return models[modelId]
    ?: throw CodedException(
      "JAI_MODEL_NOT_CONFIGURED",
      "No native GGUF asset is configured for model $modelId.",
      null,
    )
}

private fun Map<String, Any?>.stringValue(key: String): String? = this[key]?.toString()?.trim()?.takeIf { it.isNotEmpty() }

private fun Map<String, Any?>.intValue(key: String): Int? = when (val value = this[key]) {
  is Number -> value.toInt()
  is String -> value.toIntOrNull()
  else -> null
}

private fun Map<String, Any?>.doubleValue(key: String): Double? = when (val value = this[key]) {
  is Number -> value.toDouble()
  is String -> value.toDoubleOrNull()
  else -> null
}

private fun Map<String, Any?>.stringList(key: String): List<String> {
  val value = this[key] as? List<*> ?: return emptyList()
  return value.mapNotNull { it?.toString() }
}

private fun Map<String, Any?>.messageList(key: String): List<Map<String, String>> {
  val value = this[key] as? List<*> ?: return emptyList()
  return value.mapNotNull { item ->
    val raw = item as? Map<*, *> ?: return@mapNotNull null
    mapOf(
      "role" to (raw["role"]?.toString() ?: "user"),
      "content" to (raw["content"]?.toString() ?: ""),
    )
  }
}
