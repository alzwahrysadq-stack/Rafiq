package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CashRulesTest {

    @Test
    fun `المتوقع في الدرج هو مجموع كل الحركات`() {
        // بداية 1000 + بيع 26 + مصروف -10 = 1016 ريال → 101600 قرش
        val movements = listOf(100000L, 2600L, -1000L)
        assertEquals(101600L, CashRules.expectedFromMovements(movements))
    }

    @Test
    fun `الفارق موجب عند الزيادة وسالب عند العجز`() {
        assertEquals(400L, CashRules.difference(10400L, 10000L))
        assertEquals(-300L, CashRules.difference(9700L, 10000L))
        assertEquals(0L, CashRules.difference(10000L, 10000L))
    }

    @Test
    fun `الإغلاق المطابق لا يحتاج سبباً`() {
        assertTrue(CashRules.canCloseShift(0L, null))
        assertTrue(CashRules.canCloseShift(0L, ""))
    }

    @Test
    fun `الإغلاق بفارق يحتاج سبباً من القائمة`() {
        assertFalse(CashRules.canCloseShift(-300L, null))
        assertFalse(CashRules.canCloseShift(-300L, ""))
        assertFalse(CashRules.canCloseShift(-300L, "سبب غير موجود"))
        assertTrue(CashRules.canCloseShift(-300L, "خطأ في العدّ"))
        assertTrue(CashRules.canCloseShift(400L, " سلفة مؤقتة "))
    }

    @Test
    fun `الحركة اليدوية تتطلب سبباً من القائمة`() {
        val err = CashRules.validateManualMovement(1000L, "", CashRules.REASONS_OUT)
        assertNotNull(err)
        assertTrue(err!!.contains("سبب"))
    }

    @Test
    fun `الحركة اليدوية ترفض سبباً خارج القائمة`() {
        val err = CashRules.validateManualMovement(1000L, "سبب من عندي", CashRules.REASONS_OUT)
        assertNotNull(err)
    }

    @Test
    fun `الحركة اليدوية ترفض المبلغ الصفري أو السالب أو الفارغ`() {
        assertNotNull(CashRules.validateManualMovement(0L, "مصروف متجر", CashRules.REASONS_OUT))
        assertNotNull(CashRules.validateManualMovement(-100L, "مصروف متجر", CashRules.REASONS_OUT))
        assertNotNull(CashRules.validateManualMovement(null, "مصروف متجر", CashRules.REASONS_OUT))
    }

    @Test
    fun `الحركة اليدوية الصالحة تمر بلا خطأ`() {
        assertNull(CashRules.validateManualMovement(100000L, "مصروف متجر", CashRules.REASONS_OUT))
        assertNull(CashRules.validateManualMovement(50000L, "إيداع من المالك", CashRules.REASONS_IN))
    }

    @Test
    fun `قوائم الأسباب والفئات مطابقة للنسخة الأصلية`() {
        assertEquals(5, CashRules.REASONS_IN.size)
        assertEquals(5, CashRules.REASONS_OUT.size)
        assertEquals(5, CashRules.REASONS_DIFF.size)
        assertEquals(listOf(1000, 500, 250, 200, 100, 50, 20, 10, 5, 1), CashRules.DENOMINATIONS)
    }
}
