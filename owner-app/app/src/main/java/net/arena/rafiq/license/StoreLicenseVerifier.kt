package net.arena.rafiq.license

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Locale
import java.util.UUID

/**
 * RFQ2 is one signed STORE license shared between its devices (not an Android ID).
 * It is not an authorization token. The server must separately confirm membership,
 * subscription status and the approved-device seat limit on EVERY financial action.
 * Keep this file byte-for-byte identical in owner-app until there is a shared module.
 */
data class StoreLicenseInfo(
    val storeId: String,
    val name: String,
    val seats: Int,
    val issuedAt: Long,
    val expiresAt: Long,
)

data class StoreLicenseResult(
    val ok: Boolean,
    val reason: String,
    val info: StoreLicenseInfo? = null,
)

object StoreLicenseVerifier {
    const val PREFIX = "RFQ2"
    const val VERSION = 2
    private const val MAX_FUTURE_MS = 5 * 60_000L
    private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

    fun verify(token: String, publicKeyB64: String, expectedStoreId: String, nowMs: Long): StoreLicenseResult {
        if (publicKeyB64.isBlank()) return StoreLicenseResult(false, "مفتاح التحقق العام غير مهيأ")
        val expected = canonicalStoreId(expectedStoreId)
            ?: return StoreLicenseResult(false, "معرّف المتجر الموثق غير صالح")
        val source = token.trim()
        if (source.length !in 24..8192) return StoreLicenseResult(false, "صيغة الرخصة غير صحيحة")
        val parts = source.split('.')
        if (parts.size != 3 || parts[0] != PREFIX ||
            parts[1].length > 4096 || parts[2].length > 2048 ||
            !BASE64URL.matches(parts[1]) || !BASE64URL.matches(parts[2])) {
            return StoreLicenseResult(false, "صيغة الرخصة غير صحيحة")
        }
        val pub = try {
            KeyFactory.getInstance("RSA").generatePublic(
                X509EncodedKeySpec(Base64.decode(publicKeyB64, Base64.DEFAULT)),
            ) as? RSAPublicKey
        } catch (_: Exception) { null }
        if (pub == null || pub.modulus.bitLength() < 2048) {
            return StoreLicenseResult(false, "مفتاح التحقق العام غير صالح")
        }
        val signed = "${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII)
        val signatureOk = try {
            Signature.getInstance("SHA256withRSA").run {
                initVerify(pub)
                update(signed)
                verify(Base64.decode(parts[2], Base64.URL_SAFE or Base64.NO_WRAP))
            }
        } catch (_: Exception) { false }
        if (!signatureOk) return StoreLicenseResult(false, "توقيع الرخصة غير صحيح")

        val json = try {
            JSONObject(String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8))
        } catch (_: Exception) { return StoreLicenseResult(false, "محتوى الرخصة تالف") }
        if (json.optInt("v") != VERSION) return StoreLicenseResult(false, "إصدار الرخصة غير مدعوم")
        val store = canonicalStoreId(json.optString("store"))
        if (store == null || store != expected) return StoreLicenseResult(false, "الرخصة تخص متجراً آخر")
        val name = json.optString("name").trim()
        val seats = json.optInt("seats", 0)
        if (name.length !in 1..120 || seats !in 1..50) {
            return StoreLicenseResult(false, "اسم المتجر أو مقاعد الرخصة غير صالحة")
        }
        val iat = json.optLong("iat", 0)
        val exp = json.optLong("exp", 0)
        val issued = try { Math.multiplyExact(iat, 1000L) } catch (_: ArithmeticException) { 0L }
        val expires = try { Math.multiplyExact(exp, 1000L) } catch (_: ArithmeticException) { 0L }
        if (nowMs < 0 || issued <= 0 || expires <= issued ||
            issued - nowMs > MAX_FUTURE_MS || nowMs >= expires) {
            return StoreLicenseResult(false, "تاريخ الرخصة غير صالح أو انتهى")
        }
        return StoreLicenseResult(true, "رخصة المتجر سارية", StoreLicenseInfo(store, name, seats, issued, expires))
    }

    private fun canonicalStoreId(value: String): String? = try {
        val normalized = value.trim().lowercase(Locale.ROOT)
        UUID.fromString(normalized).toString().takeIf { it == normalized }
    } catch (_: Exception) { null }
}
