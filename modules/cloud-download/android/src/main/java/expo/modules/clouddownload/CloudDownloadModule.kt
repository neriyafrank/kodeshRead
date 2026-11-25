package expo.modules.clouddownload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkInfo
import androidx.work.WorkManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * JS bridge of the background download (src/services/backgroundDownload.ts):
 *   enqueue(taskJson) -> "enqueued" | "attached"   (the same task already queued / running is kept, never doubled)
 *   stop()                                          cancels the work; the partial bytes stay on disk
 *   status() -> JSON                                WorkInfo state + the worker's progress / error data + network
 *   isNetworkAvailable()
 * The state lives in WorkManager's own database (persisted across process death and reboots); JS polls status().
 */
class CloudDownloadModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CloudDownload")

    AsyncFunction("enqueue") { taskJson: String ->
      val ctx = context
      val spec = DownloadSpec.parse(taskJson) // validates before anything is queued
      val wm = WorkManager.getInstance(ctx)
      val tag = CloudDownloadWorker.TAG_TASK_PREFIX + spec.id
      val current = wm.getWorkInfosForUniqueWork(CloudDownloadWorker.UNIQUE_NAME).get()
      if (current.any { !it.state.isFinished && it.tags.contains(tag) }) return@AsyncFunction "attached"
      val request =
        OneTimeWorkRequest.Builder(CloudDownloadWorker::class.java)
          .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
          .setInputData(Data.Builder().putString(CloudDownloadWorker.KEY_SPEC, taskJson).build())
          .setBackoffCriteria(BackoffPolicy.LINEAR, 15, TimeUnit.SECONDS)
          .addTag(CloudDownloadWorker.TAG_ALL)
          .addTag(tag)
          .build()
      wm.enqueueUniqueWork(CloudDownloadWorker.UNIQUE_NAME, ExistingWorkPolicy.REPLACE, request).result.get()
      "enqueued"
    }

    AsyncFunction("stop") {
      val ctx = context
      WorkManager.getInstance(ctx).cancelUniqueWork(CloudDownloadWorker.UNIQUE_NAME).result.get()
      DownloadNotification.cancel(ctx)
      true
    }

    AsyncFunction("status") {
      statusJson(context)
    }

    Function("isNetworkAvailable") {
      CloudDownloadWorker.networkAvailable(context)
    }
  }

  private fun statusJson(ctx: Context): String {
    val o = JSONObject()
    o.put("network", CloudDownloadWorker.networkAvailable(ctx))
    val infos = WorkManager.getInstance(ctx).getWorkInfosForUniqueWork(CloudDownloadWorker.UNIQUE_NAME).get()
    val info = infos.lastOrNull { !it.state.isFinished } ?: infos.lastOrNull()
    if (info == null) {
      o.put("state", "NONE")
      return o.toString()
    }
    o.put("state", info.state.name)
    o.put("runAttempt", info.runAttemptCount)
    val task = info.tags.firstOrNull { it.startsWith(CloudDownloadWorker.TAG_TASK_PREFIX) }?.removePrefix(CloudDownloadWorker.TAG_TASK_PREFIX)
    o.put("task", task ?: JSONObject.NULL)
    val p = info.progress
    o.put("phase", p.getString(CloudDownloadWorker.KEY_PHASE) ?: JSONObject.NULL)
    o.put("fileIndex", p.getInt(CloudDownloadWorker.KEY_FILE_INDEX, -1))
    o.put("fileName", p.getString(CloudDownloadWorker.KEY_FILE_NAME) ?: JSONObject.NULL)
    o.put("fileBytes", p.getLong(CloudDownloadWorker.KEY_FILE_BYTES, 0L))
    o.put("attempt", p.getInt(CloudDownloadWorker.KEY_ATTEMPT, 0))
    o.put("delayMs", p.getLong(CloudDownloadWorker.KEY_DELAY_MS, 0L))
    o.put("reason", p.getString(CloudDownloadWorker.KEY_REASON) ?: JSONObject.NULL)
    if (info.state == WorkInfo.State.FAILED) {
      val out = info.outputData
      val e = JSONObject()
      e.put("code", out.getString(CloudDownloadWorker.KEY_ERR_CODE) ?: "engine")
      e.put("file", out.getString(CloudDownloadWorker.KEY_ERR_FILE) ?: JSONObject.NULL)
      e.put("httpStatus", out.getInt(CloudDownloadWorker.KEY_ERR_HTTP, 0))
      e.put("bytes", out.getLong(CloudDownloadWorker.KEY_ERR_BYTES, 0L))
      e.put("expected", out.getLong(CloudDownloadWorker.KEY_ERR_EXPECTED, 0L))
      e.put("reason", out.getString(CloudDownloadWorker.KEY_ERR_REASON) ?: "the download worker failed")
      e.put("attempts", out.getInt(CloudDownloadWorker.KEY_ERR_ATTEMPTS, 0))
      e.put("serverBytes", out.getLong(CloudDownloadWorker.KEY_ERR_SERVER_BYTES, -1L))
      e.put("host", out.getString(CloudDownloadWorker.KEY_ERR_HOST) ?: JSONObject.NULL)
      o.put("error", e)
    }
    return o.toString()
  }
}
