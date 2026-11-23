package expo.modules.importforegroundservice

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge: start / update / stop the import foreground service.
 * update() re-posts the notification directly (no service intent per progress tick).
 */
class ImportForegroundServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ImportForegroundService")

    AsyncFunction("start") { title: String, text: String, current: Int, total: Int ->
      val ctx = context
      val intent = Intent(ctx, ImportForegroundService::class.java).apply {
        action = ImportForegroundService.ACTION_START
        putExtra(ImportForegroundService.EXTRA_TITLE, title)
        putExtra(ImportForegroundService.EXTRA_TEXT, text)
        putExtra(ImportForegroundService.EXTRA_CURRENT, current)
        putExtra(ImportForegroundService.EXTRA_TOTAL, total)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      true
    }

    AsyncFunction("update") { title: String, text: String, current: Int, total: Int ->
      if (!ImportForegroundService.running) return@AsyncFunction false
      val ctx = context
      ImportNotification.notify(ctx, ImportNotification.build(ctx, title, text, current, total))
      true
    }

    AsyncFunction("stop") {
      val ctx = context
      ctx.stopService(Intent(ctx, ImportForegroundService::class.java))
      true
    }

    Function("isRunning") {
      ImportForegroundService.running
    }
  }
}
