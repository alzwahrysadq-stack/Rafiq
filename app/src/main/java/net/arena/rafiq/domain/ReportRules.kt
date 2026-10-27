package net.arena.rafiq.domain

/**
 * قواعد لوحة الرئيسية والتقارير اليومية، مطابقة لـ dashboard و reports في النسخة الأصلية.
 */
object ReportRules {

    /** فاتورة مختصرة لأغراض التجميع. */
    data class InvoiceSummaryInput(
        val status: String,          // "open" أو "cancelled"
        val totalCents: Long,
        val paidCents: Long,
        val dueCents: Long,
    )

    data class DaySummary(
        val count: Int,
        val totalCents: Long,
        val paidCents: Long,
        val dueCents: Long,
        val cancelledCount: Int,
    )

    /** ملخص يوم: الفواتير المفتوحة تُحسب، والملغاة تُعد فقط. */
    fun summarizeDay(invoices: List<InvoiceSummaryInput>): DaySummary {
        val open = invoices.filter { it.status == "open" }
        return DaySummary(
            count = open.size,
            totalCents = open.sumOf { it.totalCents },
            paidCents = open.sumOf { it.paidCents },
            dueCents = open.sumOf { it.dueCents },
            cancelledCount = invoices.count { it.status == "cancelled" },
        )
    }

    /** مندوب أو مورد في قائمة «المتوقع اليوم». */
    data class DueItem(
        val name: String,
        val isDelegate: Boolean,
        val overdue: Boolean,
        val daysSinceVisit: Int?,
    )

    /**
     * ترتيب قائمة المتوقعين اليوم: المتأخر أولاً، ثم الأطول غياباً.
     * كما في النسخة الأصلية: (ليس متأخراً، −الأيام).
     */
    fun sortDue(items: List<DueItem>): List<DueItem> =
        items.sortedWith(
            compareBy<DueItem> { !it.overdue }
                .thenByDescending { it.daysSinceVisit ?: 0 }
        )

    /** عدد المندوبين المتوقعين، وعدد كل المتوقعين، وعدد المتأخرين. */
    data class DashboardDueCounts(val delegatesDue: Int, val totalDue: Int, val totalLate: Int)

    fun dueCounts(items: List<DueItem>): DashboardDueCounts =
        DashboardDueCounts(
            delegatesDue = items.count { it.isDelegate },
            totalDue = items.size,
            totalLate = items.count { it.overdue },
        )
}
