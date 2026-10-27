package net.arena.rafiq.owner

import android.util.Base64
import net.arena.rafiq.license.LicenseVerifier
import net.arena.rafiq.license.StoreLicenseVerifier
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.security.PrivateKey
import java.security.Signature
import java.util.Calendar

/** إصدار رخصة RFQ1 موقّعة. يطابق منطق التحقق في LicenseVerifier بالتطبيق الرئيسي. */
object LicenseIssuer {

    enum class Period(val label: String) { DAY("أيام"), MONTH("أشهر"), YEAR("سنوات") }

    fun expiry(fromMs: Long, amount: Int, period: Period): Long {
        val cal = Calendar.getInstance().apply { timeInMillis = fromMs }
        when (period) {
            Period.DAY -> cal.add(Calendar.DAY_OF_YEAR, amount)
            Period.MONTH -> cal.add(Calendar.MONTH, amount)
            Period.YEAR -> cal.add(Calendar.YEAR, amount)
        }
        return cal.timeInMillis
    }

    fun issue(
        priv: PrivateKey,
        deviceId: String,
        customerName: String,
        amount: Int,
        period: Period,
        nowMs: Long = System.currentTimeMillis(),
    ): String {
        val dev = deviceId.trim()
        val name = customerName.trim()
        require(dev.isNotEmpty() && dev.length <= 128) { "أدخل معرّف جهاز صالحاً" }
        require(name.isNotEmpty() && name.length <= 120) { "اكتب اسم المتجر (حتى 120 حرفاً)" }
        val maxAmount = when (period) {
            Period.DAY -> 3650
            Period.MONTH -> 120
            Period.YEAR -> 10
        }
        require(amount in 1..maxAmount) { "المدة غير صالحة؛ الحد الأقصى 10 سنوات" }
        val untilMs = expiry(nowMs, amount, period)
        require(untilMs > nowMs && untilMs / 1000 > nowMs / 1000) { "تاريخ انتهاء الرخصة غير صالح" }
        val payload = JSONObject()
            .put("v", LicenseVerifier.VERSION)
            .put("dev", dev)
            .put("name", name)
            .put("iat", nowMs / 1000)
            .put("exp", untilMs / 1000)
            .toString()
        val head = LicenseVerifier.PREFIX + "." + b64url(payload.toByteArray(Charsets.UTF_8))
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(priv)
            update(head.toByteArray(Charsets.US_ASCII))
            sign()
        }
        return head + "." + b64url(sig)
    }

    /**
     * إصدار RFQ2 واحد لمتجر كامل. معرّف المتجر يُنشأ من مشغّل منصة الاختبار أولاً.
     * إصدار النص لا يُنشئ عضوية أو مقعداً خادمياً، ولا يفعّل هاتفاً دون موافقة المالك.
     */
    fun issueStore(
        priv: PrivateKey,
        storeId: String,
        customerName: String,
        seats: Int,
        amount: Int,
        period: Period,
        nowMs: Long = System.currentTimeMillis(),
    ): String {
        val canonical = try {
            val raw = storeId.trim().lowercase(Locale.ROOT)
            UUID.fromString(raw).toString().takeIf { it == raw }
        } catch (_: Exception) { null }
        require(canonical != null) { "أدخل معرّف متجر موثّقاً بصيغة UUID" }
        val name = customerName.trim()
        require(name.isNotEmpty() && name.length <= 120) { "اكتب اسم المتجر (حتى 120 حرفاً)" }
        require(seats in 1..50) { "عدد الأجهزة المسموح بها غير صالح" }
        val maxAmount = when (period) {
            Period.DAY -> 3650
            Period.MONTH -> 120
            Period.YEAR -> 10
        }
        require(amount in 1..maxAmount) { "المدة غير صالحة؛ الحد الأقصى 10 سنوات" }
        val untilMs = expiry(nowMs, amount, period)
        require(nowMs > 0 && untilMs > nowMs && untilMs / 1000 > nowMs / 1000) {
            "تاريخ انتهاء الرخصة غير صالح"
        }
        val payload = JSONObject()
            .put("v", StoreLicenseVerifier.VERSION)
            .put("store", canonical)
            .put("name", name)
            .put("seats", seats)
            .put("iat", nowMs / 1000)
            .put("exp", untilMs / 1000)
            .toString()
        val head = StoreLicenseVerifier.PREFIX + "." + b64url(payload.toByteArray(Charsets.UTF_8))
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(priv)
            update(head.toByteArray(Charsets.US_ASCII))
            sign()
        }
        return head + "." + b64url(sig)
    }

    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
