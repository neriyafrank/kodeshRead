package expo.modules.clouddownload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build

/**
 * The ongoing "מוריד ספרייה מהענן… 42%" notification of the download worker (WorkManager shows it through its
 * foreground service). It has a "השהה" action (WorkManager's cancel intent: the partial bytes are kept, the JS
 * controller reads the cancelled work as "paused"). Framework APIs only, minSdk 24.
 */
internal object DownloadNotification {
  const val CHANNEL_ID = "kodeshread_cloud_download"
  const val NOTIFICATION_ID = 0x4B44 // "KD"

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "הורדת ספרייה", NotificationManager.IMPORTANCE_LOW).apply {
      description = "התקדמות הורדת הספרייה מהענן ברקע"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  /** `done` / `total` in bytes (total 0 = indeterminate). */
  fun build(context: Context, title: String, text: String, done: Long, total: Long, pauseIntent: PendingIntent?): Notification {
    ensureChannel(context)
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
      }
    builder
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)
    if (total > 0) {
      val permille = ((done.coerceIn(0L, total) * 1000L) / total).toInt()
      builder.setProgress(1000, permille, false)
    } else {
      builder.setProgress(0, 0, true)
    }
    if (pauseIntent != null) {
      builder.addAction(Notification.Action.Builder(Icon.createWithResource(context, android.R.drawable.ic_media_pause), "השהה", pauseIntent).build())
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    contentIntent(context)?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  /** Tapping the notification brings the app back to the front. */
  private fun contentIntent(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    return PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun notify(context: Context, notification: Notification) {
    try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, notification)
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS refused: the download still runs, the shade just has no progress.
    }
  }

  fun cancel(context: Context) {
    try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(NOTIFICATION_ID)
    } catch (e: Exception) {
      // nothing to remove
    }
  }
}
