package net.arena.rafiq.domain

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * حارس محاسبي لمسودة فاتورة واردات: النص المستخرج من الصورة لا يصبح مخزوناً أو ديناً
 * إلا بعد ربط كل سطر بصنف ومراجعة المالك له وللطريقة والإجمالي.
 * هذه القواعد وحدها لا تُرحّل شيئاً؛ المستودع سيعيد فحص الصنف والمورد ويكتب بمعاملة واحدة.
 */
object PurchaseDraftRules {
    data class Line(
        val productId: Long?,
        val quantity: Double?,
        val unitCostCents: Long?,
        val expiryIso: String?,
        val expiryRequired: Boolean,
        val reviewed: Boolean = false,
    )

    data class Draft(
        val supplierId: Long?,
        val imageSha256: String?, // بصمة صورة محلية؛ يتحقق المستودع من البايتات قبل الحفظ/الترحيل
        val invoiceDateIso: String,
        val invoiceRef: String,
        val paymentType: String, // cash | credit؛ الجزء المدفوع قد يكون أقل من الإجمالي في الآجل
        val declaredTotalCents: Long?, // إجمالي الفاتورة الذي قرأه وأكده المالك، لا الرصيد السابق
        val paidCents: Long?,
        val lines: List<Line>,
        val reviewedByOwner: Boolean = false,
    )

    sealed class Decision {
        data class Ready(val totalCents: Long, val paidCents: Long, val debtCents: Long) : Decision()
        data class Reject(val message: String) : Decision()
    }

    /** لا نعوّض حقل صلاحية مقطوع أو 31 فبراير بتاريخ آخر؛ الصف يبقى للمراجعة. */
    fun isIsoDate(date: String?): Boolean {
        if (date == null || !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(date)) return false
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        fmt.isLenient = false
        return runCatching { fmt.parse(date) != null }.getOrDefault(false)
    }

    fun validateForPosting(draft: Draft): Decision {
        fun reject(reason: String): Decision.Reject = Decision.Reject(reason)
        if (!draft.reviewedByOwner) return reject("راجع صورة الفاتورة وكل بند ثم أكّدها قبل الترحيل")
        if (draft.imageSha256 == null || !Regex("[a-f0-9]{64}").matches(draft.imageSha256)) {
            return reject("أرفق صورة فاتورة الشراء الأصلية للتحقق منها")
        }
        if (draft.supplierId == null || draft.supplierId <= 0L) return reject("اختر مورداً صحيحاً")
        if (!isIsoDate(draft.invoiceDateIso)) return reject("تاريخ فاتورة الشراء غير صالح")
        if (draft.invoiceRef.length > 100 || draft.invoiceRef.any { Character.isISOControl(it) }) {
            return reject("رقم فاتورة المورد غير صالح")
        }
        if (draft.paymentType != "cash" && draft.paymentType != "credit") return reject("طريقة سداد المشتريات غير صحيحة")
        if (draft.lines.isEmpty() || draft.lines.size > 500) return reject("أدخل بنود الفاتورة (حتى 500 سطر)")
        var total = 0L
        for ((index, line) in draft.lines.withIndex()) {
            val n = index + 1
            if (!line.reviewed) return reject("راجع السطر $n من الفاتورة قبل الترحيل")
            if (line.productId == null || line.productId <= 0L) return reject("اربط السطر $n بصنف موجود")
            val qty = line.quantity
            if (qty == null || !qty.isFinite() || qty <= 0.0 || qty > 1_000_000.0) {
                return reject("كمية السطر $n غير صالحة")
            }
            val unitCost = line.unitCostCents
            if (unitCost == null || unitCost < 0L || unitCost > 1_000_000_000L) {
                return reject("تكلفة السطر $n غير صالحة")
            }
            if (line.expiryRequired && !isIsoDate(line.expiryIso)) {
                return reject("أكّد تاريخ صلاحية السطر $n")
            }
            if (line.expiryIso != null && !isIsoDate(line.expiryIso)) {
                return reject("تاريخ صلاحية السطر $n غير صالح")
            }
            if (line.expiryIso != null && line.expiryIso < draft.invoiceDateIso) {
                return reject("صلاحية السطر $n أقدم من تاريخ الشراء؛ اعزله ولا تضفه للمخزون القابل للبيع")
            }
            val lineTotal = try {
                // التكلفة مخزنة بوحدة 1/100 من الريال، ونقرّب ناتج كمية كسرية إلى قرش، لا إلى ريال.
                BigDecimal.valueOf(unitCost).multiply(BigDecimal.valueOf(qty))
                    .setScale(0, RoundingMode.HALF_UP).longValueExact()
            } catch (_: ArithmeticException) {
                return reject("مبلغ السطر $n أكبر من الحد الآمن")
            }
            if (lineTotal > Long.MAX_VALUE - total) return reject("إجمالي الفاتورة أكبر من الحد الآمن")
            total += lineTotal
        }
        if (total <= 0L) return reject("إجمالي فاتورة الشراء يجب أن يكون أكبر من صفر")
        val declared = draft.declaredTotalCents
        if (declared == null || declared <= 0L || declared != total) {
            return reject("مجموع البنود لا يطابق إجمالي فاتورة المورد المراجع؛ افصل الحسم أو الضريبة أو النقل ولا تضف الرصيد السابق")
        }
        val paid = draft.paidCents ?: return reject("حدد المبلغ المدفوع للمورد، ولو كان صفراً")
        if (paid < 0L || paid > total) return reject("المدفوع خارج إجمالي الفاتورة")
        if (draft.paymentType == "cash" && paid != total) return reject("فاتورة الشراء النقدية يجب أن تُدفع كاملة")
        if (draft.paymentType == "credit" && paid == total) return reject("لا يوجد متبقٍ آجل؛ اختر النقدي")
        return Decision.Ready(total, paid, total - paid)
    }
}
