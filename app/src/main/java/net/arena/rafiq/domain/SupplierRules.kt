package net.arena.rafiq.domain

import java.util.Locale

/**
 * قواعد الموردين والمندوبين، مطابقة لنسخة بايثون (app.py، قسم الموردين والمناديب).
 * الرصيد = ما علينا للمورد. الاستلام يزيده، والسداد والمرتجع ينقصانه.
 */
object SupplierRules {

    /** أيام الدورية: كم يوماً بين الزيارات. 0 = عند الحاجة (لا تتبع). */
    val PERIOD_DAYS: Map<String, Int> = mapOf(
        "daily" to 1, "semi_daily" to 1, "weekly" to 7, "monthly" to 30, "irregular" to 0,
    )

    val PERIOD_LABEL: Map<String, String> = mapOf(
        "daily" to "يومي", "semi_daily" to "شبه يومي", "weekly" to "أسبوعي",
        "monthly" to "شهري", "irregular" to "عند الحاجة",
    )

    /** كم يوماً إضافياً بعد الدورية قبل أن يُعتبر المندوب متأخراً. */
    val OVERDUE_EXTRA: Map<String, Int> = mapOf(
        "daily" to 1, "semi_daily" to 1, "weekly" to 3, "monthly" to 5,
    )

    /** الرصيد = الاستلام − السداد − المرتجع (بوحدة 1/100 من الريال). */
    fun balance(receivedCents: Long, paidCents: Long, returnedCents: Long): Long =
        receivedCents - paidCents - returnedCents

    /** المندوب المتوقع اليوم والمتأخر، حسب دوريته وعدد الأيام منذ آخر زيارة. */
    data class DelegateFlags(val dueToday: Boolean, val overdue: Boolean)

    /**
     * daysSinceVisit = null إذا لم تحصل زيارة بعد.
     * المورد (لا المندوب) أو غير الفعّال أو بلا دورية لا يُحسب له شيء.
     */
    fun delegateFlags(
        isDelegate: Boolean,
        active: Boolean,
        periodicity: String,
        daysSinceVisit: Int?,
    ): DelegateFlags {
        val none = DelegateFlags(dueToday = false, overdue = false)
        if (!isDelegate || !active) return none
        val threshold = PERIOD_DAYS[periodicity] ?: 0
        if (threshold == 0) return none
        val dueToday = daysSinceVisit == null || daysSinceVisit >= threshold
        val overdue = daysSinceVisit != null &&
            daysSinceVisit >= threshold + (OVERDUE_EXTRA[periodicity] ?: 2)
        return DelegateFlags(dueToday, overdue)
    }

    /** لا يُوقف التعامل مع مورد إلا إذا كان حسابه مصفّى. يعيد رسالة الخطأ أو null. */
    fun validateDeactivate(name: String, balanceCents: Long): String? {
        if (balanceCents == 0L) return null
        val shown = String.format(Locale.US, "%.2f", balanceCents / 100.0)
        return "لا يمكن إيقاف «$name» وحسابه غير مصفّى ($shown)."
    }

    /** مبلغ الحركة: يجب أن يكون أكبر من صفر، وإلا null. */
    fun validAmount(amountCents: Long?): Long? =
        if (amountCents != null && amountCents > 0L) amountCents else null

    /** السداد للمالك فقط، ويحتاج مبلغاً صحيحاً ووردية مفتوحة (بالترتيب نفسه في النسخة الأصلية). */
    fun validatePay(amountCents: Long?, isOwner: Boolean, shiftOpen: Boolean): String? {
        if (!isOwner) return "هذه الحركة للمالك فقط"
        if (validAmount(amountCents) == null) return "اكتب مبلغاً صحيحاً"
        if (!shiftOpen) {
            return "الصندوق مغلق — افتح الوردية أولاً حتى يُسجَّل السداد في الدرج"
        }
        return null
    }

    /** المرتجع لا يُسجَّل إلا للبنود القابلة للرجعة (مثل الخبز والآيسكريم). */
    fun validateReturn(amountCents: Long?, returnable: Boolean, name: String): String? {
        if (validAmount(amountCents) == null) return "اكتب مبلغاً صحيحاً"
        if (!returnable) {
            return "«$name» غير قابل للمرتجع (مثل الثلج) — لا يمكن تسجيل رجعة"
        }
        return null
    }

    /** اليوم الذي يمثله تاريخ بصيغة yyyy-MM-dd، كعدد أيام منذ عصر ثابت (بلا مكتبات زمن). */
    fun epochDay(isoDate: String): Long? {
        val parts = isoDate.trim().take(10).split("-")
        if (parts.size != 3) return null
        val y = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        val d = parts[2].toIntOrNull() ?: return null
        if (m !in 1..12 || d !in 1..31) return null
        val yy = if (m <= 2) y - 1 else y
        val era = (if (yy >= 0) yy else yy - 399) / 400
        val yoe = yy - era * 400
        val mp = (m + 9) % 12
        val doy = (153 * mp + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097L + doe - 719468L
    }

    /** كم يوماً مضى على آخر زيارة؛ null إن لم تحصل زيارة، ولا يقل عن صفر. */
    fun daysSince(lastVisitAt: String?, todayIso: String): Int? {
        if (lastVisitAt.isNullOrBlank()) return null
        val last = epochDay(lastVisitAt) ?: return null
        val today = epochDay(todayIso) ?: return null
        return maxOf(0L, today - last).toInt()
    }
}
