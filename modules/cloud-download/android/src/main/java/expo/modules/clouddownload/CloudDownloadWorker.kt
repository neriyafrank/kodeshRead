package expo.modules.clouddownload

import android.content.Context
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL
import java.util.Locale
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * The OS-managed download of the cloud library parts (WorkManager, unique work [UNIQUE_NAME]).
 *
 * WorkManager persists the request, so the transfer continues with the screen off, the app in the background or its
 * process killed, and is rescheduled after a reboot. The request carries a CONNECTED network constraint: when the
 * network goes away WorkManager stops the worker and starts it again once the network is back. The worker runs as a
 * long-running worker in WorkManager's foreground service (type dataSync, plugins/withCloudDownload.js) with its own
 * progress notification.
 *
 * Every file is streamed straight into `<part>.partial` (FileOutputStream in append mode, fsync every 16 MB); a later
 * run continues it with `Range: bytes=<size on disk>-`. Redirects (GitHub release asset -> signed CDN URL) are followed
 * by hand so the Range header is sent again to every hop. Bytes on disk are never deleted on a network error.
 * Transient failures (resets, timeouts, 5xx / 408 / 429, DNS) retry with exponential backoff (2 s .. 30 s); the budget
 * of [MAX_ATTEMPTS] consecutive attempts without a new byte is refilled by any progress. Offline = a waiting state
 * (not an attempt). Fatal failures (HTTP 4xx, a size that disagrees with the manifest, disk errors) end the work with
 * a diagnostic in its output data. SHA-256 verification is done by the JS controller (shared/cloudDownload.js).
 */
class CloudDownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  @Volatile private var connection: HttpURLConnection? = null
  private var spec: DownloadSpec? = null
  private var lastProgressAt = 0L
  private var lastNotifyAt = 0L
  private var lastHost: String? = null

  private class Fatal(val code: String, val httpStatus: Int = 0, val reason: String? = null, val serverBytes: Long = -1L) : Exception(reason ?: code)

  private class Counters {
    var restarts = 0
  }

  private sealed class Outcome {
    object Done : Outcome()
    object Stopped : Outcome()
    class Failed(val data: Data) : Outcome()
  }

  override fun doWork(): Result {
    val task =
      try {
        DownloadSpec.parse(inputData.getString(KEY_SPEC))
      } catch (e: Exception) {
        return Result.failure(errorData("engine", null, 0, 0L, 0L, "bad download task: ${e.message}", 0, -1L))
      }
    spec = task
    // Exactly one transfer writes the partial files at a time: a REPLACEd worker may still be unwinding.
    while (!LOCK.tryAcquire(1, TimeUnit.SECONDS)) {
      if (isStopped) return Result.failure()
    }
    try {
      startForeground(task)
      for ((index, file) in task.files.withIndex()) {
        if (isStopped) return Result.failure()
        when (val outcome = transferFile(task, index, file)) {
          is Outcome.Stopped -> return Result.failure()
          is Outcome.Failed -> return Result.failure(outcome.data)
          is Outcome.Done -> Unit
        }
      }
      val last = task.files.last()
      publish(PHASE_COMPLETED, task.files.size - 1, last.name, last.size, force = true)
      return Result.success(Data.Builder().putString(KEY_TASK, task.id).build())
    } catch (e: Exception) {
      Log.w(TAG, "download worker crashed", e)
      return Result.failure(errorData("engine", null, 0, 0L, 0L, e.javaClass.simpleName + ": " + (e.message ?: ""), 0, -1L))
    } finally {
      LOCK.release()
    }
  }

  /** WorkManager stops the work (pause, network constraint lost, OS): unblock a read in progress. */
  override fun onStopped() {
    super.onStopped()
    try {
      connection?.disconnect()
    } catch (e: Exception) {
      // already closed
    }
  }

  private fun transferFile(task: DownloadSpec, index: Int, f: FileSpec): Outcome {
    val partial = File(f.partial)
    val target = File(f.target)
    partial.parentFile?.mkdirs()
    val counters = Counters()
    var failures = 0
    while (true) {
      if (isStopped) return Outcome.Stopped
      if (target.exists() && target.length() == f.size) return Outcome.Done
      if (target.exists()) target.delete() // a wrong-size leftover never counts
      var have = if (partial.exists()) partial.length() else 0L
      if (have > f.size) {
        partial.delete() // cannot be a prefix of this file
        have = 0L
      }
      if (have == f.size) {
        if (target.exists()) target.delete()
        if (!partial.renameTo(target)) return Outcome.Failed(errorData("disk", f.name, 0, have, f.size, "rename of ${partial.name} failed", 0, -1L))
        return Outcome.Done
      }
      publish(PHASE_RUNNING, index, f.name, have, force = true)
      var error: Throwable? = null
      try {
        fetchInto(task, index, f, partial, have, counters)
      } catch (e: Fatal) {
        if (isStopped) return Outcome.Stopped
        val now = if (partial.exists()) partial.length() else 0L
        return Outcome.Failed(errorData(e.code, f.name, e.httpStatus, now, f.size, e.reason, 0, e.serverBytes))
      } catch (e: MalformedURLException) {
        return Outcome.Failed(errorData("http", f.name, 0, have, f.size, "bad URL: ${e.message}", 0, -1L))
      } catch (e: IOException) {
        if (isStopped) return Outcome.Stopped
        error = e
      } catch (e: RuntimeException) {
        if (isStopped) return Outcome.Stopped
        error = e
      }
      if (isStopped) return Outcome.Stopped
      val after = if (partial.exists()) partial.length() else 0L
      if (after > have) failures = 0 // progress refills the retry budget: a flaky link is never abandoned
      if (error == null && after >= f.size) continue // complete: renamed at the top of the loop
      val reason = if (error != null) (error.message ?: error.javaClass.simpleName) else "short body ($after of ${f.size} bytes)"
      if (!networkAvailable(applicationContext)) {
        // Offline (airplane mode, Wi-Fi -> cellular gap): a clean waiting state, not an attempt. WorkManager usually
        // stops this worker for its CONNECTED constraint and restarts it when the network is back; else wait here.
        publish(PHASE_WAITING, index, f.name, after, reason = reason, force = true)
        while (!isStopped && !networkAvailable(applicationContext)) sleepQuietly(1000L)
        continue
      }
      if (failures >= MAX_ATTEMPTS) {
        return Outcome.Failed(errorData("network", f.name, 0, after, f.size, reason, failures + 1, -1L))
      }
      val delayMs = backoffMs(failures)
      failures++
      publish(PHASE_RETRYING, index, f.name, after, reason = reason, attempt = failures, delayMs = delayMs, force = true)
      var left = delayMs
      while (left > 0 && !isStopped) {
        sleepQuietly(minOf(250L, left))
        left -= 250L
      }
    }
  }

  /** One HTTP exchange appended to the partial. Throws [Fatal] for unrecoverable answers, IOException when transient. */
  private fun fetchInto(task: DownloadSpec, index: Int, f: FileSpec, partial: File, offset: Long, counters: Counters) {
    var url = URL(f.url)
    var conn: HttpURLConnection
    var hops = 0
    while (true) {
      conn = url.openConnection() as HttpURLConnection
      conn.instanceFollowRedirects = false
      conn.connectTimeout = CONNECT_TIMEOUT_MS
      conn.readTimeout = READ_TIMEOUT_MS
      conn.useCaches = false
      // identity: a transparently gzipped body would break byte offsets.
      conn.setRequestProperty("Accept-Encoding", "identity")
      conn.setRequestProperty("User-Agent", USER_AGENT)
      if (offset > 0L) conn.setRequestProperty("Range", "bytes=$offset-")
      connection = conn
      if (isStopped) {
        conn.disconnect()
        return
      }
      val code = conn.responseCode
      if (code in 300..399 && code != 304) {
        val location = conn.getHeaderField("Location")
        conn.disconnect()
        if (location.isNullOrEmpty()) throw Fatal("http", code, "redirect without Location")
        hops++
        if (hops > MAX_REDIRECTS) throw Fatal("http", code, "too many redirects")
        url = URL(url, location) // the next hop gets the SAME Range header
        continue
      }
      break
    }
    lastHost = url.host
    try {
      val code = conn.responseCode
      if (code == 416) {
        // Our offset is past the end of the server's file: the partial is not a prefix of it. Start over once.
        if (counters.restarts++ >= 1) throw Fatal("range", code, "HTTP 416 twice")
        partial.delete()
        return
      }
      if (code == 408 || code == 429 || code >= 500) throw IOException("HTTP $code")
      if (code != 200 && code != 206) throw Fatal("http", code)
      var append = false
      if (code == 206) {
        val range = parseContentRange(conn.getHeaderField("Content-Range"))
        val start = range?.first ?: offset
        val serverTotal = range?.second ?: -1L
        if (serverTotal >= 0L && serverTotal != f.size) throw Fatal("size", code, null, serverTotal)
        if (start != offset && start != 0L) throw Fatal("range", code, "Content-Range starts at $start, expected $offset")
        append = start > 0L
      } else {
        val length = conn.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
        if (length > 0L && length != f.size) throw Fatal("size", code, null, length)
        // The server ignored Range (or a proxy stripped it): the body is the whole file, written from the start.
        if (offset > 0L && counters.restarts++ >= 2) throw Fatal("range", code, "the server ignores Range (HTTP 200)")
      }
      var written = if (append) offset else 0L
      val out =
        try {
          FileOutputStream(partial, append)
        } catch (e: IOException) {
          throw Fatal("disk", 0, e.message)
        }
      try {
        conn.inputStream.use { input ->
          val buffer = ByteArray(BUFFER_BYTES)
          var sinceSync = 0L
          while (!isStopped) {
            val n = input.read(buffer)
            if (n < 0) break
            if (written + n > f.size) throw Fatal("size", code, "the server sent more bytes than the manifest size", written + n)
            try {
              out.write(buffer, 0, n)
            } catch (e: IOException) {
              throw Fatal("disk", 0, e.message)
            }
            written += n
            sinceSync += n
            if (sinceSync >= SYNC_BYTES) {
              syncQuietly(out)
              sinceSync = 0L
            }
            publish(PHASE_RUNNING, index, f.name, written)
          }
        }
      } finally {
        syncQuietly(out)
        try {
          out.close()
        } catch (e: IOException) {
          // the bytes are flushed by the sync above
        }
      }
    } finally {
      connection = null
      conn.disconnect()
    }
  }

  /** Progress for the JS controller (WorkInfo.progress) and the notification, throttled unless `force`. */
  private fun publish(phase: String, index: Int, name: String, bytes: Long, reason: String? = null, attempt: Int = 0, delayMs: Long = 0L, force: Boolean = false) {
    val task = spec ?: return
    val now = SystemClock.elapsedRealtime()
    if (force || now - lastProgressAt >= PROGRESS_MS) {
      lastProgressAt = now
      val data =
        Data.Builder()
          .putString(KEY_TASK, task.id)
          .putString(KEY_PHASE, phase)
          .putInt(KEY_FILE_INDEX, index)
          .putString(KEY_FILE_NAME, name)
          .putLong(KEY_FILE_BYTES, bytes)
          .putInt(KEY_ATTEMPT, attempt)
          .putLong(KEY_DELAY_MS, delayMs)
          .putString(KEY_REASON, reason)
          .build()
      try {
        setProgressAsync(data)
      } catch (e: Exception) {
        // the work is finishing
      }
    }
    if (force || now - lastNotifyAt >= NOTIFY_MS) {
      lastNotifyAt = now
      DownloadNotification.notify(applicationContext, notification(task, phase, index, task.bytesBefore(index) + bytes))
    }
  }

  private fun notification(task: DownloadSpec, phase: String, index: Int, done: Long): android.app.Notification {
    val total = task.totalBytes
    val pct = if (total > 0L) ((done.coerceIn(0L, total) * 100L) / total).toInt() else 0
    val title =
      when (phase) {
        PHASE_WAITING -> "ממתין לחיבור לרשת…"
        PHASE_RETRYING -> "הרשת נותקה זמנית — מנסה להמשיך הורדה…"
        else -> "${task.title} $pct%"
      }
    val text = "חלק ${index + 1} מתוך ${task.files.size} · ${formatBytes(done)} / ${formatBytes(total)}"
    val pause =
      try {
        WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
      } catch (e: Exception) {
        null
      }
    return DownloadNotification.build(applicationContext, title, text, done, total, pause)
  }

  /** Long-running worker: WorkManager's foreground service keeps the process (and the transfer) alive. */
  private fun startForeground(task: DownloadSpec) {
    val n = notification(task, PHASE_RUNNING, 0, 0L)
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ForegroundInfo(DownloadNotification.NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        ForegroundInfo(DownloadNotification.NOTIFICATION_ID, n)
      }
    try {
      setForegroundAsync(info).get(10, TimeUnit.SECONDS)
    } catch (e: Exception) {
      // Android 12+ refuses a foreground service started from the background (e.g. after a reboot): the worker
      // still runs (WorkManager reschedules it if the OS stops it) and resumes from the bytes on disk.
      Log.w(TAG, "foreground service unavailable; downloading as regular background work", e)
    }
  }

  private fun errorData(code: String, file: String?, httpStatus: Int, bytes: Long, expected: Long, reason: String?, attempts: Int, serverBytes: Long): Data =
    Data.Builder()
      .putString(KEY_TASK, spec?.id)
      .putString(KEY_ERR_CODE, code)
      .putString(KEY_ERR_FILE, file)
      .putInt(KEY_ERR_HTTP, httpStatus)
      .putLong(KEY_ERR_BYTES, bytes)
      .putLong(KEY_ERR_EXPECTED, expected)
      .putString(KEY_ERR_REASON, reason?.take(400))
      .putInt(KEY_ERR_ATTEMPTS, attempts)
      .putLong(KEY_ERR_SERVER_BYTES, serverBytes)
      .putString(KEY_ERR_HOST, lastHost)
      .build()

  companion object {
    private const val TAG = "CloudDownloadWorker"
    const val UNIQUE_NAME = "kodeshread-cloud-download"
    const val TAG_ALL = "kodeshread-cloud-download"
    const val TAG_TASK_PREFIX = "task:"

    const val KEY_SPEC = "spec"
    const val KEY_TASK = "task"
    const val KEY_PHASE = "phase"
    const val KEY_FILE_INDEX = "fileIndex"
    const val KEY_FILE_NAME = "fileName"
    const val KEY_FILE_BYTES = "fileBytes"
    const val KEY_ATTEMPT = "attempt"
    const val KEY_DELAY_MS = "delayMs"
    const val KEY_REASON = "reason"
    const val KEY_ERR_CODE = "errCode"
    const val KEY_ERR_FILE = "errFile"
    const val KEY_ERR_HTTP = "errHttp"
    const val KEY_ERR_BYTES = "errBytes"
    const val KEY_ERR_EXPECTED = "errExpected"
    const val KEY_ERR_REASON = "errReason"
    const val KEY_ERR_ATTEMPTS = "errAttempts"
    const val KEY_ERR_SERVER_BYTES = "errServerBytes"
    const val KEY_ERR_HOST = "errHost"

    const val PHASE_RUNNING = "running"
    const val PHASE_RETRYING = "retrying"
    const val PHASE_WAITING = "waiting_for_network"
    const val PHASE_COMPLETED = "completed"

    private const val MAX_ATTEMPTS = 8
    private const val MAX_REDIRECTS = 10
    private const val CONNECT_TIMEOUT_MS = 30_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val BUFFER_BYTES = 256 * 1024
    private const val SYNC_BYTES = 16L * 1024 * 1024
    private const val PROGRESS_MS = 400L
    private const val NOTIFY_MS = 1000L
    private const val USER_AGENT = "kodeshRead-cloud-download/1.0 (Android)"

    private val LOCK = Semaphore(1)

    /** 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, ... (shared/cloudDownload.js backoffDelayMs). */
    fun backoffMs(attempt: Int): Long = minOf(30_000L, 2_000L shl attempt.coerceIn(0, 10))

    /** `bytes 100-999/1000` -> (100, 1000); total -1 for `*`; null when absent / unparsable. */
    fun parseContentRange(value: String?): Pair<Long, Long>? {
      if (value == null) return null
      val m = Regex("""^\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*$""", RegexOption.IGNORE_CASE).find(value) ?: return null
      val start = m.groupValues[1].toLongOrNull() ?: return null
      val total = if (m.groupValues[3] == "*") -1L else (m.groupValues[3].toLongOrNull() ?: -1L)
      return Pair(start, total)
    }

    /** A validated internet connection (not just "connected" to a captive Wi-Fi). */
    fun networkAvailable(context: Context): Boolean {
      return try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      } catch (e: Exception) {
        true // unknown: let the transfer itself find out
      }
    }

    fun formatBytes(n: Long): String {
      val gb = 1024.0 * 1024.0 * 1024.0
      val mb = 1024.0 * 1024.0
      return if (n >= gb) String.format(Locale.US, "%.1f GB", n / gb) else "${Math.round(n / mb)} MB"
    }

    private fun syncQuietly(out: FileOutputStream) {
      try {
        out.flush()
        out.fd.sync()
      } catch (e: IOException) {
        // best effort: the bytes are in the page cache
      }
    }

    private fun sleepQuietly(ms: Long) {
      try {
        Thread.sleep(ms)
      } catch (e: InterruptedException) {
        // a stop request: every loop re-checks isStopped right after
      }
    }
  }
}
