package app.sunlight.reader

import android.app.Activity
import android.content.Intent
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a saved translation to the system share sheet (open in a PDF viewer, save to Files, send).
 * The file stays in the app's own folder; the receiver gets read access to this one file only.
 * Called from Rust (src-tauri/src/mobile.rs) through JNI, hence @Keep.
 */
@Keep
object Share {
  @JvmStatic
  fun pdf(activity: Activity, path: String) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path))
    val send = Intent(Intent.ACTION_SEND)
      .setType("application/pdf")
      .putExtra(Intent.EXTRA_STREAM, uri)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    activity.startActivity(Intent.createChooser(send, null))
  }
}
