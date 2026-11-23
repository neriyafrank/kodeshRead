package expo.modules.importforegroundservice

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * A real Android foreground service (foregroundServiceType="dataSync") that keeps the app's
 * process — and so the JS import loop — alive while a library import runs with the app in the
 * background or the screen off. It holds a partial WakeLock (CPU on, screen may sleep) for the
 * duration. All the work stays in JS; this service only provides the process priority, the
 * ongoing notification and the wake lock. Declared in the app manifest by
 * plugins/withImportForegroundService.js.
 */
class ImportForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      shutdown()
      return START_NOT_STICKY
    }
    val notification = ImportNotification.build(
      this,
      intent?.getStringExtra(EXTRA_TITLE) ?: "מייבא ספרייה",
      intent?.getStringExtra(EXTRA_TEXT) ?: "",
      intent?.getIntExtra(EXTRA_CURRENT, 0) ?: 0,
      intent?.getIntExtra(EXTRA_TOTAL, 0) ?: 0,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(ImportNotification.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(ImportNotification.NOTIFICATION_ID, notification)
    }
    acquireWakeLock()
    running = true
    // Not sticky: if the OS kills the process, the import resumes from its SQLite checkpoint on
    // the next launch; restarting an empty service without the JS job would be pointless.
    return START_NOT_STICKY
  }

  /** Android 15+: dataSync services get a time budget; stop cleanly when it runs out. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    shutdown()
  }

  override fun onDestroy() {
    releaseWakeLock()
    running = false
    super.onDestroy()
  }

  private fun shutdown() {
    releaseWakeLock()
    running = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kodeshread:library-import").apply {
      setReferenceCounted(false)
      // Safety net: never hold the CPU longer than 10 hours even if JS never calls stop().
      acquire(10 * 60 * 60 * 1000L)
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  companion object {
    const val ACTION_START = "expo.modules.importforegroundservice.START"
    const val ACTION_STOP = "expo.modules.importforegroundservice.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_CURRENT = "current"
    const val EXTRA_TOTAL = "total"

    @Volatile
    var running: Boolean = false
      private set
  }
}
