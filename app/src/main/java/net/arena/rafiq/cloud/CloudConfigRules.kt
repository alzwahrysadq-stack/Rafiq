package net.arena.rafiq.cloud

import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Locale

/** Client-side input guard. This does NOT authenticate a store or enable synchronization. */
object CloudConfigRules {
    private val projectHost = Regex("^[a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])\\.supabase\\.co$")
    private val publishable = Regex("^sb_publishable_[A-Za-z0-9_-]{20,512}$")
    private val jwtChars = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")

    fun projectUrl(raw: String): String {
        val candidate = raw.trim()
        if (candidate.length !in 20..160) throw IllegalArgumentException("invalid_project_url")
        val uri = try { URI(candidate) } catch (_: Exception) { throw IllegalArgumentException("invalid_project_url") }
        val host = uri.host?.lowercase(Locale.ROOT)
        if (uri.scheme != "https" || host == null || !projectHost.matches(host) ||
            uri.rawUserInfo != null || uri.port != -1 || uri.rawQuery != null || uri.rawFragment != null ||
            (uri.rawPath != null && uri.rawPath != "" && uri.rawPath != "/") ||
            uri.rawAuthority != host) {
            throw IllegalArgumentException("invalid_project_url")
        }
        return "https://$host"
    }

    fun publishableKey(raw: String): String {
        val candidate = raw.trim()
        if (candidate.length !in 32..4096 || candidate.any { it.code < 33 || it.code > 126 }) {
            throw IllegalArgumentException("invalid_publishable_key")
        }
        if (publishable.matches(candidate)) return candidate
        // The older anon key is a JWT. Reject service_role JWTs and non-anon payloads.
        if (!jwtChars.matches(candidate)) throw IllegalArgumentException("invalid_publishable_key")
        val parts = candidate.split('.')
        val payload = try {
            JSONObject(String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP), StandardCharsets.UTF_8))
        } catch (_: Exception) { throw IllegalArgumentException("invalid_publishable_key") }
        if (payload.optString("role") != "anon") throw IllegalArgumentException("invalid_publishable_key")
        val expiry = payload.optLong("exp", 0)
        if (expiry != 0L && expiry <= System.currentTimeMillis() / 1000L) {
            throw IllegalArgumentException("invalid_publishable_key")
        }
        return candidate
    }
}

data class CloudConfiguration(val projectUrl: String, val publishableKey: String, val storeBindingId: String)

interface CloudConfigurationStorage {
    /** Only the owner page should call save; Android Keystore encryption is enforced by the implementation. */
    fun save(storeBindingId: String, projectUrl: String, publishableKey: String)
    /** Throws if an existing encrypted record is corrupt, missing its Keystore key or bound to another store. */
    fun read(storeBindingId: String): CloudConfiguration?
}
