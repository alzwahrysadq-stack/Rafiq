package net.arena.rafiq.domain

import net.arena.rafiq.domain.CustomerStatement.InvoiceLine
import net.arena.rafiq.domain.CustomerStatement.Kind
import net.arena.rafiq.domain.CustomerStatement.LedgerLine
import net.arena.rafiq.domain.CustomerStatement.PaymentLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomerStatementTest {

    private fun inv(id: Long, number: Long, ts: String, due: Long, paid: Long = 0L, status: String = "open") =
        InvoiceLine(id, number, ts, due, paid, status)

    @Test
    fun `الرصيد يُحسب من الأقدم وتُعرض الأحدث أولاً`() {
        // مرحّل 150 + فاتورة 20 − دفعة 70 = 100، كما في مثال النسخة الأصلية
        val events = CustomerStatement.build(
            openingCents = 15000,
            invoices = listOf(inv(1, 1, "2026-10-01 10:00:00", 2000)),
            ledger = emptyList(),
            payments = listOf(PaymentLine(1, "2026-10-02 10:00:00", 7000, "", "أحمد (عامل)")),
        )
        assertEquals(3, events.size)
        // الأحدث أولاً: الدفعة ثم الفاتورة ثم المرحّل
        assertEquals(Kind.TAKEN, events[0].kind)
        assertEquals(10000L, events[0].balanceAfterCents)
        assertEquals(17000L, events[1].balanceAfterCents)
        assertEquals(15000L, events[2].balanceAfterCents)
        assertEquals("رصيد سابق (مُرحَّل من الكناش)", events[2].note)
    }

    @Test
    fun `المرحّل يبقى أقدم حركة مهما كان تاريخ الفواتير`() {
        val events = CustomerStatement.build(
            openingCents = 500,
            invoices = listOf(inv(1, 1, "2020-01-01 00:00:00", 100)),
            ledger = emptyList(),
            payments = emptyList(),
        )
        assertEquals("رصيد سابق (مُرحَّل من الكناش)", events.last().note)
        assertEquals(600L, events.first().balanceAfterCents)
    }

    @Test
    fun `رصيد افتتاحي دائن يبقى لصالح الزبون ولا يظهر كدين سالب أو دفعة نقدية`() {
        val events = CustomerStatement.build(
            openingCents = -5_000L,
            invoices = listOf(inv(2, 2, "2026-10-15 10:00:00", 1_000L)),
            ledger = emptyList(),
            payments = emptyList(),
        )
        assertEquals(2, events.size)
        assertEquals(Kind.OPENING_CREDIT, events[1].kind)
        assertEquals(5_000L, events[1].amountCents)
        assertEquals(-5_000L, events[1].balanceAfterCents)
        assertTrue(events[1].note.contains("ليس دفعة نقدية"))
        assertEquals(-4_000L, events[0].balanceAfterCents)
        assertEquals(Kind.GIVEN, events[0].kind)
        assertTrue(CustomerStatement.build(0L, emptyList(), emptyList(), emptyList()).isEmpty())
    }

    @Test
    fun `الفواتير الملغاة أو المدفوعة بالكامل لا تظهر في الكشف`() {
        val events = CustomerStatement.build(
            openingCents = 0,
            invoices = listOf(
                inv(1, 1, "2026-10-01 10:00:00", 500, status = "cancelled"),
                inv(2, 2, "2026-10-01 11:00:00", 0, paid = 900),
                inv(3, 3, "2026-10-01 12:00:00", 300),
            ),
            ledger = emptyList(),
            payments = emptyList(),
        )
        assertEquals(1, events.size)
        assertEquals(300L, events[0].amountCents)
        assertEquals(3L, events[0].invoiceId)
    }

    @Test
    fun `ملاحظة الفاتورة تذكر المبلغ المدفوع مقدماً`() {
        val events = CustomerStatement.build(
            openingCents = 0,
            invoices = listOf(inv(4, 9, "2026-10-01 10:00:00", 1000, paid = 500)),
            ledger = emptyList(),
            payments = emptyList(),
        )
        assertTrue(events[0].note.startsWith("فاتورة رقم 9"))
        assertTrue(events[0].note.contains("دُفع مقدماً"))
    }

    @Test
    fun `عند تساوي الوقت تأتي الفاتورة قبل الدين اليدوي ثم الدفعة`() {
        val ts = "2026-10-01 10:00:00"
        val events = CustomerStatement.build(
            openingCents = 0,
            invoices = listOf(inv(1, 1, ts, 100)),
            ledger = listOf(LedgerLine(1, ts, 50, "")),
            payments = listOf(PaymentLine(1, ts, 30, "", null)),
        )
        // الترتيب الزمني التصاعدي: فاتورة ثم دين ثم دفعة، ثم يُعكس للعرض
        assertEquals(listOf(Kind.TAKEN, Kind.GIVEN, Kind.GIVEN), events.map { it.kind })
        assertEquals(120L, events[0].balanceAfterCents)
        assertEquals("دين يدوي", events[1].note)
        assertEquals("دفعة نقدية", events[0].note)
    }

    @Test
    fun `تساوي الوقت يبقى بترتيب النوع حتى لو وصل رقم الفاتورة إلى الآلاف`() {
        val ts = "2026-10-01 10:00:00"
        val events = CustomerStatement.build(
            openingCents = 0,
            invoices = listOf(inv(9_999, 9_999, ts, 500, status = "open")),
            ledger = listOf(LedgerLine(1, ts, 100, "دين العامل", "العامل")),
            payments = listOf(PaymentLine(1, ts, 200, "دفعة المالك", "المالك")),
        )
        assertEquals(listOf("دفعة المالك", "دين العامل", "فاتورة رقم 9999"), events.map { it.note })
        assertEquals(listOf(400L, 600L, 500L), events.map { it.balanceAfterCents })
        assertEquals("العامل", events[1].userName)
    }

    @Test
    fun `الدفعة تحمل اسم العامل الذي سجّلها`() {
        val events = CustomerStatement.build(
            openingCents = 1000,
            invoices = emptyList(),
            ledger = emptyList(),
            payments = listOf(PaymentLine(1, "2026-10-01 10:00:00", 400, "نقداً", "سالم (عامل)")),
        )
        assertEquals("سالم (عامل)", events[0].userName)
        assertEquals(600L, events[0].balanceAfterCents)
    }

    @Test
    fun `حساب بلا حركات يعيد قائمة فارغة`() {
        assertTrue(CustomerStatement.build(0, emptyList(), emptyList(), emptyList()).isEmpty())
        assertFalse(CustomerStatement.build(1, emptyList(), emptyList(), emptyList()).isEmpty())
    }
}
