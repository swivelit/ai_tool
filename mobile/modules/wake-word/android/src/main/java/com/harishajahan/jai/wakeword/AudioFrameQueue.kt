package com.harishajahan.jai.wakeword

import java.util.ArrayDeque

data class AudioFrameQueueStats(
  val queuedFrames: Int,
  val droppedFrames: Long,
  val closed: Boolean,
)

class AudioFrameQueue(capacityFrames: Int) {
  private val capacity = capacityFrames.coerceAtLeast(1)
  private val lock = Object()
  private val frames = ArrayDeque<ShortArray>(capacity)
  private var droppedFrameCount = 0L
  private var isClosed = false

  fun offer(frame: ShortArray): Boolean {
    synchronized(lock) {
      if (isClosed) return false
      if (frames.size >= capacity) {
        frames.removeFirst()
        droppedFrameCount += 1
      }
      frames.addLast(frame)
      lock.notifyAll()
      return true
    }
  }

  fun take(timeoutMs: Long = 100L): ShortArray? {
    val deadline = System.currentTimeMillis() + timeoutMs.coerceAtLeast(0L)
    synchronized(lock) {
      while (frames.isEmpty() && !isClosed) {
        val remaining = deadline - System.currentTimeMillis()
        if (remaining <= 0L) return null
        try {
          lock.wait(remaining)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          return null
        }
      }
      return if (frames.isEmpty()) null else frames.removeFirst()
    }
  }

  fun clear() {
    synchronized(lock) {
      frames.clear()
      lock.notifyAll()
    }
  }

  fun close() {
    synchronized(lock) {
      isClosed = true
      frames.clear()
      lock.notifyAll()
    }
  }

  fun stats(): AudioFrameQueueStats {
    synchronized(lock) {
      return AudioFrameQueueStats(
        queuedFrames = frames.size,
        droppedFrames = droppedFrameCount,
        closed = isClosed,
      )
    }
  }
}
