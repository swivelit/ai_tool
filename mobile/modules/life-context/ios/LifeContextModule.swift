import ExpoModulesCore
import Foundation

public class LifeContextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LifeContext")

    AsyncFunction("getPermissionState") { () -> [String: String] in
      return [
        "activityRecognition": "unavailable",
        "usageAccess": "unavailable",
      ]
    }

    AsyncFunction("requestActivityRecognitionPermission") { () -> String in
      return "unavailable"
    }

    AsyncFunction("openUsageAccessSettings") { () -> Void in
      return
    }

    AsyncFunction("getDailyLifeContext") { (_ input: [String: Any]?) -> [String: Any] in
      let now = Date()
      let formatter = DateFormatter()
      formatter.calendar = Calendar(identifier: .gregorian)
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "yyyy-MM-dd"
      return [
        "date": formatter.string(from: now),
        "timezone": TimeZone.current.identifier,
        "permissions": [
          "activityRecognition": "unavailable",
          "usageAccess": "unavailable",
        ],
        "movement": [
          "steps": NSNull(),
          "estimatedDistanceMeters": NSNull(),
          "confidence": "unavailable",
          "source": "ios_unsupported",
        ],
        "screen": [
          "screenTimeMs": NSNull(),
          "unlocks": NSNull(),
          "confidence": "unavailable",
          "source": "ios_unsupported",
        ],
        "apps": [],
        "generatedAt": ISO8601DateFormatter().string(from: now),
      ]
    }
  }
}
