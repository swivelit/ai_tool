package com.harishajahan.jai.wakeword

import java.util.ArrayDeque

class PreRollBuffer(
  private val sampleRate: Int,
  durationMs: Int = 1500,
) {
  private val maxSamples = (sampleRate * durationMs / 1000).coerceAtLeast(1)
  private val frames = ArrayDeque<ShortArray>()
  private var totalSamples = 0

  @Synchronized
  fun append(frame: ShortArray) {
    if (frame.isEmpty()) return
    frames.addLast(frame.copyOf())
    totalSamples += frame.size
    while (totalSamples > maxSamples && frames.isNotEmpty()) {
      val removed = frames.removeFirst()
      totalSamples -= removed.size
    }
  }

  @Synchronized
  fun snapshotFrames(): List<ShortArray> {
    return frames.map { it.copyOf() }
  }

  @Synchronized
  fun clear() {
    frames.clear()
    totalSamples = 0
  }

  @Synchronized
  fun durationMs(): Long {
    return samplesToMs(totalSamples, sampleRate)
  }
}
