package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SupplierDateTest {

    @Test
    fun `يوم الصفر هو 1970-01-01`() {
        assertEquals(0L, SupplierRules.epochDay("1970-01-01"))
    }

    @Test
    fun `السنة الكبيسة تُحسب بشكل صحيح`() {
        // 2024 كبيسة: بين 28 فبراير و1 مارس يومان
        assertEquals(2L, SupplierRules.epochDay("2024-03-01")!! - SupplierRules.epochDay("2024-02-28")!!)
    }

    @Test
    fun `الأيام منذ آخر زيارة من التاريخ مع الوقت`() {
        assertEquals(12, SupplierRules.daysSince("2026-10-01 09:00:00", "2026-10-13"))
        assertEquals(0, SupplierRules.daysSince("2026-10-13 08:00:00", "2026-10-13"))
    }

    @Test
    fun `بلا زيارة أو بتاريخ خاطئ لا تُحسب الأيام`() {
        assertNull(SupplierRules.daysSince(null, "2026-10-13"))
        assertNull(SupplierRules.daysSince("", "2026-10-13"))
        assertNull(SupplierRules.daysSince("ليس تاريخاً", "2026-10-13"))
    }

    @Test
    fun `زيارة في المستقبل لا تعطي أياماً سالبة`() {
        assertEquals(0, SupplierRules.daysSince("2026-10-20", "2026-10-13"))
    }
}
