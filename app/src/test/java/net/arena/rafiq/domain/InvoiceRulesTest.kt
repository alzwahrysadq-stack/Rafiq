package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InvoiceRulesTest {

    @Test
    fun `الإلغاء ممكن للفاتورة المفتوحة فقط`() {
        assertNull(InvoiceRules.validateCancel("open"))
        assertEquals("الفاتورة غير موجودة أو ملغاة مسبقاً", InvoiceRules.validateCancel("cancelled"))
        assertEquals("الفاتورة غير موجودة أو ملغاة مسبقاً", InvoiceRules.validateCancel(null))
    }

    @Test
    fun `الإلغاء يعكس المبلغ المدفوع في الدرج`() {
        assertEquals(-2600L, InvoiceRules.cancelCashMovementCents(2600L))
    }

    @Test
    fun `فاتورة آجلة بلا دفعة لا تحرك الدرج عند الإلغاء`() {
        assertNull(InvoiceRules.cancelCashMovementCents(0L))
    }
}
