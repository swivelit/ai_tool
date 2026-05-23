package com.harishajahan.jai.wakeword

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class HandsFreeForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopSession()
        return START_NOT_STICKY
      }
      ACTION_START -> {
        startForegroundForMicrophone()
        try {
          HandsFreeControllerRegistry.startPendingSession(this)
        } catch (error: WakeWordException) {
          HandsFreeControllerRegistry.stopSession()
          stopForegroundCompat()
          stopSelf()
        } catch (_: Throwable) {
          HandsFreeControllerRegistry.stopSession()
          stopForegroundCompat()
          stopSelf()
        }
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    HandsFreeControllerRegistry.stopSession()
    super.onDestroy()
  }

  private fun startForegroundForMicrophone() {
    createNotificationChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun stopSession() {
    HandsFreeControllerRegistry.stopSession()
    stopForegroundCompat()
    stopSelf()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Hands-free voice",
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.setSound(null, null)
    manager?.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val icon = applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_btn_speak_now
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("Hands-free voice")
      .setContentText("Listening while the voice session is open")
      .setSmallIcon(icon)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  companion object {
    private const val CHANNEL_ID = "jai_hands_free_microphone"
    private const val NOTIFICATION_ID = 8142
    private const val ACTION_START = "com.harishajahan.jai.wakeword.START_HANDS_FREE"
    private const val ACTION_STOP = "com.harishajahan.jai.wakeword.STOP_HANDS_FREE"

    fun startSession(context: Context, config: Map<String, Any?>) {
      HandsFreeControllerRegistry.enqueueStartConfig(config)
      val intent = Intent(context, HandsFreeForegroundService::class.java).setAction(ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stopSession(context: Context) {
      val intent = Intent(context, HandsFreeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }
  }
}
