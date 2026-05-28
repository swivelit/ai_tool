package com.harishajahan.jai.lifecontext

import android.Manifest
import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max

class LifeContextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LifeContext")

    AsyncFunction("getPermissionState") {
      mapOf(
        "activityRecognition" to activityRecognitionState(),
        "usageAccess" to usageAccessState(),
      )
    }

    AsyncFunction("requestActivityRecognitionPermission") { promise: Promise ->
      requestActivityRecognitionPermission(promise)
    }

    AsyncFunction("openUsageAccessSettings") {
      val context = applicationContextOrNull()
      if (context != null) {
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
      }
    }

    AsyncFunction("getDailyLifeContext") { input: Map<String, Any?>? ->
      buildDailyLifeContext(input ?: emptyMap())
    }
  }

  private fun applicationContextOrNull(): Context? {
    return appContext.reactContext?.applicationContext ?: appContext.currentActivity?.applicationContext
  }

  private fun nowIso(): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    formatter.timeZone = TimeZone.getTimeZone("UTC")
    return formatter.format(Date())
  }

  private fun localDateString(timeMs: Long = System.currentTimeMillis()): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    formatter.timeZone = TimeZone.getDefault()
    return formatter.format(Date(timeMs))
  }

  private fun startOfLocalDayMs(nowMs: Long = System.currentTimeMillis()): Long {
    val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    formatter.timeZone = TimeZone.getDefault()
    return try {
      formatter.parse(localDateString(nowMs))?.time ?: nowMs
    } catch (_: Throwable) {
      nowMs
    }
  }

  private fun activityRecognitionState(): String {
    val context = applicationContextOrNull() ?: return "unavailable"
    val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
      ?: return "unavailable"
    val stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
      ?: return "unavailable"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return "granted"
    }
    return if (
      context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      "granted"
    } else {
      "denied"
    }
  }

  private fun requestActivityRecognitionPermission(promise: Promise) {
    val context = applicationContextOrNull()
    if (context == null) {
      promise.resolve("unavailable")
      return
    }
    val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (sensorManager?.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) == null) {
      promise.resolve("unavailable")
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.resolve("granted")
      return
    }
    val permissions = appContext.permissions
    if (permissions == null) {
      promise.resolve(activityRecognitionState())
      return
    }
    permissions.askForPermissions(
      { result: Map<String, PermissionsResponse> ->
        val response = result[Manifest.permission.ACTIVITY_RECOGNITION]
        promise.resolve(if (response?.status == PermissionsStatus.GRANTED) "granted" else activityRecognitionState())
      },
      Manifest.permission.ACTIVITY_RECOGNITION,
    )
  }

  private fun usageAccessState(): String {
    val context = applicationContextOrNull() ?: return "unavailable"
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
      ?: return "unavailable"
    val mode = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          context.packageName,
        )
      } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          context.packageName,
        )
      }
    } catch (_: Throwable) {
      return "unavailable"
    }
    return if (mode == AppOpsManager.MODE_ALLOWED) "granted" else "denied"
  }

  private fun buildDailyLifeContext(input: Map<String, Any?>): Map<String, Any?> {
    val context = applicationContextOrNull()
    val nowMs = System.currentTimeMillis()
    val startMs = positiveLong(input["startMs"]) ?: startOfLocalDayMs(nowMs)
    val endMs = positiveLong(input["endMs"]) ?: nowMs
    val safeEndMs = if (endMs > startMs) endMs else nowMs
    val shareAppNames = input["shareAppNamesWithAi"] == true
    val permissions = mapOf(
      "activityRecognition" to activityRecognitionState(),
      "usageAccess" to usageAccessState(),
    )

    val movement = try {
      buildMovementPayload(context)
    } catch (_: Throwable) {
      unavailableMovement("android_step_counter_error")
    }
    val usage = try {
      buildUsagePayload(context, startMs, safeEndMs, shareAppNames)
    } catch (_: Throwable) {
      UsagePayload(
        screen = unavailableScreen("android_usage_stats_error"),
        apps = emptyList(),
      )
    }

    return mapOf(
      "date" to localDateString(startMs),
      "timezone" to TimeZone.getDefault().id,
      "permissions" to permissions,
      "movement" to movement,
      "screen" to usage.screen,
      "apps" to usage.apps,
      "generatedAt" to nowIso(),
    )
  }

  private fun positiveLong(value: Any?): Long? {
    val numeric = when (value) {
      is Number -> value.toLong()
      is String -> value.toLongOrNull()
      else -> null
    }
    return numeric?.takeIf { it > 0L }
  }

  private fun unavailableMovement(source: String): Map<String, Any?> {
    return mapOf(
      "steps" to null,
      "estimatedDistanceMeters" to null,
      "confidence" to "unavailable",
      "source" to source,
      "partialDay" to false,
      "trackingStartedAtMs" to null,
    )
  }

  private fun unavailableScreen(source: String): Map<String, Any?> {
    return mapOf(
      "screenTimeMs" to null,
      "unlocks" to null,
      "confidence" to "unavailable",
      "source" to source,
    )
  }

  private fun buildMovementPayload(context: Context?): Map<String, Any?> {
    if (context == null || activityRecognitionState() != "granted") {
      return unavailableMovement("activity_recognition_not_granted")
    }
    val currentCounter = readStepCounter(context)
      ?: return unavailableMovement("android_step_counter_unavailable")
    val prefs = context.getSharedPreferences("jai_life_context_v1", Context.MODE_PRIVATE)
    val date = localDateString()
    val bootKey = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    val storedDate = prefs.getString("step_baseline_date", "")
    val storedBootKey = prefs.getLong("step_baseline_boot_key", -1L)
    var trackingStartedAtMs = prefs.getLong("step_tracking_started_at_ms", startOfLocalDayMs())
    var baseline = prefs.getFloat("step_baseline_value", currentCounter)
    var baselineJustCreated = false
    if (storedDate != date || storedBootKey != bootKey) {
      baseline = currentCounter
      baselineJustCreated = true
      trackingStartedAtMs = System.currentTimeMillis()
      prefs.edit()
        .putString("step_baseline_date", date)
        .putLong("step_baseline_boot_key", bootKey)
        .putFloat("step_baseline_value", baseline)
        .putLong("step_tracking_started_at_ms", trackingStartedAtMs)
        .apply()
    }

    val steps = max(0, (currentCounter - baseline).toInt())
    val distanceMeters = (steps * 0.762).toInt()
    val startOfDay = startOfLocalDayMs()
    val partialDay = baselineJustCreated || trackingStartedAtMs > startOfDay + TimeUnit.MINUTES.toMillis(5)
    return mapOf(
      "steps" to steps,
      "estimatedDistanceMeters" to distanceMeters,
      "confidence" to if (baselineJustCreated) "medium" else "high",
      "source" to "android_step_counter_daily_baseline",
      "partialDay" to partialDay,
      "trackingStartedAtMs" to trackingStartedAtMs,
      "note" to if (partialDay) {
        "Steps are counted since Life Intelligence tracking started today, not a full-day total."
      } else {
        null
      },
    )
  }

  private fun readStepCounter(context: Context): Float? {
    val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
      ?: return null
    val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return null
    val latch = CountDownLatch(1)
    var value: Float? = null
    val listener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent?) {
        val next = event?.values?.firstOrNull()
        if (next != null && next >= 0f) {
          value = next
          latch.countDown()
        }
      }

      override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }
    // Use a dedicated sensor thread so waiting for the one-shot step reading never blocks
    // the React Native/UI main thread on real devices.
    val sensorThread = HandlerThread("JaiLifeStepRead")
    sensorThread.start()
    val handler = Handler(sensorThread.looper)
    val registered = try {
      sensorManager.registerListener(
        listener,
        sensor,
        SensorManager.SENSOR_DELAY_NORMAL,
        handler,
      )
    } catch (_: Throwable) {
      false
    }
    if (!registered) {
      sensorThread.quitSafely()
      return null
    }
    try {
      latch.await(1200, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } finally {
      sensorManager.unregisterListener(listener)
      sensorThread.quitSafely()
    }
    return value
  }

  private data class UsagePayload(
    val screen: Map<String, Any?>,
    val apps: List<Map<String, Any?>>,
  )

  private data class MutableAppUsage(
    var foregroundTimeMs: Long = 0L,
    var launchCount: Int = 0,
  )

  private fun buildUsagePayload(
    context: Context?,
    startMs: Long,
    endMs: Long,
    shareAppNames: Boolean,
  ): UsagePayload {
    if (context == null || usageAccessState() != "granted") {
      return UsagePayload(
        screen = unavailableScreen("usage_access_not_granted"),
        apps = emptyList(),
      )
    }
    val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
      ?: return UsagePayload(unavailableScreen("usage_stats_unavailable"), emptyList())
    val events = manager.queryEvents(startMs, endMs)
      ?: return UsagePayload(unavailableScreen("usage_stats_unavailable"), emptyList())
    val activeStarts = mutableMapOf<String, Long>()
    val byPackage = mutableMapOf<String, MutableAppUsage>()
    val event = UsageEvents.Event()

    while (events.hasNextEvent()) {
      events.getNextEvent(event)
      val packageName = event.packageName?.trim().orEmpty()
      if (packageName.isEmpty()) continue
      val timestamp = event.timeStamp.coerceIn(startMs, endMs)
      when {
        isForegroundEvent(event.eventType) -> {
          if (!activeStarts.containsKey(packageName)) {
            activeStarts[packageName] = timestamp
            byPackage.getOrPut(packageName) { MutableAppUsage() }.launchCount += 1
          }
        }
        isBackgroundEvent(event.eventType) -> {
          val startedAt = activeStarts.remove(packageName)
          if (startedAt != null && timestamp > startedAt) {
            byPackage.getOrPut(packageName) { MutableAppUsage() }.foregroundTimeMs +=
              timestamp - startedAt
          }
        }
      }
    }

    activeStarts.forEach { (packageName, startedAt) ->
      if (endMs > startedAt) {
        byPackage.getOrPut(packageName) { MutableAppUsage() }.foregroundTimeMs += endMs - startedAt
      }
    }

    val apps = byPackage.entries
      .filter { it.value.foregroundTimeMs > 0L }
      .sortedByDescending { it.value.foregroundTimeMs }
      .take(12)
      .map { (packageName, usage) ->
        appUsageRow(context, packageName, usage, shareAppNames)
      }
    val totalScreenTime = byPackage.values.sumOf { it.foregroundTimeMs }
    return UsagePayload(
      screen = mapOf(
        "screenTimeMs" to totalScreenTime,
        "unlocks" to null,
        "confidence" to "high",
        "source" to "android_usage_stats_foreground_events",
      ),
      apps = apps,
    )
  }

  private fun isForegroundEvent(eventType: Int): Boolean {
    return eventType == UsageEvents.Event.MOVE_TO_FOREGROUND ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        eventType == UsageEvents.Event.ACTIVITY_RESUMED)
  }

  private fun isBackgroundEvent(eventType: Int): Boolean {
    return eventType == UsageEvents.Event.MOVE_TO_BACKGROUND ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        eventType == UsageEvents.Event.ACTIVITY_PAUSED)
  }

  private fun appUsageRow(
    context: Context,
    packageName: String,
    usage: MutableAppUsage,
    shareAppNames: Boolean,
  ): Map<String, Any?> {
    val info = applicationInfoForPackage(context, packageName)
    val category = info?.let { appCategoryLabel(it) } ?: "other"
    val label = if (shareAppNames && info != null) {
      try {
        context.packageManager.getApplicationLabel(info).toString().trim().takeIf { it.isNotEmpty() }
      } catch (_: Throwable) {
        null
      }
    } else {
      null
    }
    val row = mutableMapOf<String, Any?>(
      "category" to category,
      "foregroundTimeMs" to usage.foregroundTimeMs,
      "launchCount" to usage.launchCount,
    )
    if (shareAppNames) {
      row["packageName"] = packageName
      row["appName"] = label
    }
    return row
  }

  private fun applicationInfoForPackage(context: Context, packageName: String): ApplicationInfo? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getApplicationInfo(
          packageName,
          PackageManager.ApplicationInfoFlags.of(0),
        )
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getApplicationInfo(packageName, 0)
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun appCategoryLabel(info: ApplicationInfo): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "other"
    return when (info.category) {
      ApplicationInfo.CATEGORY_GAME -> "games"
      ApplicationInfo.CATEGORY_AUDIO -> "audio"
      ApplicationInfo.CATEGORY_VIDEO -> "video"
      ApplicationInfo.CATEGORY_IMAGE -> "image"
      ApplicationInfo.CATEGORY_SOCIAL -> "social"
      ApplicationInfo.CATEGORY_NEWS -> "news"
      ApplicationInfo.CATEGORY_MAPS -> "maps"
      ApplicationInfo.CATEGORY_PRODUCTIVITY -> "productivity"
      else -> "other"
    }
  }
}
