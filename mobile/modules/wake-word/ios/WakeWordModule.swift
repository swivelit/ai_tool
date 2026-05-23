import ExpoModulesCore
import Foundation

public class WakeWordModule: Module {
  private let engine = OpenWakeWordEngine()

  public func definition() -> ModuleDefinition {
    Name("JaiWakeWord")

    Events("onState", "onWake", "onWakeScore", "onCommand", "onCommandAudio", "onWakeError")

    Function("isAvailable") {
      return self.engine.isAvailable()
    }

    AsyncFunction("getStatus") { () -> [String: Any?] in
      return self.engine.status()
    }

    AsyncFunction("configure") { (_ config: [String: Any]) -> [String: Any] in
      return ["ok": true]
    }

    AsyncFunction("startSession") { (config: [String: Any]) -> [String: Any] in
      do {
        try self.engine.start(config: config)
        return ["ok": true]
      } catch let error as WakeWordError {
        self.sendEvent("onWakeError", ["code": error.code, "message": error.message])
        throw error
      }
    }

    AsyncFunction("stopSession") { () -> [String: Any] in
      self.engine.stop()
      return ["ok": true]
    }

    AsyncFunction("cancelCommand") { () -> [String: Any] in
      self.engine.stop()
      return ["ok": true]
    }

    AsyncFunction("notifyTtsStarted") { () -> [String: Any] in
      self.sendEvent("onState", [
        "state": "speaking",
        "previousState": "commandReady",
        "reason": "tts_started",
        "timestamp": Date().timeIntervalSince1970 * 1000,
      ])
      return ["ok": true]
    }

    AsyncFunction("notifyTtsCompleted") { () -> [String: Any] in
      self.sendEvent("onState", [
        "state": "idle",
        "previousState": "speaking",
        "reason": "tts_completed",
        "timestamp": Date().timeIntervalSince1970 * 1000,
      ])
      return ["ok": true]
    }

    AsyncFunction("start") { (config: [String: Any]) -> [String: Any] in
      do {
        try self.engine.start(config: config)
        return ["ok": true]
      } catch let error as WakeWordError {
        self.sendEvent("onWakeError", ["code": error.code, "message": error.message])
        throw error
      }
    }

    AsyncFunction("stop") { () -> [String: Any] in
      self.engine.stop()
      return ["ok": true]
    }

    AsyncFunction("validateModelBundle") { (config: [String: Any]) -> [String: Any] in
      return self.engine.validateModelBundle(config: config)
    }
  }
}
