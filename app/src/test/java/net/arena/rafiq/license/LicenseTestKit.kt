package net.arena.rafiq.license

import android.util.Base64
import org.json.JSONObject
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature

/** أدوات اختبار: توليد زوج مفاتيح وتوقيع رخص بالطريقة نفسها التي يستخدمها تطبيق المالك. */
object LicenseTestKit {
    fun keyPair(): KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

    fun publicKeyB64(pair: KeyPair): String = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)

    fun token(pair: KeyPair, dev: String, iatMs: Long, expMs: Long, name: String = "متجر تجريبي"): String {
        val payload = JSONObject()
            .put("v", 1).put("dev", dev).put("name", name)
            .put("iat", iatMs / 1000).put("exp", expMs / 1000)
        return sign(pair, payload.toString())
    }

    fun sign(pair: KeyPair, payloadJson: String): String {
        val flags = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
        val head = LicenseVerifier.PREFIX + "." + Base64.encodeToString(payloadJson.toByteArray(Charsets.UTF_8), flags)
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private)
            update(head.toByteArray(Charsets.US_ASCII))
            sign()
        }
        return head + "." + Base64.encodeToString(sig, flags)
    }
}
