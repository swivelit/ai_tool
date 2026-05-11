import ExpoModulesCore
import CryptoKit
import Foundation

/**
 Expo Modules bridge consumed by mobile/lib/nativeOnDeviceModelBridge.ts.

 The iOS bridge validates local GGUF asset presence and exposes the same
 initialize/completeChat/embedTexts contract. It intentionally throws until a
 llama.cpp Swift/C++ binding is linked, so production never pretends on-device
 Gemma/Qwen inference is working and never calls backend/OpenAI.
 */
public class JaiOnDeviceModelModule: Module {
  private var backend = "llama_cpp"
  private var modelRoot = "asset://models"
  private var models: [String: [String: Any]] = [:]

  public func definition() -> ModuleDefinition {
    Name("JaiOnDeviceModel")

    Function("isAvailable") {
      return true
    }

    Function("isSpeechToTextAvailable") {
      return false
    }

    AsyncFunction("initialize") { (config: [String: Any]) -> [String: Any] in
      self.backend = (config["backend"] as? String) ?? "llama_cpp"
      self.modelRoot = (config["modelRoot"] as? String) ?? "asset://models"
      guard self.backend.lowercased() == "llama_cpp" else {
        throw JaiOnDeviceModelError("JAI_UNSUPPORTED_NATIVE_BACKEND", "JaiOnDeviceModel only supports backend=llama_cpp in this scaffold. Requested backend=\(self.backend).")
      }
      guard let rawModels = config["models"] as? [String: [String: Any]] else {
        throw JaiOnDeviceModelError("JAI_NATIVE_MODELS_MISSING", "JaiOnDeviceModel.initialize(config) requires a models map with local GGUF model assets.")
      }
      if !self.models.isEmpty && self.modelCacheSignature(self.models) != self.modelCacheSignature(rawModels) {
        JaiLlamaCppBinding.releaseCachedModels()
      }
      self.models = rawModels

      if self.models.isEmpty {
        throw JaiOnDeviceModelError("JAI_NATIVE_MODELS_MISSING", "JaiOnDeviceModel config has no selected local model entries. The JS runtime should pass only installed models for the selected Lite/Standard/Pro tier.")
      }

      for (modelId, asset) in self.models {
        _ = try self.resolveModelFile(modelId: modelId, asset: asset)
      }

      return [
        "ok": true,
        "backend": self.backend,
        "modelRoot": self.modelRoot,
        "models": Array(self.models.keys).sorted(),
      ]
    }

    AsyncFunction("completeChat") { (input: [String: Any]) -> [String: Any] in
      guard let modelId = input["model"] as? String else {
        throw JaiOnDeviceModelError("JAI_MODEL_REQUIRED", "completeChat(input) requires input.model.")
      }
      let asset = try self.asset(from: input, modelId: modelId)
      let modelPath = try self.resolveModelFile(modelId: modelId, asset: asset).path
      let messages = (input["messages"] as? [[String: Any]]) ?? []
      let prompt = (input["prompt"] as? String) ?? self.buildPrompt(messages: messages, asset: asset)
      let temperature = (input["temperature"] as? Double) ?? 0.2
      let maxTokens = (input["maxTokens"] as? Int) ?? (input["max_tokens"] as? Int) ?? 768
      let contextSize = (asset["contextSize"] as? Int) ?? 4096
      let threads = (asset["threads"] as? Int) ?? min(ProcessInfo.processInfo.processorCount, 6)

      let text = try JaiLlamaCppBinding.completeChat(
        modelPath: modelPath,
        prompt: prompt,
        contextSize: contextSize,
        threads: threads,
        temperature: temperature,
        maxTokens: maxTokens
      )

      return [
        "text": text,
        "model": modelId,
        "runtime": "native_on_device",
        "backend": self.backend,
      ]
    }

    AsyncFunction("embedTexts") { (input: [String: Any]) -> [String: Any] in
      guard let modelId = input["model"] as? String else {
        throw JaiOnDeviceModelError("JAI_MODEL_REQUIRED", "embedTexts(input) requires input.model.")
      }
      let asset = try self.asset(from: input, modelId: modelId)
      let modelPath = try self.resolveModelFile(modelId: modelId, asset: asset).path
      let texts = (input["texts"] as? [String]) ?? []
      let contextSize = (asset["contextSize"] as? Int) ?? 4096
      let threads = (asset["threads"] as? Int) ?? min(ProcessInfo.processInfo.processorCount, 6)
      let data = try texts.enumerated().map { index, text in
        [
          "index": index,
          "embedding": try JaiLlamaCppBinding.embedText(
            modelPath: modelPath,
            text: text,
            contextSize: contextSize,
            threads: threads
          ).map { Double($0) },
        ] as [String: Any]
      }
      return [
        "data": data,
        "model": modelId,
        "runtime": "native_on_device",
        "backend": self.backend,
      ]
    }

    AsyncFunction("transcribeAudio") { (input: [String: Any]) -> [String: Any] in
      let fileUri = ((input["fileUri"] as? String) ?? (input["uri"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !fileUri.isEmpty else {
        throw JaiOnDeviceModelError("JAI_STT_AUDIO_FILE_REQUIRED", "transcribeAudio(input) requires input.fileUri for recorded voice.")
      }
      let model = ((input["model"] as? String) ?? "whisper").trimmingCharacters(in: .whitespacesAndNewlines)
      let language = ((input["language"] as? String) ?? "auto").trimmingCharacters(in: .whitespacesAndNewlines)
      throw JaiOnDeviceModelError(
        "JAI_NATIVE_STT_NOT_IMPLEMENTED",
        "Recorded voice reached JaiOnDeviceModel.transcribeAudio(fileUri=\(fileUri), model=\(model.isEmpty ? "whisper" : model), language=\(language.isEmpty ? "auto" : language)), but no native phone-local STT backend is linked yet. Add a whisper.cpp-backed STT binding or use runtime.mode=local_adapter with a configured phone-local /audio/transcriptions endpoint for development. This native_on_device path never calls backend/OpenAI automatically."
      )
    }

    AsyncFunction("sha256File") { (input: [String: Any]) -> [String: Any] in
      let fileUri = ((input["fileUri"] as? String) ?? (input["uri"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !fileUri.isEmpty else {
        throw JaiOnDeviceModelError("JAI_SHA256_FILE_REQUIRED", "sha256File(input) requires input.fileUri with a file:// URI or absolute local path.")
      }
      return ["sha256": try self.sha256File(fileUri: fileUri)]
    }

    AsyncFunction("getDeviceCapabilities") { () -> [String: Any] in
      return self.deviceCapabilities()
    }
  }

  private func deviceCapabilities() -> [String: Any] {
    let processInfo = ProcessInfo.processInfo
    return [
      "totalMemoryBytes": NSNumber(value: processInfo.physicalMemory),
      "freeStorageBytes": NSNumber(value: self.freeDiskCapacityBytes()),
      "thermalState": self.thermalStateLabel(processInfo.thermalState),
      "lowPowerMode": processInfo.isLowPowerModeEnabled,
      "cpuCoreCount": processInfo.processorCount,
    ]
  }

  private func freeDiskCapacityBytes() -> Int64 {
    let fileManager = FileManager.default
    let url = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory())

    if #available(iOS 11.0, *) {
      if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
         let capacity = values.volumeAvailableCapacityForImportantUsage {
        return Int64(capacity)
      }
    }

    let attributes = try? fileManager.attributesOfFileSystem(forPath: url.path)
    if let freeSize = attributes?[.systemFreeSize] as? NSNumber {
      return freeSize.int64Value
    }
    return 0
  }

  private func thermalStateLabel(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal:
      return "nominal"
    case .fair:
      return "fair"
    case .serious:
      return "serious"
    case .critical:
      return "critical"
    @unknown default:
      return "unknown"
    }
  }

  private func asset(from input: [String: Any], modelId: String) throws -> [String: Any] {
    if let inlineAsset = input["asset"] as? [String: Any] {
      return inlineAsset
    }
    guard let configured = models[modelId] else {
      throw JaiOnDeviceModelError("JAI_MODEL_NOT_CONFIGURED", "No native GGUF asset is configured for model \(modelId).")
    }
    return configured
  }

  private func modelCacheSignature(_ value: [String: [String: Any]]) -> String {
    return value
      .map { modelId, asset in
        "\(modelId):\(((asset["modelPath"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))"
      }
      .sorted()
      .joined(separator: "|")
  }

  private func resolveModelFile(modelId: String, asset: [String: Any]) throws -> URL {
    let rawPath = (asset["modelPath"] as? String) ?? (asset["fileName"] as? String)
    guard let path = rawPath, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw JaiOnDeviceModelError("JAI_MODEL_PATH_MISSING", "Model \(modelId) does not define modelPath/fileName in mobile/data/config/models.json.")
    }

    if path.hasPrefix("/") || path.hasPrefix("file://") {
      let url = URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
      guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
            let size = attributes[.size] as? NSNumber,
            size.int64Value > 0 else {
        throw missingModel(modelId: modelId, path: path)
      }
      return url
    }

    let fileName = ((asset["fileName"] as? String) ?? URL(fileURLWithPath: path).lastPathComponent)
      .replacingOccurrences(of: "asset://", with: "")
      .split(separator: "/")
      .last
      .map(String.init) ?? path
    let resourceName = fileName.replacingOccurrences(of: ".gguf", with: "")
    guard let url = Bundle.main.url(forResource: resourceName, withExtension: "gguf") else {
      throw missingModel(modelId: modelId, path: "asset://models/\(fileName)")
    }
    return url
  }

  private func missingModel(modelId: String, path: String) -> JaiOnDeviceModelError {
    return JaiOnDeviceModelError(
      "JAI_MODEL_FILE_MISSING",
      "Missing local GGUF model file for \(modelId) at \(path). In production, let the app download required GGUF files into app-private storage and pass file:// paths through modelDelivery=download_on_first_launch. For optional bundled_assets development builds, place files in mobile/models/ before prebuild. Production native_on_device mode does not fall back to backend/OpenAI or hash embeddings for this error."
    )
  }

  private func resolveLocalFileForSha256(fileUri: String) throws -> URL {
    let path = fileUri.trimmingCharacters(in: .whitespacesAndNewlines)
    let url: URL

    if path.hasPrefix("file://") {
      guard let parsed = URL(string: path), parsed.isFileURL else {
        throw JaiOnDeviceModelError("JAI_SHA256_FILE_PATH_INVALID", "sha256File(input) only accepts file:// URIs or absolute local file paths. Received: \(path).")
      }
      url = parsed
    } else if path.hasPrefix("/") {
      url = URL(fileURLWithPath: path)
    } else {
      throw JaiOnDeviceModelError("JAI_SHA256_FILE_PATH_INVALID", "sha256File(input) only accepts file:// URIs or absolute local file paths. Received: \(path).")
    }

    var isDirectory = ObjCBool(false)
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
      throw JaiOnDeviceModelError("JAI_SHA256_FILE_MISSING", "Cannot compute SHA-256 because the local file does not exist: \(url.path).")
    }
    guard !isDirectory.boolValue else {
      throw JaiOnDeviceModelError("JAI_SHA256_FILE_NOT_FILE", "Cannot compute SHA-256 because the path is not a regular file: \(url.path).")
    }

    return url
  }

  private func sha256File(fileUri: String) throws -> String {
    let url = try resolveLocalFileForSha256(fileUri: fileUri)
    let handle = try FileHandle(forReadingFrom: url)
    defer {
      try? handle.close()
    }

    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if data.isEmpty {
        break
      }
      hasher.update(data: data)
    }

    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func buildPrompt(messages: [[String: Any]], asset: [String: Any]) -> String {
    switch promptTemplate(asset: asset) {
    case "qwen3": return buildQwenPrompt(messages: messages)
    case "gemma3": return buildGemmaPrompt(messages: messages)
    default: return buildGenericPrompt(messages: messages)
    }
  }

  private func promptTemplate(asset: [String: Any]) -> String {
    let configured = (((asset["chatTemplate"] as? String) ?? (asset["promptFormat"] as? String)) ?? "")
      .lowercased()
      .replacingOccurrences(of: #"[_\s-]+"#, with: "", options: .regularExpression)
    if ["qwen", "qwen3", "chatml"].contains(configured) {
      return "qwen3"
    }
    if ["gemma", "gemma3"].contains(configured) {
      return "gemma3"
    }

    let modelId = ((asset["id"] as? String) ?? "").lowercased()
    if modelId.contains("qwen") {
      return "qwen3"
    }
    if modelId.contains("gemma") {
      return "gemma3"
    }
    return "generic"
  }

  private func roleOf(message: [String: Any]) -> String {
    let role = ((message["role"] as? String) ?? "user").lowercased()
    return role == "system" || role == "assistant" ? role : "user"
  }

  private func cleanContent(message: [String: Any]) -> String {
    return ((message["content"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func buildQwenPrompt(messages: [[String: Any]]) -> String {
    let turns = messages.compactMap { message -> String? in
      let content = cleanContent(message: message)
      if content.isEmpty { return nil }
      return "<|im_start|>\(roleOf(message: message))\n\(content)\n<|im_end|>"
    }
    return turns.joined(separator: "\n") + "\n<|im_start|>assistant\n"
  }

  private func buildGemmaPrompt(messages: [[String: Any]]) -> String {
    let system = messages
      .filter { roleOf(message: $0) == "system" }
      .map { cleanContent(message: $0) }
      .filter { !$0.isEmpty }
      .joined(separator: "\n\n")
    var turns: [String] = []
    if !system.isEmpty {
      turns.append("<start_of_turn>user\nSystem instructions:\n\(system)<end_of_turn>")
    }
    for message in messages {
      let role = roleOf(message: message)
      if role == "system" { continue }
      let content = cleanContent(message: message)
      if content.isEmpty { continue }
      turns.append("<start_of_turn>\(role == "assistant" ? "model" : "user")\n\(content)<end_of_turn>")
    }
    return turns.joined(separator: "\n") + "\n<start_of_turn>model\n"
  }

  private func buildGenericPrompt(messages: [[String: Any]]) -> String {
    let lines = messages.compactMap { message -> String? in
      let content = cleanContent(message: message)
      if content.isEmpty { return nil }
      switch roleOf(message: message) {
      case "system": return "<|system|>\n\(content)"
      case "assistant": return "<|assistant|>\n\(content)"
      default: return "<|user|>\n\(content)"
      }
    }
    return lines.joined(separator: "\n") + "\n<|assistant|>\n"
  }
}

private struct JaiOnDeviceModelError: LocalizedError {
  let code: String
  let detail: String

  init(_ code: String, _ detail: String) {
    self.code = code
    self.detail = detail
  }

  var errorDescription: String? {
    return "JaiOnDeviceModel error [\(code)]: \(detail)"
  }
}

private enum JaiLlamaCppBinding {
  static func releaseCachedModels() {
    JaiLlamaCppBridge.releaseCachedModels()
  }

  static func completeChat(
    modelPath: String,
    prompt: String,
    contextSize: Int,
    threads: Int,
    temperature: Double,
    maxTokens: Int
  ) throws -> String {
    var error: NSError?
    if let text = JaiLlamaCppBridge.completeChat(
      withModelPath: modelPath,
      prompt: prompt,
      contextSize: contextSize,
      threads: threads,
      temperature: temperature,
      maxTokens: maxTokens,
      error: &error
    ) {
      return text
    }
    throw error ?? JaiOnDeviceModelError(
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JaiOnDeviceModel found the Swift bridge and local model path \(modelPath), but the llama.cpp iOS binding returned no text and no NSError."
    )
  }

  static func embedText(
    modelPath: String,
    text: String,
    contextSize: Int,
    threads: Int
  ) throws -> [Float] {
    var error: NSError?
    if let embedding = JaiLlamaCppBridge.embedText(
      withModelPath: modelPath,
      text: text,
      contextSize: contextSize,
      threads: threads,
      error: &error
    ) as? [NSNumber] {
      return embedding.map { $0.floatValue }
    }
    throw error ?? JaiOnDeviceModelError(
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JaiOnDeviceModel found the Swift bridge and local model path \(modelPath), but the llama.cpp iOS embedding binding returned no vector and no NSError."
    )
  }
}
