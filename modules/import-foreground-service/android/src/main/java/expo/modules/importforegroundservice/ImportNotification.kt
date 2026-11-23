package expo.modules.importforegroundservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * The ongoing "מייבא ספרייה" notification: phase title, "1,240 / 7,674" text and a progress bar.
 * Framework APIs only (no androidx dependency), minSdk 24.
 */
internal object ImportNotification {
  const val CHANNEL_ID = "kodeshread_library_import"
  const val NOTIFICATION_ID = 0x4B52 // "KR"

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "ייבוא ספרייה", NotificationManager.IMPORTANCE_LOW).apply {
      description = "התקדמות ייבוא ובניית הספרייה ברקע"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  fun build(context: Context, title: String, text: String, current: Int, total: Int): Notification {
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
      builder.setProgress(total, current.coerceIn(0, total), false)
    } else {
      builder.setProgress(0, 0, true)
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
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun notify(context: Context, notification: Notification) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, notification)
  }
}
