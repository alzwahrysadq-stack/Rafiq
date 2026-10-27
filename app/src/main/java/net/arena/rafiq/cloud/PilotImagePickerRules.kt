package net.arena.rafiq.cloud

import java.net.URI
import java.util.Locale

/** User-selected raster images only; no external-page picker or broad storage permission. */
object PilotImagePickerRules {
    const val MAX_BYTES: Long = 10L * 1024L * 1024L
    val MIME_TYPES = arrayOf("image/jpeg", "image/png", "image/webp")

    fun trustedPage(url: String?): Boolean = try {
        val u = URI(url.orEmpty())
        u.scheme == "https" && u.host == "appassets.androidplatform.net" &&
            u.port == -1 && u.rawUserInfo == null && u.rawQuery == null &&
            u.rawPath == "/assets/pilot/index.html"
    } catch (_: Exception) { false }

    fun accepts(uri: String?, mime: String?, size: Long): Boolean = try {
        val u = URI(uri.orEmpty())
        u.scheme == "content" && !u.rawAuthority.isNullOrBlank() && u.rawUserInfo == null &&
            mime?.lowercase(Locale.ROOT) in MIME_TYPES && size != 0L && size <= MAX_BYTES && size >= -1L
    } catch (_: Exception) { false }
}
