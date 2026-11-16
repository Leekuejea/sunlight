package app.sunlight.reader

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.Keep
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * API keys at rest. Each value is AES-GCM encrypted with a key that is generated in, and never leaves,
 * the Android Keystore; only the ciphertext is written to the app's private preferences.
 * Called from Rust (src-tauri/src/store.rs) through JNI, hence @Keep.
 */
@Keep
object SecretStore {
  private const val ALIAS = "sunlight-api-keys"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  private fun prefs(context: Context) = context.getSharedPreferences("secrets", Context.MODE_PRIVATE)

  @JvmStatic
  fun set(context: Context, id: String, value: String) {
    val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)) // 12-byte IV, then ciphertext + tag
    prefs(context).edit().putString(id, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  /** The saved value, or "" when there is none or it can no longer be decrypted (restored onto another device). */
  @JvmStatic
  fun get(context: Context, id: String): String {
    val sealed = prefs(context).getString(id, null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return ""
    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12)) }
      String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)
    } catch (e: Exception) {
      ""
    }
  }

  @JvmStatic
  fun delete(context: Context, id: String) {
    prefs(context).edit().remove(id).apply()
  }
}
