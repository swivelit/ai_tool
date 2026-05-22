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

  fun start(onFrame: (ShortArray) -> Unit) {
    stop()
    val frameSamples = (sampleRate * frameMs / 1000).coerceAtLeast(1)
    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val bufferSamples = maxOf(frameSamples * 4, minBuffer / 2)
    val nextRecorder = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSamples * 2,
    )
    recorder = nextRecorder
    running.set(true)
    nextRecorder.startRecording()
    worker = thread(name = "JaiWakeWordAudio", isDaemon = true) {
      val buffer = ShortArray(frameSamples)
      while (running.get()) {
        val read = nextRecorder.read(buffer, 0, buffer.size)
        if (read > 0) {
          onFrame(buffer.copyOf(read))
        }
      }
    }
  }

  fun stop() {
    running.set(false)
    try {
      recorder?.stop()
    } catch (_: Throwable) {
    }
    try {
      recorder?.release()
    } catch (_: Throwable) {
    }
    recorder = null
    worker = null
  }
}
