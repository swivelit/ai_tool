package com.harishajahan.jai.wakeword

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

data class WakeInferenceWorkerStatus(
  val inferenceThreadAlive: Boolean,
  val lastInferenceError: String?,
  val inferenceDroppedFrames: Long,
  val inferenceErrorCount: Long,
)

data class WakeInferenceError(
  val code: String,
  val message: String,
  val permanent: Boolean,
  val restartable: Boolean,
)

internal class WakeInferenceWorker(
  private val frameQueue: AudioFrameQueue,
  private val pipeline: WakeWordPipeline,
  private val threshold: Double,
  private val minWakeIntervalMs: Long,
  private val onWake: (WakeWordEvent) -> Unit,
  private val onScore: (WakeWordEvent) -> Unit,
  private val onError: (WakeInferenceError) -> Unit,
  private val onStopped: (String?) -> Unit = {},
) {
  private val running = AtomicBoolean(false)
  private var worker: Thread? = null
  private var lastWakeAtMs = 0L
  private var lastScoreEventAtMs = 0L
  private var lastInferenceError: String? = null
  private var inferenceDroppedFrames = 0L
  private var inferenceErrorCount = 0L

  fun start() {
    if (!running.compareAndSet(false, true)) return
    worker = thread(name = "JaiWakeWordInference", isDaemon = true) {
      var consecutiveErrors = 0
      var stopReason: String? = null
      while (running.get()) {
        val frame = frameQueue.take(100L) ?: continue
        try {
          val score = pipeline.processFrame(frame) ?: continue
          consecutiveErrors = 0
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
          inferenceErrorCount += 1
          lastInferenceError = error.detail
          if (isFatalInferenceError(error.code)) {
            stopReason = error.code
            running.set(false)
            onError(
              WakeInferenceError(
                code = error.code,
                message = error.detail,
                permanent = true,
                restartable = false,
              ),
            )
            break
          }
          inferenceDroppedFrames += 1
          consecutiveErrors += 1
          Log.w(TAG, "Dropping wake frame after recoverable inference error ${error.code}: ${error.detail}")
          if (consecutiveErrors >= MAX_CONSECUTIVE_RECOVERABLE_ERRORS) {
            val detail = "Wake-word inference stopped after $consecutiveErrors consecutive recoverable errors."
            lastInferenceError = detail
            stopReason = "JAI_WAKE_INFERENCE_REPEATED_ERRORS"
            running.set(false)
            onError(
              WakeInferenceError(
                code = "JAI_WAKE_INFERENCE_REPEATED_ERRORS",
                message = detail,
                permanent = false,
                restartable = false,
              ),
            )
            break
          }
        } catch (error: Throwable) {
          inferenceErrorCount += 1
          inferenceDroppedFrames += 1
          consecutiveErrors += 1
          val detail = "Wake-word inference dropped a frame: ${error.message ?: "unknown error"}"
          lastInferenceError = detail
          Log.w(TAG, detail, error)
          if (consecutiveErrors >= MAX_CONSECUTIVE_RECOVERABLE_ERRORS) {
            val fatalDetail = "Wake-word inference failed repeatedly: ${error.message ?: "unknown error"}"
            lastInferenceError = fatalDetail
            stopReason = "JAI_WAKE_INFERENCE_FAILED"
            running.set(false)
            onError(
              WakeInferenceError(
                code = "JAI_WAKE_INFERENCE_FAILED",
                message = fatalDetail,
                permanent = false,
                restartable = false,
              ),
            )
            break
          }
        }
      }
      onStopped(stopReason)
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

  fun status(): WakeInferenceWorkerStatus {
    return WakeInferenceWorkerStatus(
      inferenceThreadAlive = worker?.isAlive == true,
      lastInferenceError = lastInferenceError,
      inferenceDroppedFrames = inferenceDroppedFrames,
      inferenceErrorCount = inferenceErrorCount,
    )
  }

  private fun isFatalInferenceError(code: String): Boolean {
    val normalized = code.lowercase()
    return normalized.contains("model") ||
      normalized.contains("shape") ||
      normalized.contains("unsupported") ||
      normalized.contains("load") ||
      normalized.contains("config")
  }

  companion object {
    private const val TAG = "JaiWakeInferenceWorker"
    private const val MAX_CONSECUTIVE_RECOVERABLE_ERRORS = 5
  }
}
