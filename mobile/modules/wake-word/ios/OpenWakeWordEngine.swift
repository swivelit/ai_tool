import Foundation

public final class WakeWordError: Error, LocalizedError {
  public let code: String
  public let message: String

  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }

  public var errorDescription: String? {
    return "JaiWakeWord error [\(code)]: \(message)"
  }
}

public final class OpenWakeWordEngine {
  private var running = false
  private var modelLoaded = false
  private var sampleRate = 16000
  private var frameMs = 80
  private var lastScore: Double?
  private var lastError: String?

  public func isAvailable() -> Bool {
    return false
  }

  public func start(config: [String: Any]) throws {
    stop()
    guard let modelPaths = config["modelPaths"] as? [String: Any],
          let wakeModel = (modelPaths["wakeModel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !wakeModel.isEmpty else {
      throw WakeWordError("JAI_WAKE_MODEL_REQUIRED", "start(config) requires modelPaths.wakeModel.")
    }
    sampleRate = (config["sampleRate"] as? Int) ?? 16000
    frameMs = (config["frameMs"] as? Int) ?? 80
    _ = try resolveFile(wakeModel, label: "wakeModel")

    lastError = "JaiWakeWord iOS has the native Expo module scaffold, but the ONNX Runtime wake pipeline is not linked in this build."
    throw WakeWordError("JAI_WAKE_MODEL_UNSUPPORTED", lastError!)
  }

  public func stop() {
    running = false
    modelLoaded = false
  }

  public func status() -> [String: Any?] {
    return [
      "running": running,
      "modelLoaded": modelLoaded,
      "sampleRate": sampleRate,
      "frameMs": frameMs,
      "lastScore": lastScore,
      "error": lastError,
    ]
  }

  private func resolveFile(_ value: String, label: String) throws -> URL {
    let path: String
    if value.hasPrefix("file://"), let url = URL(string: value) {
      path = url.path
    } else if value.hasPrefix("/") {
      path = value
    } else {
      throw WakeWordError("JAI_WAKE_MODEL_PATH_INVALID", "\(label) must be a file:// URI or absolute path.")
    }
    guard FileManager.default.fileExists(atPath: path) else {
      throw WakeWordError("JAI_WAKE_MODEL_NOT_FOUND", "\(label) does not point to a local model file.")
    }
    return URL(fileURLWithPath: path)
  }
}
