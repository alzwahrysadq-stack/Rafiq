package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MoneyTest {

    @Test
    fun `التقريب إلى أقرب ريال والنصف للأعلى`() {
        assertEquals(1000L, Money.toWhole(1000L))
        assertEquals(1000L, Money.toWhole(1049L))   // 10.49 → 10
        assertEquals(1100L, Money.toWhole(1050L))   // 10.50 → 11 (النصف للأعلى)
        assertEquals(1100L, Money.toWhole(1051L))   // 10.51 → 11
        assertEquals(0L, Money.toWhole(0L))
    }

    @Test
    fun `التقريب مع المبالغ السالبة يحافظ على الإشارة`() {
        assertEquals(-1000L, Money.toWhole(-1049L))
        assertEquals(-1100L, Money.toWhole(-1050L))
    }

    @Test
    fun `التحليل يقبل الفواصل والأرقام العربية`() {
        assertEquals(125000L, Money.parse("1,250"))
        assertEquals(12500L, Money.parse("١٢٥"))
        assertEquals(125000L, Money.parse("١٬٢٥٠"))
    }

    @Test
    fun `التحليل يقرّب الكسور إلى ريال كامل`() {
        assertEquals(1300L, Money.parse("12.5"))   // 12.5 → 13
        assertEquals(1200L, Money.parse("12.4"))   // 12.4 → 12
        assertEquals(1300L, Money.parse("12.50"))
    }

    @Test
    fun `التحليل يعيد القيمة الافتراضية للنص الفارغ أو الخاطئ`() {
        assertNull(Money.parse(null))
        assertEquals(0L, Money.parse("", 0L))
        assertEquals(0L, Money.parse("abc", 0L))
        assertEquals(0L, Money.parse("-", 0L))
        assertEquals(0L, Money.parse(".", 0L))
    }

    @Test
    fun `العرض بالريال الكامل بفواصل الآلاف بلا كسور`() {
        assertEquals("0", Money.format(0L))
        assertEquals("5", Money.format(500L))
        assertEquals("999", Money.format(99900L))
        assertEquals("1,000", Money.format(100000L))
        assertEquals("5,120", Money.format(512000L))
        assertEquals("1,234,567", Money.format(123456700L))
        assertEquals("-300", Money.format(-30000L))
    }
}
