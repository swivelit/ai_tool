package com.harishajahan.jai.wakeword

class WakeWordRingBuffer(capacitySamples: Int) {
  private val buffer = ShortArray(capacitySamples.coerceAtLeast(1))
  private var writeIndex = 0
  private var filled = 0

  @Synchronized
  fun append(samples: ShortArray) {
    for (sample in samples) {
      buffer[writeIndex] = sample
      writeIndex = (writeIndex + 1) % buffer.size
      filled = minOf(filled + 1, buffer.size)
    }
  }

  @Synchronized
  fun snapshot(): ShortArray {
    val out = ShortArray(filled)
    val start = (writeIndex - filled + buffer.size) % buffer.size
    for (index in 0 until filled) {
      out[index] = buffer[(start + index) % buffer.size]
    }
    return out
  }

  @Synchronized
  fun clear() {
    writeIndex = 0
    filled = 0
  }
}
