import AVFoundation
import Foundation

public final class PcmAudioSource {
  private let engine = AVAudioEngine()

  public init() {}

  public func stop() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
  }
}
