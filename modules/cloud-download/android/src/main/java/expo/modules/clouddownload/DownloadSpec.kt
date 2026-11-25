package expo.modules.clouddownload

import android.net.Uri
import org.json.JSONObject

/** One file of a download task: `url` is streamed into `partial`, renamed to `target` once it has `size` bytes. */
internal data class FileSpec(
  val name: String,
  val url: String,
  val partial: String,
  val target: String,
  val size: Long,
)

/**
 * The task the JS controller enqueues (shared/cloudDownload.js engine contract, serialized by
 * src/services/backgroundDownload.ts): `{ id, title, files: [{ name, url, partial, target, size }] }`.
 * Paths may be `file://` URIs (expo-file-system) or plain absolute paths.
 */
internal data class DownloadSpec(
  val id: String,
  val title: String,
  val files: List<FileSpec>,
) {
  val totalBytes: Long
    get() = files.fold(0L) { acc, f -> acc + f.size }

  /** Bytes of the files before `index` (they are complete when the worker reaches `index`). */
  fun bytesBefore(index: Int): Long {
    var sum = 0L
    for (i in 0 until index.coerceAtMost(files.size)) sum += files[i].size
    return sum
  }

  companion object {
    fun parse(json: String?): DownloadSpec {
      require(!json.isNullOrEmpty()) { "empty download task" }
      val o = JSONObject(json)
      val id = o.getString("id")
      val arr = o.getJSONArray("files")
      val files = ArrayList<FileSpec>(arr.length())
      for (i in 0 until arr.length()) {
        val f = arr.getJSONObject(i)
        val size = f.getLong("size")
        require(size > 0) { "file ${f.optString("name")} has no size" }
        val url = f.getString("url")
        require(url.startsWith("https://") || url.startsWith("http://")) { "file ${f.optString("name")} has no http(s) URL" }
        files.add(FileSpec(f.getString("name"), url, toPath(f.getString("partial")), toPath(f.getString("target")), size))
      }
      require(files.isNotEmpty()) { "download task has no files" }
      return DownloadSpec(id, o.optString("title", "מוריד ספרייה מהענן…"), files)
    }

    /** `file:///data/user/0/…/x.partial` (expo-file-system URI) -> `/data/user/0/…/x.partial`. */
    fun toPath(value: String): String {
      if (!value.startsWith("file:")) return value
      return Uri.parse(value).path ?: value.removePrefix("file://")
    }
  }
}
