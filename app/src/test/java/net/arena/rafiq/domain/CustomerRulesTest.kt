package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomerRulesTest {

    @Test
    fun `الرصيد = الدين المرحّل + الفواتير المفتوحة + الأعطيت - الدفعات`() {
        // مثال النسخة الأصلية: 150 مرحّلة + 20 فاتورة − 70 دفعة = 100 ريال
        assertEquals(
            10000L,
            CustomerRules.balance(
                openingCents = 15000L,
                openInvoiceDueCents = 2000L,
                ledgerDebitsCents = 0L,
                paymentsCents = 7000L,
            ),
        )
    }

    @Test
    fun `الزبون بلا دين وبلا حركات رصيده صفر`() {
        assertEquals(0L, CustomerRules.balance(0L, 0L, 0L, 0L))
    }

    @Test
    fun `الدفعة الزائدة تجعل الرصيد سالباً أي رصيد لصالح الزبون`() {
        // زبون لا دين عليه ودفع 500 ريال: الرصيد -500 ريال
        assertEquals(-50000L, CustomerRules.balance(0L, 0L, 0L, 50000L))
    }

    @Test
    fun `الدين اليدوي يرفض المبلغ الفارغ أو الصفري أو السالب`() {
        assertEquals("اكتب مبلغاً صحيحاً", CustomerRules.validateDebit(null))
        assertEquals("اكتب مبلغاً صحيحاً", CustomerRules.validateDebit(0L))
        assertEquals("اكتب مبلغاً صحيحاً", CustomerRules.validateDebit(-100L))
        assertNull(CustomerRules.validateDebit(1000L))
    }

    @Test
    fun `الدفعة ترفض المبلغ الخاطئ قبل فحص الوردية`() {
        assertEquals("اكتب مبلغاً صحيحاً", CustomerRules.validatePayment(null, shiftOpen = false))
    }

    @Test
    fun `الدفعة مرفوضة والصندوق مغلق`() {
        val msg = CustomerRules.validatePayment(1000L, shiftOpen = false)
        assertTrue(msg!!.contains("الصندوق مغلق"))
    }

    @Test
    fun `الدفعة الصالحة تمر بلا خطأ`() {
        assertNull(CustomerRules.validatePayment(7000L, shiftOpen = true))
    }
}
