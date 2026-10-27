package net.arena.rafiq.license

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * التحقق من رخصة RFQ1 دون اتصال بالإنترنت.
 * الصيغة: RFQ1.<payload b64url>.<signature b64url>
 * payload = {"v":1,"dev":"<ANDROID_ID>","name":"…","iat":<ثوانٍ>,"exp":<ثوانٍ>}
 * التوقيع: SHA256withRSA على النص "RFQ1.<payload>" بالمفتاح الخاص للمالك (لا يغادر هاتفه).
 * هذا الملف مطابق لنسخته في تطبيق المالك (owner-app) — عدّل النسختين معاً.
 */
data class LicenseInfo(val name: String, val device: String, val issuedAt: Long, val expiresAt: Long)

data class LicenseResult(val ok: Boolean, val reason: String, val info: LicenseInfo? = null)

object LicenseVerifier {
    const val PREFIX = "RFQ1"
    const val VERSION = 1
    /** سماحية صغيرة لفرق الساعة بين الهاتف والخادم عند إصدار الرخصة */
    const val MAX_FUTURE_MS = 5 * 60_000L

    fun verify(token: String, publicKeyB64: String, deviceId: String, nowMs: Long): LicenseResult {
        if (publicKeyB64.isBlank()) return LicenseResult(false, "لم يُضبط مفتاح التحقق في هذا البناء")
        val parts = token.trim().split('.')
        if (parts.size != 3 || parts[0] != PREFIX) return LicenseResult(false, "صيغة الرخصة غير صحيحة")

        val publicKey = try {
            KeyFactory.getInstance("RSA").generatePublic(
                X509EncodedKeySpec(Base64.decode(publicKeyB64, Base64.DEFAULT)),
            )
        } catch (e: Exception) {
            return LicenseResult(false, "مفتاح التحقق في البناء غير صالح")
        }

        val signatureOk = try {
            Signature.getInstance("SHA256withRSA").run {
                initVerify(publicKey)
                update("${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII))
                verify(decodeB64Url(parts[2]))
            }
        } catch (e: Exception) {
            false
        }
        if (!signatureOk) return LicenseResult(false, "توقيع الرخصة غير صحيح")

        val json = try {
            JSONObject(String(decodeB64Url(parts[1]), Charsets.UTF_8))
        } catch (e: Exception) {
            return LicenseResult(false, "محتوى الرخصة تالف")
        }
        if (json.optInt("v") != VERSION) return LicenseResult(false, "إصدار الرخصة غير مدعوم")

        val dev = json.optString("dev")
        if (deviceId.isBlank() || dev != deviceId) return LicenseResult(false, "هذه الرخصة مُصدرة لجهاز آخر")

        val issuedAt = json.optLong("iat") * 1000
        val expiresAt = json.optLong("exp") * 1000
        if (issuedAt > nowMs + MAX_FUTURE_MS) return LicenseResult(false, "تاريخ الرخصة في المستقبل. صحّح ساعة الجهاز")
        if (expiresAt <= issuedAt) return LicenseResult(false, "تاريخ انتهاء الرخصة غير صالح")
        if (nowMs >= expiresAt) return LicenseResult(false, "انتهت صلاحية الرخصة")

        val info = LicenseInfo(json.optString("name"), dev, issuedAt, expiresAt)
        return LicenseResult(true, "الرخصة سارية", info)
    }

    private fun decodeB64Url(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP)
}
