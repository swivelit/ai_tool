package com.harishajahan.jai.ondevice

import android.content.Context
import java.io.File
import java.io.FileNotFoundException
import java.util.Locale

private class CodedException(code: String, detail: String, cause: Throwable? = null) :
  IllegalStateException("JaiOnDeviceModel error [" + code + "]: " + detail, cause)

/**
 * Local-only GGUF model loader for JaiOnDeviceModel.
 *
 * Expected assets are copied by plugins/withJaiOnDeviceModelAssets.js from:
 *   mobile/models/*.gguf
 * into the generated Android project at:
 *   android/app/src/main/assets/models/*.gguf
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

    models.clear()
    val rawModels = config["models"] as? Map<*, *>
      ?: throw CodedException(
        "JAI_NATIVE_MODELS_MISSING",
        "JaiOnDeviceModel.initialize(config) requires a models map with local GGUF model assets.",
        null,
      )

    rawModels.forEach { (key, value) ->
      val modelId = key?.toString()?.trim().orEmpty()
      val asset = value as? Map<*, *> ?: return@forEach
      if (modelId.isNotEmpty()) {
        @Suppress("UNCHECKED_CAST")
        models[modelId] = asset as Map<String, Any?>
      }
    }

    val required = listOf(
      "google/gemma-3-4b-it",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3-14B",
      "Qwen/Qwen3-Embedding-0.6B",
    )
    val missing = required.filter { models[it] == null }
    if (missing.isNotEmpty()) {
      throw CodedException(
        "JAI_REQUIRED_MODELS_MISSING",
        "JaiOnDeviceModel config is missing required local model entries: ${missing.joinToString(", ")}",
        null,
      )
    }

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

  fun completeChat(input: Map<String, Any?>): Map<String, Any?> {
    val modelId = input.stringValue("model")
      ?: throw CodedException("JAI_MODEL_REQUIRED", "completeChat(input) requires input.model.", null)
    val asset = input.assetValue(modelId, models)
    val modelFile = ensureModelFile(modelId, asset)
    val messages = input.messageList("messages")
    val prompt = buildChatPrompt(messages)
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
      "Missing local GGUF model file for $modelId at $path. Download the real model into mobile/models/ with the exact filename from mobile/data/config/models.json, then run `npx expo prebuild --clean` and build a custom dev client. Production native_on_device mode does not fall back to backend/OpenAI or hash embeddings for this error.",
      null,
    )
  }

  private fun buildChatPrompt(messages: List<Map<String, String>>): String {
    return messages.joinToString("\n") { message ->
      val role = message["role"]?.lowercase(Locale.US) ?: "user"
      val content = message["content"] ?: ""
      when (role) {
        "system" -> "<|system|>\n$content"
        "assistant" -> "<|assistant|>\n$content"
        else -> "<|user|>\n$content"
      }
    } + "\n<|assistant|>\n"
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
