import ExpoModulesCore
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

    AsyncFunction("initialize") { (config: [String: Any]) -> [String: Any] in
      self.backend = (config["backend"] as? String) ?? "llama_cpp"
      self.modelRoot = (config["modelRoot"] as? String) ?? "asset://models"
      guard self.backend.lowercased() == "llama_cpp" else {
        throw JaiOnDeviceModelError("JAI_UNSUPPORTED_NATIVE_BACKEND", "JaiOnDeviceModel only supports backend=llama_cpp in this scaffold. Requested backend=\(self.backend).")
      }
      guard let rawModels = config["models"] as? [String: [String: Any]] else {
        throw JaiOnDeviceModelError("JAI_NATIVE_MODELS_MISSING", "JaiOnDeviceModel.initialize(config) requires a models map with local GGUF model assets.")
      }
      self.models = rawModels

      let required = [
        "google/gemma-3-4b-it",
        "Qwen/Qwen3-8B",
        "Qwen/Qwen3-14B",
        "Qwen/Qwen3-Embedding-0.6B",
      ]
      let missing = required.filter { self.models[$0] == nil }
      if !missing.isEmpty {
        throw JaiOnDeviceModelError("JAI_REQUIRED_MODELS_MISSING", "JaiOnDeviceModel config is missing required local model entries: \(missing.joined(separator: ", ")).")
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
      let prompt = self.buildPrompt(messages: messages)
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

  private func resolveModelFile(modelId: String, asset: [String: Any]) throws -> URL {
    let rawPath = (asset["modelPath"] as? String) ?? (asset["fileName"] as? String)
    guard let path = rawPath, !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw JaiOnDeviceModelError("JAI_MODEL_PATH_MISSING", "Model \(modelId) does not define modelPath/fileName in mobile/data/config/models.json.")
    }

    if path.hasPrefix("/") || path.hasPrefix("file://") {
      let url = URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
      guard FileManager.default.fileExists(atPath: url.path) else {
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
      "Missing local GGUF model file for \(modelId) at \(path). Download the real model into mobile/models/ with the exact filename from mobile/data/config/models.json, then run `npx expo prebuild --clean` and build a custom dev client. Production native_on_device mode does not fall back to backend/OpenAI or hash embeddings for this error."
    )
  }

  private func buildPrompt(messages: [[String: Any]]) -> String {
    let lines = messages.map { message -> String in
      let role = ((message["role"] as? String) ?? "user").lowercased()
      let content = (message["content"] as? String) ?? ""
      switch role {
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
  static func completeChat(
    modelPath: String,
    prompt: String,
    contextSize: Int,
    threads: Int,
    temperature: Double,
    maxTokens: Int
  ) throws -> String {
    throw JaiOnDeviceModelError(
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JaiOnDeviceModel found the Swift bridge and local model path \(modelPath), but the llama.cpp iOS binding is not linked. Add the C++/Swift llama.cpp implementation before claiming Gemma/Qwen runs on-device."
    )
  }

  static func embedText(
    modelPath: String,
    text: String,
    contextSize: Int,
    threads: Int
  ) throws -> [Float] {
    throw JaiOnDeviceModelError(
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      "JaiOnDeviceModel found the Swift bridge and local model path \(modelPath), but the llama.cpp iOS embedding binding is not linked. Add the C++/Swift llama.cpp implementation before claiming Qwen embeddings run on-device."
    )
  }
}
