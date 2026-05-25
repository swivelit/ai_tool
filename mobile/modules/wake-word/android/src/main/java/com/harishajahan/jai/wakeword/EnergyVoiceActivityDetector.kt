package com.harishajahan.jai.wakeword

import kotlin.math.sqrt

class EnergyVoiceActivityDetector(
  var speechRmsThreshold: Double = DEFAULT_SPEECH_RMS_THRESHOLD,
) {
  fun isSpeech(frame: ShortArray): Boolean {
    if (frame.isEmpty()) return false
    var sumSquares = 0.0
    for (sample in frame) {
      val normalized = sample.toDouble() / 32768.0
      sumSquares += normalized * normalized
    }
    val rms = sqrt(sumSquares / frame.size.toDouble())
    return rms >= speechRmsThreshold
  }

  companion object {
    const val DEFAULT_SPEECH_RMS_THRESHOLD = 0.011
  }
}
