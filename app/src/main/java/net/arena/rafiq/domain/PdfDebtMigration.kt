package net.arena.rafiq.domain

import java.text.SimpleDateFormat
import java.util.Locale

/**
 * بوابة مراجعة حسابية لاستيراد أرصدة PDF «كناش»؛ لا تقرأ PDF ولا تكتب قاعدة البيانات.
 * لا يُستخدم ناتج OCR أو النص المستخرج كإذنٍ بالترحيل. الربط بمعرّف زبون رفيق صريح.
 * لا تخلط الرصيد الافتتاحي مع حركات الكشف التاريخية في الاستيراد نفسه.
 */
object PdfDebtMigration {
    enum class Strategy { OPENING_BALANCES, HISTORICAL_MOVEMENTS }

    data class SourceRow(
        val page: Int,                 // الصفحة في PDF، تبدأ من 1
        val line: Int,                 // رقم السطر داخل الصفحة؛ يبقى للأثر التدقيقي
        val sourceName: String,        // اسم PDF للمراجعة فقط، ليس مفتاح مطابقة تلقائي
        val customerId: Long?,        // يختاره المالك من زبائن رفيق، لا يُستنتج بالاسم
        val amountCents: Long?,
        val reviewed: Boolean,
    )

    data class Draft(
        val sourceSha256: String?,
        val pageCount: Int,
        val cutoffIso: String,
        val strategy: Strategy,
        val sourceTotalCents: Long?,    // صافي موقّع، محسوب من أعطيت − أخذت ومطابق لمقدار المطبوع
        val checkedTotalCents: Long?,   // صافي موقّع راجعه المالك مستقلاً عن مجموع القراءة
        val rows: List<SourceRow>,
        val ownerConfirmed: Boolean,
    )

    sealed class Decision {
        data class Verified(val totalCents: Long, val rowCount: Int) : Decision()
        data class Blocked(val reason: String) : Decision()
    }

    private fun isoDate(value: String): Boolean {
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(value)) return false
        return runCatching {
            SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }.parse(value) != null
        }.getOrDefault(false)
    }

    fun validate(draft: Draft): Decision {
        fun block(reason: String): Decision.Blocked = Decision.Blocked(reason)
        if (draft.strategy != Strategy.OPENING_BALANCES) {
            return block("الحركات التاريخية تحتاج كشفاً زمنياً وآلية منفصلة؛ لا تُجمع مع رصيد افتتاحي")
        }
        if (!draft.ownerConfirmed) return block("يلزم اعتماد المالك بعد مراجعة المستند وكل زبون")
        if (draft.sourceSha256 == null || !Regex("[a-f0-9]{64}").matches(draft.sourceSha256)) {
            return block("لم تُحسب بصمة PDF من بايتات الملف المحلي")
        }
        if (draft.pageCount !in 1..500) return block("عدد صفحات PDF غير صالح للمراجعة")
        if (!isoDate(draft.cutoffIso)) return block("تاريخ رصيد كناش غير صالح")
        if (draft.rows.isEmpty() || draft.rows.size > 10_000) return block("لا توجد أرصدة قابلة للمراجعة أو الملف كبير جداً")
        val checkedTotal = draft.checkedTotalCents
        if (checkedTotal == null || checkedTotal !in -100_000_000_000_000L..100_000_000_000_000L) {
            return block("أدخل صافي الرصيد الموقّع الذي راجعتَه من أعطيت − أخذت")
        }
        if (draft.sourceTotalCents != null && draft.sourceTotalCents != checkedTotal) {
            return block("الإجمالي المُثبت في PDF يختلف عن إجمالي المالك")
        }
        val seenPositions = HashSet<Pair<Int, Int>>()
        val seenCustomers = HashSet<Long>()
        var sum = 0L
        for ((index, row) in draft.rows.withIndex()) {
            val n = index + 1
            if (row.page !in 1..draft.pageCount || row.line < 1 ||
                !seenPositions.add(row.page to row.line)) return block("موقع السطر $n مفقود أو مكرر")
            if (!row.reviewed || row.sourceName.isBlank()) return block("السطر $n لم يُراجع مع PDF")
            val customerId = row.customerId
            if (customerId == null || customerId <= 0L) return block("اربط السطر $n بزبون محدد في رفيق")
            if (!seenCustomers.add(customerId)) return block("الزبون نفسه مرتبط بأكثر من سطر؛ راجع التكرار")
            val amount = row.amountCents
            if (amount == null || amount !in -100_000_000_000_000L..100_000_000_000_000L) {
                return block("مبلغ السطر $n مفقود أو خارج الحد الآمن؛ الفراغ ليس صفراً")
            }
            // الصفر الحقيقي مقبول، والرصد الدائن يُحفظ سالباً ولا يتحول بصمت إلى دين موجب.
            sum = try { Math.addExact(sum, amount) } catch (_: ArithmeticException) {
                return block("إجمالي الأرصدة خارج الحد الآمن")
            }
            if (sum !in -100_000_000_000_000L..100_000_000_000_000L) {
                return block("إجمالي الأرصدة خارج الحد الآمن")
            }
        }
        if (sum != checkedTotal) return block("مجموع السطور لا يطابق الإجمالي الذي راجعه المالك")
        return Decision.Verified(sum, draft.rows.size)
    }
}
