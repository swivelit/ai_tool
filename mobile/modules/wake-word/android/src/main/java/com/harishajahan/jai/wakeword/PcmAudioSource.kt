package com.harishajahan.jai.wakeword

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class PcmAudioSource(
  private val sampleRate: Int = 16000,
  private val frameMs: Int = 80,
) {
  private val running = AtomicBoolean(false)
  private var recorder: AudioRecord? = null
  private var worker: Thread? = null
  private var legacyConsumer: Thread? = null
  private var legacyQueue: AudioFrameQueue? = null

  fun start(frameQueue: AudioFrameQueue) {
    stop()
    startCapture(frameQueue)
  }

  fun start(onFrame: (ShortArray) -> Unit) {
    stop()
    val frameQueue = AudioFrameQueue(capacityFrames = 16)
    legacyQueue = frameQueue
    legacyConsumer = thread(name = "JaiWakeWordAudioConsumer", isDaemon = true) {
      while (running.get()) {
        val frame = frameQueue.take(100L) ?: continue
        onFrame(frame)
      }
    }
    startCapture(frameQueue)
  }

  private fun startCapture(frameQueue: AudioFrameQueue) {
    val frameSamples = (sampleRate * frameMs / 1000).coerceAtLeast(1)
    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minBuffer <= 0) {
      throw WakeWordException(
        "JAI_WAKE_AUDIO_UNSUPPORTED",
        "AudioRecord does not support 16 kHz mono PCM capture on this device.",
      )
    }
    val bufferSamples = maxOf(frameSamples * 4, minBuffer / 2)
    val nextRecorder = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSamples * 2,
    )
    if (nextRecorder.state != AudioRecord.STATE_INITIALIZED) {
      nextRecorder.release()
      throw WakeWordException(
        "JAI_WAKE_AUDIO_INIT_FAILED",
        "Could not initialize wake-word microphone capture.",
      )
    }
    try {
      nextRecorder.startRecording()
    } catch (error: Throwable) {
      nextRecorder.release()
      throw WakeWordException(
        "JAI_WAKE_AUDIO_START_FAILED",
        "Could not start wake-word microphone capture.",
        error,
      )
    }
    recorder = nextRecorder
    running.set(true)
    worker = thread(name = "JaiWakeWordAudio", isDaemon = true) {
      val buffer = ShortArray(frameSamples)
      while (running.get()) {
        val read = try {
          nextRecorder.read(buffer, 0, buffer.size)
        } catch (_: Throwable) {
          break
        }
        if (read > 0) {
          frameQueue.offer(buffer.copyOf(read))
        } else if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) {
          break
        }
      }
    }
  }

  fun stop() {
    running.set(false)
    val workerThread = worker
    val consumerThread = legacyConsumer
    legacyQueue?.close()
    try {
      recorder?.stop()
    } catch (_: Throwable) {
    }
    try {
      if (workerThread != null && Thread.currentThread() != workerThread) {
        workerThread.join(150)
      }
      if (consumerThread != null && Thread.currentThread() != consumerThread) {
        consumerThread.join(150)
      }
    } catch (_: Throwable) {
    }
    try {
      recorder?.release()
    } catch (_: Throwable) {
    }
    recorder = null
    worker = null
    legacyConsumer = null
    legacyQueue = null
  }
}
