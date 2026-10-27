package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class ReportRulesTest {

    @Test
    fun `ملخص اليوم يحسب الفواتير المفتوحة فقط ويعد الملغاة`() {
        val s = ReportRules.summarizeDay(
            listOf(
                ReportRules.InvoiceSummaryInput("open", 2600L, 2600L, 0L),
                ReportRules.InvoiceSummaryInput("open", 2400L, 400L, 2000L),
                ReportRules.InvoiceSummaryInput("cancelled", 1000L, 1000L, 0L),
            )
        )
        assertEquals(2, s.count)
        assertEquals(5000L, s.totalCents)
        assertEquals(3000L, s.paidCents)
        assertEquals(2000L, s.dueCents)
        assertEquals(1, s.cancelledCount)
    }

    @Test
    fun `يوم بلا فواتير يعطي صفراً في كل شيء`() {
        val s = ReportRules.summarizeDay(emptyList())
        assertEquals(0, s.count)
        assertEquals(0L, s.totalCents)
        assertEquals(0, s.cancelledCount)
    }

    @Test
    fun `المتأخر يأتي أولاً ثم الأطول غياباً`() {
        val sorted = ReportRules.sortDue(
            listOf(
                ReportRules.DueItem("أ", true, overdue = false, daysSinceVisit = 3),
                ReportRules.DueItem("ب", true, overdue = true, daysSinceVisit = 10),
                ReportRules.DueItem("ج", false, overdue = false, daysSinceVisit = null),
                ReportRules.DueItem("د", true, overdue = true, daysSinceVisit = 12),
            )
        )
        assertEquals(listOf("د", "ب", "أ", "ج"), sorted.map { it.name })
    }

    @Test
    fun `عدّ المندوبين المتوقعين والمتوقعين والمتأخرين`() {
        val c = ReportRules.dueCounts(
            listOf(
                ReportRules.DueItem("أ", true, overdue = false, daysSinceVisit = 3),
                ReportRules.DueItem("ب", true, overdue = true, daysSinceVisit = 10),
                ReportRules.DueItem("ج", false, overdue = false, daysSinceVisit = null),
            )
        )
        assertEquals(2, c.delegatesDue)
        assertEquals(3, c.totalDue)
        assertEquals(1, c.totalLate)
    }
}
