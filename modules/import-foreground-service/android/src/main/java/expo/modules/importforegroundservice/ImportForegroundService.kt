package expo.modules.importforegroundservice

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * A real Android foreground service (foregroundServiceType="dataSync") that keeps the app's
 * process — and so the JS import loop — alive while a library import runs with the app in the
 * background or the screen off. It holds a partial WakeLock (CPU on, screen may sleep) for the
 * duration. All the work stays in JS; this service only provides the process priority, the
 * ongoing notification and the wake lock. Declared in the app manifest by
 * plugins/withImportForegroundService.js.
 *
 * Crash safety (Android kills the whole app for these, so every path is guarded):
 *  - after startForegroundService() the service MUST call startForeground() in onStartCommand,
 *    even when the import already finished: a stop request that arrives first is remembered
 *    (stopRequested) and honoured right AFTER startForeground(). The module never calls
 *    Context.stopService() on a service that may not have reached startForeground() yet;
 *  - startForeground() itself can throw (ForegroundServiceStartNotAllowedException, a missing
 *    permission): the service then stops quietly and JS falls back to pausing on background;
 *  - Android 15 dataSync time limit (onTimeout): the service stops at once; JS sees
 *    isRunning() == false and pauses the import when the app leaves the foreground.
 */
class ImportForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Always reach the foreground first: the system requires it for every startForegroundService().
    val notification = ImportNotification.build(
      this,
      intent?.getStringExtra(EXTRA_TITLE) ?: "מייבא ספרייה",
      intent?.getStringExtra(EXTRA_TEXT) ?: "",
      intent?.getIntExtra(EXTRA_CURRENT, 0) ?: 0,
      intent?.getIntExtra(EXTRA_TOTAL, 0) ?: 0,
    )
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(ImportNotification.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(ImportNotification.NOTIFICATION_ID, notification)
      }
      inForeground = true
    } catch (e: Exception) {
      Log.w(TAG, "startForeground refused; import continues without the service", e)
      shutdown()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP || stopRequested) {
      shutdown()
      return START_NOT_STICKY
    }
    acquireWakeLock()
    running = true
    // Not sticky: if the OS kills the process, the import resumes from its SQLite checkpoint on
    // the next launch; restarting an empty service without the JS job would be pointless.
    return START_NOT_STICKY
  }

  /** Android 15+: dataSync services get a time budget; stop at once when it runs out. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    shutdown()
  }

  override fun onDestroy() {
    releaseWakeLock()
    running = false
    inForeground = false
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** Releases everything and stops; safe to call more than once. */
  fun shutdown() {
    releaseWakeLock()
    running = false
    if (inForeground) {
      try {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } catch (e: Exception) {
        Log.w(TAG, "stopForeground failed", e)
      }
      inForeground = false
    }
    stopSelf()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kodeshread:library-import").apply {
        setReferenceCounted(false)
        // Safety net: never hold the CPU longer than 10 hours even if JS never calls stop().
        acquire(10 * 60 * 60 * 1000L)
      }
    } catch (e: Exception) {
      Log.w(TAG, "wake lock unavailable", e)
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (e: Exception) {
      Log.w(TAG, "wake lock release failed", e)
    }
    wakeLock = null
  }

  companion object {
    private const val TAG = "ImportForegroundService"
    const val ACTION_START = "expo.modules.importforegroundservice.START"
    const val ACTION_STOP = "expo.modules.importforegroundservice.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_CURRENT = "current"
    const val EXTRA_TOTAL = "total"

    @Volatile
    var running: Boolean = false
      private set

    /** Set by stop(): honoured as soon as the service has reached the foreground. */
    @Volatile
    var stopRequested: Boolean = false

    @Volatile
    private var instance: ImportForegroundService? = null

    /** Bumped by every start: a stop posted for an earlier job never stops a newer one. */
    @Volatile
    private var generation: Int = 0

    /** Called before startForegroundService(): a new job, nothing to stop yet. */
    fun beginStart() {
      generation += 1
      stopRequested = false
    }

    /**
     * Stops the service from any thread without racing startForeground(): a running service shuts
     * down on the main thread; one still starting stops right after reaching the foreground.
     */
    fun requestStop() {
      stopRequested = true
      val gen = generation
      Handler(Looper.getMainLooper()).post {
        val svc = instance
        if (gen == generation && stopRequested && svc != null && svc.inForeground) svc.shutdown()
      }
    }
  }
}
