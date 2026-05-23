package com.harishajahan.jai.wakeword

import kotlin.math.sqrt

class EnergyVoiceActivityDetector(
  private val speechRmsThreshold: Double = 0.018,
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
}
