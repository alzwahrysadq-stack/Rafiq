package net.arena.rafiq.owner

import android.util.Base64
import net.arena.rafiq.license.LicenseVerifier
import net.arena.rafiq.license.StoreLicenseVerifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyPairGenerator

/** مفاتيح عشوائية داخل الاختبار فقط؛ ليست مفتاح مالك التطبيق. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LicenseIssuerTest {
    private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val pub = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
    private val now = 1_781_000_000_000L

    @Test fun `رخصة أسبوع لجهاز واحد تتحقق وترفض جهازا آخر أو انتهاء المدة`() {
        val token = LicenseIssuer.issue(pair.private, "device-owner", "متجر تجربة", 7,
            LicenseIssuer.Period.DAY, now)
        val good = LicenseVerifier.verify(token, pub, "device-owner", now + 86_400_000L)
        assertTrue(good.reason, good.ok)
        assertEquals("متجر تجربة", good.info?.name)
        assertFalse(LicenseVerifier.verify(token, pub, "device-worker", now).ok)
        assertFalse(LicenseVerifier.verify(token, pub, "device-owner", now + 8L * 86_400_000L).ok)
        assertFalse(LicenseVerifier.verify(token + "x", pub, "device-owner", now).ok)
    }

    @Test fun `الاشتراك لمتجر واحد يحتاج تفعيل كل هاتف بمعرفه ولا تنتقل رخصة هاتف للعامل`() {
        val merchant = "متجر تجريبي"
        val owner = LicenseIssuer.issue(pair.private, "device-owner", merchant, 14,
            LicenseIssuer.Period.DAY, now)
        val worker = LicenseIssuer.issue(pair.private, "device-worker", merchant, 14,
            LicenseIssuer.Period.DAY, now)
        assertTrue(LicenseVerifier.verify(owner, pub, "device-owner", now).ok)
        assertTrue(LicenseVerifier.verify(worker, pub, "device-worker", now).ok)
        assertFalse(LicenseVerifier.verify(owner, pub, "device-worker", now).ok)
        assertFalse(LicenseVerifier.verify(worker, pub, "device-owner", now).ok)
    }

    @Test fun `المفتاح العام المختلف أو مدة مستقبلية في هاتف آخر لا يفتحان الرخصة`() {
        val token = LicenseIssuer.issue(pair.private, "device-owner", "متجر تجربة", 1,
            LicenseIssuer.Period.MONTH, now)
        val unrelated = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val otherPub = Base64.encodeToString(unrelated.public.encoded, Base64.NO_WRAP)
        assertFalse(LicenseVerifier.verify(token, otherPub, "device-owner", now).ok)
        assertFalse(LicenseVerifier.verify(token, pub, "device-owner", now - 10L * 60_000).ok)
    }

    @Test fun `الرخصة الموحدة تتحقق للمتجر نفسه دون ربطها بهاتف معين`() {
        val store = "12345678-1234-4234-8234-123456789abc"
        val another = "22345678-1234-4234-8234-123456789abc"
        val token = LicenseIssuer.issueStore(pair.private, store, "بقالة صنعاء", 3,
            14, LicenseIssuer.Period.DAY, now)
        val ownerPhone = StoreLicenseVerifier.verify(token, pub, store, now)
        val cashierPhone = StoreLicenseVerifier.verify(token, pub, store, now + 86_400_000L)
        assertTrue(ownerPhone.reason, ownerPhone.ok)
        assertTrue(cashierPhone.reason, cashierPhone.ok)
        assertEquals(3, ownerPhone.info?.seats)
        assertEquals(store, cashierPhone.info?.storeId)
        assertFalse(StoreLicenseVerifier.verify(token, pub, another, now).ok)
        assertFalse(StoreLicenseVerifier.verify(token + "x", pub, store, now).ok)
        assertFalse(StoreLicenseVerifier.verify(token, pub, store, now + 15L * 86_400_000L).ok)
        val unrelated = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val otherPub = Base64.encodeToString(unrelated.public.encoded, Base64.NO_WRAP)
        assertFalse(StoreLicenseVerifier.verify(token, otherPub, store, now).ok)
    }

    @Test fun `رفض رخصة متجر بمعرف غير موثق أو مقاعد فائضة`() {
        val store = "12345678-1234-4234-8234-123456789abc"
        fun invalid(id: String, seats: Int, amount: Int) = runCatching {
            LicenseIssuer.issueStore(pair.private, id, "صنعاء", seats,
                amount, LicenseIssuer.Period.DAY, now)
        }.isFailure
        assertTrue(invalid("wrong",2,14))
        assertTrue(invalid(store,0,14))
        assertTrue(invalid(store,51,14))
        assertTrue(invalid(store,2,3651))
        val token = LicenseIssuer.issueStore(pair.private, store, "صنعاء",2,
            1, LicenseIssuer.Period.DAY, now)
        assertFalse(StoreLicenseVerifier.verify(token,pub,"other-store",now).ok)
        assertFalse(StoreLicenseVerifier.verify(token,pub,store,now - 6 * 60_000L).ok)
    }

    @Test fun `يرفض اسم المتجر أو الجهاز الفارغ والمدة الفائضة`() {
        fun invalid(dev: String, name: String, amount: Int, period: LicenseIssuer.Period) =
            runCatching { LicenseIssuer.issue(pair.private, dev, name, amount, period, now) }.isFailure
        assertTrue(invalid("device-owner", "  ", 1, LicenseIssuer.Period.DAY))
        assertTrue(invalid("   ", "متجر", 1, LicenseIssuer.Period.DAY))
        assertTrue(invalid("device-owner", "متجر", 0, LicenseIssuer.Period.DAY))
        assertTrue(invalid("device-owner", "متجر", Int.MAX_VALUE, LicenseIssuer.Period.YEAR))
        assertTrue(invalid("device-owner", "متجر", 121, LicenseIssuer.Period.MONTH))
        assertTrue(invalid("device-owner", "متجر", 11, LicenseIssuer.Period.YEAR))
        assertTrue(invalid("device-owner", "متجر", 3651, LicenseIssuer.Period.DAY))
    }
}
