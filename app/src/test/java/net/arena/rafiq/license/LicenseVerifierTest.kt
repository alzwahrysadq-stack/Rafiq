package net.arena.rafiq.license

import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LicenseVerifierTest {

    private val pair = LicenseTestKit.keyPair()
    private val pub = LicenseTestKit.publicKeyB64(pair)
    private val now = 1_800_000_000_000L
    private val day = 86_400_000L

    @Test
    fun validTokenForThisDeviceIsAccepted() {
        val t = LicenseTestKit.token(pair, "DEV-1", now - day, now + 30 * day)
        val r = LicenseVerifier.verify(t, pub, "DEV-1", now)
        assertTrue(r.ok)
        assertEquals("متجر تجريبي", r.info!!.name)
    }

    @Test
    fun tokenForAnotherDeviceIsRejected() {
        val t = LicenseTestKit.token(pair, "DEV-1", now - day, now + 30 * day)
        assertFalse(LicenseVerifier.verify(t, pub, "DEV-2", now).ok)
    }

    @Test
    fun expiredTokenIsRejected() {
        val t = LicenseTestKit.token(pair, "DEV-1", now - 60 * day, now - day)
        assertFalse(LicenseVerifier.verify(t, pub, "DEV-1", now).ok)
    }

    @Test
    fun tamperedPayloadIsRejected() {
        val good = LicenseTestKit.token(pair, "DEV-1", now - day, now + 30 * day)
        val parts = good.split('.')
        val forged = JSONObject().put("v", 1).put("dev", "DEV-1").put("name", "x")
            .put("iat", (now - day) / 1000).put("exp", (now + 3650 * day) / 1000).toString()
        val flags = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
        val newPayload = Base64.encodeToString(forged.toByteArray(), flags)
        val r = LicenseVerifier.verify("${parts[0]}.$newPayload.${parts[2]}", pub, "DEV-1", now)
        assertFalse(r.ok)
        assertEquals("توقيع الرخصة غير صحيح", r.reason)
    }

    @Test
    fun tokenSignedByAnotherKeyIsRejected() {
        val other = LicenseTestKit.keyPair()
        val t = LicenseTestKit.token(other, "DEV-1", now - day, now + 30 * day)
        assertFalse(LicenseVerifier.verify(t, pub, "DEV-1", now).ok)
    }

    @Test
    fun wrongFormatIsRejected() {
        assertFalse(LicenseVerifier.verify("hello", pub, "DEV-1", now).ok)
        assertFalse(LicenseVerifier.verify("RFQ2.a.b", pub, "DEV-1", now).ok)
    }

    @Test
    fun missingPublicKeyRejectsEverything() {
        val t = LicenseTestKit.token(pair, "DEV-1", now - day, now + 30 * day)
        assertFalse(LicenseVerifier.verify(t, "", "DEV-1", now).ok)
    }

    @Test
    fun issuedInTheFarFutureIsRejected() {
        val t = LicenseTestKit.token(pair, "DEV-1", now + 10 * day, now + 40 * day)
        assertFalse(LicenseVerifier.verify(t, pub, "DEV-1", now).ok)
    }
}
