import ExpoModulesCore
import Foundation

public class WakeWordModule: Module {
  private let engine = OpenWakeWordEngine()

  public func definition() -> ModuleDefinition {
    Name("JaiWakeWord")

    Events("onWake", "onWakeScore", "onWakeError")

    Function("isAvailable") {
      return self.engine.isAvailable()
    }

    AsyncFunction("getStatus") { () -> [String: Any?] in
      return self.engine.status()
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
