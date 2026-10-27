package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KnaashReviewRulesTest {
    private val hash = "a".repeat(64)
    private val customers = listOf(
        KnaashReviewRules.Existing(11, "أحمد أول", "+967000000001", true, false),
        KnaashReviewRules.Existing(12, "زبون قديم", "", true, true),
        KnaashReviewRules.Existing(13, "غير نشط", "", false, false),
    )
    private fun draft(vararg choices: KnaashReviewRules.Choice) = KnaashReviewRules.Draft(
        hash, "2026-10-14", 3, choices.toList(),
    )

    @Test fun `لا تختار زبوناً تلقائياً ويسمح بجديد وموجود وصفر بعد مراجعة صريحة`() {
        val d = draft(
            KnaashReviewRules.Choice(1, "existing", customerId = 11),
            KnaashReviewRules.Choice(2, "new", name = "عميل اصطناعي", phone = "+967000000002"),
            KnaashReviewRules.Choice(3, "zero", reportedBalanceCents = 0),
        )
        assertNull(KnaashReviewRules.invalidReason(d, customers))
        assertNull(KnaashReviewRules.invalidReason(d.copy(choices = emptyList()), customers))
    }

    @Test fun `يرفض تكرار زبون موجود أو اسم أو هاتف في المسودة`() {
        val v = KnaashReviewRules.Choice(1, "existing", customerId = 11)
        assertTrue(KnaashReviewRules.invalidReason(draft(v, v.copy(index = 2)), customers)!!.contains("نفسه"))
        assertTrue(KnaashReviewRules.invalidReason(draft(v, v), customers)!!.contains("مكرر"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "new", name = "عميل جديد"),
            KnaashReviewRules.Choice(2, "new", name = "عميل  جَديد"),
        ), customers)!!.contains("يطابق"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "new", name = "ثالث", phone = "+967000000001"),
        ), customers)!!.contains("هاتف"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "new", name = "احمد اول"),
        ), customers)!!.contains("يطابق"))
    }

    @Test fun `لا يفتح رصيداً موجوداً حتى إن كان صفره الحالي ناتجاً عن حركات`() {
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "existing", customerId = 12),
        ), customers)!!.contains("حركات"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "existing", customerId = 13),
        ), customers)!!.contains("نشط"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "existing", customerId = 99),
        ), customers)!!.contains("غير موجود"))
    }

    @Test fun `الرصيد الصفري الحقيقي فقط يقبل خيار عدم نقل الدين`() {
        assertNull(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "zero", reportedBalanceCents = 0L),
        ), customers))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "zero", reportedBalanceCents = -100L),
        ), customers)!!.contains("صفر"))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(1, "zero"),
        ), customers)!!.contains("صفر"))
    }

    @Test fun `بصمة وتاريخ وعدد صفوف الكشف صحيحة قبل الحفظ`() {
        assertTrue(KnaashReviewRules.validSource(hash, "2026-10-14", 124))
        assertEquals(false, KnaashReviewRules.validSource("x".repeat(64), "2026-10-14", 124))
        assertEquals(false, KnaashReviewRules.validSource(hash, "2026-02-31", 124))
        assertEquals(false, KnaashReviewRules.validSource(hash, "2026-10-14", 0))
        assertTrue(KnaashReviewRules.invalidReason(draft(
            KnaashReviewRules.Choice(4, "new", name = "خارج التقرير"),
        ), customers)!!.contains("خارج"))
    }
}
