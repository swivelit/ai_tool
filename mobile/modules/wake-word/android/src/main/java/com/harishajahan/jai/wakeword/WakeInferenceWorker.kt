package com.harishajahan.jai.wakeword

import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

internal class WakeInferenceWorker(
  private val frameQueue: AudioFrameQueue,
  private val pipeline: WakeWordPipeline,
  private val threshold: Double,
  private val minWakeIntervalMs: Long,
  private val onWake: (WakeWordEvent) -> Unit,
  private val onScore: (WakeWordEvent) -> Unit,
  private val onError: (String, String) -> Unit,
) {
  private val running = AtomicBoolean(false)
  private var worker: Thread? = null
  private var lastWakeAtMs = 0L
  private var lastScoreEventAtMs = 0L

  fun start() {
    if (!running.compareAndSet(false, true)) return
    worker = thread(name = "JaiWakeWordInference", isDaemon = true) {
      while (running.get()) {
        val frame = frameQueue.take(100L) ?: continue
        try {
          val score = pipeline.processFrame(frame) ?: continue
          val now = System.currentTimeMillis()
          val event = WakeWordEvent(
            score = score,
            model = pipeline.modelName,
            phraseKey = pipeline.phraseKey,
            timestamp = now,
          )
          if (now - lastScoreEventAtMs >= 1000L) {
            lastScoreEventAtMs = now
            onScore(event)
          }
          if (score >= threshold && now - lastWakeAtMs >= minWakeIntervalMs) {
            lastWakeAtMs = now
            onWake(event)
          }
        } catch (error: WakeWordException) {
          onError(error.code, error.detail)
          stop()
        } catch (error: Throwable) {
          onError(
            "JAI_WAKE_INFERENCE_FAILED",
            "Wake-word inference failed: ${error.message ?: "unknown error"}",
          )
          stop()
        }
      }
    }
  }

  fun stop() {
    running.set(false)
    val workerThread = worker
    if (workerThread != null && Thread.currentThread() != workerThread) {
      try {
        workerThread.join(500L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    worker = null
  }
}
