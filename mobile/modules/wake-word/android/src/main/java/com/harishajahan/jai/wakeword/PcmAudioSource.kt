package com.harishajahan.jai.wakeword

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

data class PcmCaptureError(
  val code: String,
  val message: String,
  val permanent: Boolean,
  val restartable: Boolean,
)

data class PcmAudioSourceStatus(
  val captureThreadAlive: Boolean,
  val audioSessionId: Int?,
  val lastCaptureError: String?,
  val lastCaptureErrorCode: String?,
  val acousticEchoCancelerEnabled: Boolean,
  val noiseSuppressorEnabled: Boolean,
  val automaticGainControlEnabled: Boolean,
)

interface PcmAudioSourceListener {
  fun onCaptureError(error: PcmCaptureError)
  fun onCaptureStopped()
}

class PcmAudioSource(
  private val sampleRate: Int = 16000,
  private val frameMs: Int = 80,
  private val listener: PcmAudioSourceListener? = null,
) {
  private val running = AtomicBoolean(false)
  private var recorder: AudioRecord? = null
  private var worker: Thread? = null
  private var legacyConsumer: Thread? = null
  private var legacyQueue: AudioFrameQueue? = null
  private var acousticEchoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null
  private var automaticGainControl: AutomaticGainControl? = null
  private var lastCaptureError: PcmCaptureError? = null
  private var audioSessionId: Int? = null

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
    lastCaptureError = null
    val frameSamples = (sampleRate * frameMs / 1000).coerceAtLeast(1)
    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minBuffer <= 0) {
      val error = PcmCaptureError(
        code = "JAI_WAKE_AUDIO_UNSUPPORTED",
        message = "AudioRecord does not support 16 kHz mono PCM capture on this device.",
        permanent = true,
        restartable = false,
      )
      reportCaptureError(error)
      throw WakeWordException(
        error.code,
        error.message,
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
      val error = PcmCaptureError(
        code = "JAI_WAKE_AUDIO_INIT_FAILED",
        message = "Could not initialize wake-word microphone capture.",
        permanent = true,
        restartable = false,
      )
      reportCaptureError(error)
      throw WakeWordException(
        error.code,
        error.message,
      )
    }
    audioSessionId = nextRecorder.audioSessionId
    attachAudioEffects(nextRecorder.audioSessionId)
    try {
      nextRecorder.startRecording()
    } catch (error: Throwable) {
      releaseAudioEffects()
      nextRecorder.release()
      val captureError = PcmCaptureError(
        code = "JAI_WAKE_AUDIO_START_FAILED",
        message = "Could not start wake-word microphone capture.",
        permanent = true,
        restartable = false,
      )
      reportCaptureError(captureError)
      throw WakeWordException(
        captureError.code,
        captureError.message,
        error,
      )
    }
    recorder = nextRecorder
    running.set(true)
    worker = thread(name = "JaiWakeWordAudio", isDaemon = true) {
      val buffer = ShortArray(frameSamples)
      var filledSamples = 0
      var zeroReadCount = 0
      while (running.get()) {
        val read = try {
          nextRecorder.read(buffer, filledSamples, buffer.size - filledSamples)
        } catch (error: Throwable) {
          reportCaptureError(
            PcmCaptureError(
              code = "JAI_WAKE_AUDIO_READ_FAILED",
              message = "AudioRecord read failed: ${error.message ?: "unknown error"}",
              permanent = false,
              restartable = true,
            ),
          )
          break
        }
        if (read > 0) {
          zeroReadCount = 0
          filledSamples += read
          if (filledSamples >= frameSamples) {
            frameQueue.offer(buffer.copyOf(frameSamples))
            filledSamples = 0
          }
        } else if (read == 0) {
          zeroReadCount += 1
          if (zeroReadCount >= MAX_ZERO_READS) {
            reportCaptureError(
              PcmCaptureError(
                code = "JAI_WAKE_AUDIO_READ_STALLED",
                message = "AudioRecord returned no audio for $zeroReadCount consecutive reads.",
                permanent = false,
                restartable = true,
              ),
            )
            break
          }
        } else if (read == AudioRecord.ERROR_DEAD_OBJECT) {
          reportCaptureError(
            PcmCaptureError(
              code = "JAI_WAKE_AUDIO_DEAD_OBJECT",
              message = "AudioRecord stopped because the native audio object died.",
              permanent = false,
              restartable = true,
            ),
          )
          break
        } else if (read == AudioRecord.ERROR_INVALID_OPERATION) {
          reportCaptureError(
            PcmCaptureError(
              code = "JAI_WAKE_AUDIO_INVALID_OPERATION",
              message = "AudioRecord read failed with ERROR_INVALID_OPERATION.",
              permanent = true,
              restartable = false,
            ),
          )
          break
        } else if (read == AudioRecord.ERROR_BAD_VALUE) {
          reportCaptureError(
            PcmCaptureError(
              code = "JAI_WAKE_AUDIO_BAD_VALUE",
              message = "AudioRecord read failed with ERROR_BAD_VALUE.",
              permanent = true,
              restartable = false,
            ),
          )
          break
        } else if (read < 0) {
          reportCaptureError(
            PcmCaptureError(
              code = "JAI_WAKE_AUDIO_READ_TRANSIENT",
              message = "AudioRecord read returned transient error $read.",
              permanent = false,
              restartable = true,
            ),
          )
          break
        }
      }
      listener?.onCaptureStopped()
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
      releaseAudioEffects()
      recorder?.release()
    } catch (_: Throwable) {
    }
    recorder = null
    worker = null
    legacyConsumer = null
    legacyQueue = null
    audioSessionId = null
  }

  fun status(): PcmAudioSourceStatus {
    return PcmAudioSourceStatus(
      captureThreadAlive = worker?.isAlive == true,
      audioSessionId = audioSessionId,
      lastCaptureError = lastCaptureError?.message,
      lastCaptureErrorCode = lastCaptureError?.code,
      acousticEchoCancelerEnabled = acousticEchoCanceler?.enabled == true,
      noiseSuppressorEnabled = noiseSuppressor?.enabled == true,
      automaticGainControlEnabled = automaticGainControl?.enabled == true,
    )
  }

  private fun attachAudioEffects(sessionId: Int) {
    if (sessionId <= 0) return
    acousticEchoCanceler = createEffect(
      available = AcousticEchoCanceler.isAvailable(),
      create = { AcousticEchoCanceler.create(sessionId) },
    )
    noiseSuppressor = createEffect(
      available = NoiseSuppressor.isAvailable(),
      create = { NoiseSuppressor.create(sessionId) },
    )
    automaticGainControl = createEffect(
      available = AutomaticGainControl.isAvailable(),
      create = { AutomaticGainControl.create(sessionId) },
    )
  }

  private fun <T : android.media.audiofx.AudioEffect> createEffect(
    available: Boolean,
    create: () -> T?,
  ): T? {
    if (!available) return null
    return try {
      create()?.also { effect ->
        try {
          effect.enabled = true
        } catch (_: Throwable) {
        }
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun releaseAudioEffects() {
    try {
      acousticEchoCanceler?.release()
    } catch (_: Throwable) {
    }
    try {
      noiseSuppressor?.release()
    } catch (_: Throwable) {
    }
    try {
      automaticGainControl?.release()
    } catch (_: Throwable) {
    }
    acousticEchoCanceler = null
    noiseSuppressor = null
    automaticGainControl = null
  }

  private fun reportCaptureError(error: PcmCaptureError) {
    lastCaptureError = error
    listener?.onCaptureError(error)
  }

  companion object {
    private const val MAX_ZERO_READS = 5
  }
}
