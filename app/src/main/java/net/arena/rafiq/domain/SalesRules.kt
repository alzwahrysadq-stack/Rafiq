package net.arena.rafiq.domain

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * قواعد البيع والفواتير، مطابقة لدالة api_sale وinvoice_cancel في النسخة الأصلية.
 * دوال نقية: لا تقرأ ولا تكتب قاعدة البيانات. الطبقة التي تستدعيها هي التي تحفظ النتيجة.
 */

/** صنف داخل الفاتورة كما طلبه الكاشير، ومعه بياناته من قاعدة البيانات. */
data class SaleLineInput(
    val productId: Long,
    /** هل وُجد الصنف وهو فعّال؟ إذا لا، ترفض الفاتورة. */
    val found: Boolean,
    val name: String,
    /** الرصيد الحالي في المخزون. */
    val stock: Double,
    /** السعر المسجّل للصنف بوحدة 1/100 من الريال. */
    val catalogPriceCents: Long,
    /** الكمية المطلوبة، وإذا كانت null أو صفراً تُعتبر 1 كما في النسخة الأصلية. */
    val requestedQty: Double?,
    /** سعر يدوي اختياري، يُقبل فقط للمالك وعند تفعيل الخيار. */
    val requestedPriceCents: Long?,
)

data class SaleInput(
    val lines: List<SaleLineInput>,
    /** "cash" أو "credit". */
    val paymentType: String,
    /** هل الوردية مفتوحة؟ */
    val shiftOpen: Boolean,
    val isOwner: Boolean,
    /** إعداد النظام: السماح بتعديل السعر. */
    val allowPriceEdit: Boolean,
    /** إعداد النظام: السماح ببيع ما هو أكثر من الرصيد. */
    val allowNegativeStock: Boolean,
    val discountCents: Long,
    /** للبيع الآجل فقط: هل الزبون موجود وفعّال؟ */
    val customerFound: Boolean,
    /** للبيع النقدي: المبلغ المستلم، وإذا كان null أو صفراً يُعتبر الإجمالي. */
    val receivedCents: Long?,
    /** للبيع الآجل: المبلغ المدفوع الآن. */
    val paidCents: Long?,
    /** مجموع الأجزاء غير النقدية (حوالة، محفظة، إيداع): تُدفع خارج الدرج. */
    val nonCashCents: Long = 0L,
)

/** صنف بعد التسعير، جاهز للحفظ. */
data class PricedLine(
    val productId: Long,
    val name: String,
    val priceCents: Long,
    val qty: Double,
    val lineTotalCents: Long,
)

sealed class SaleResult {
    data class Error(val message: String) : SaleResult()

    data class Ok(
        val lines: List<PricedLine>,
        val subtotalCents: Long,
        val discountCents: Long,
        val totalCents: Long,
        val paidCents: Long,
        val dueCents: Long,
        /** null للبيع الآجل. */
        val receivedCents: Long?,
        /** null للبيع الآجل. */
        val changeCents: Long?,
        val paymentType: String,
    ) : SaleResult()
}

object SalesRules {

    /** سعر السطر = السعر × الكمية، مقرّباً إلى ريال كامل. */
    fun lineTotal(priceCents: Long, qty: Double): Long =
        Money.toWhole(Math.rint(priceCents * qty).toLong())

    /** يعرض الرصيد كما يعرضه %g في بايثون: 5 لا 5.0، و0.75 كما هو. */
    fun formatStock(stock: Double): String =
        if (stock == floor(stock)) stock.toLong().toString() else stock.toString()

    fun validateSale(input: SaleInput): SaleResult {
        if (input.lines.isEmpty()) return SaleResult.Error("الفاتورة فارغة")
        if (input.paymentType != "cash" && input.paymentType != "credit") {
            return SaleResult.Error("نوع الدفع غير صحيح")
        }
        if (!input.shiftOpen) return SaleResult.Error("الصندوق مغلق — افتح الوردية أولاً")

        val editPrice = input.allowPriceEdit && input.isOwner
        val priced = ArrayList<PricedLine>()
        var subtotal = 0L

        for (line in input.lines) {
            if (!line.found) return SaleResult.Error("أحد الأصناف غير موجود")

            val qty = if (line.requestedQty == null || line.requestedQty == 0.0) 1.0 else line.requestedQty
            if (qty <= 0.0) return SaleResult.Error("كمية غير صحيحة للصنف: ${line.name}")

            var price = line.catalogPriceCents
            if (editPrice && line.requestedPriceCents != null) {
                price = max(0L, line.requestedPriceCents)
            }

            if (!input.allowNegativeStock && line.stock < qty) {
                return SaleResult.Error(
                    "رصيد غير كافٍ: ${line.name} (المتاح ${formatStock(line.stock)})"
                )
            }

            val total = lineTotal(price, qty)
            subtotal += total
            priced.add(PricedLine(line.productId, line.name, price, qty, total))
        }

        // الخصم يُقرَّب إلى ريال كامل، ولا يتجاوز قيمة الفاتورة
        var discount = Money.toWhole(max(0L, input.discountCents))
        if (discount > subtotal) discount = subtotal
        val total = subtotal - discount

        if (input.paymentType == "credit" && !input.customerFound) {
            return SaleResult.Error("اختر الزبون الآجل")
        }

        val nonCash = max(0L, input.nonCashCents)
        if (nonCash > total) return SaleResult.Error("مجموع التحويلات والمحافظ أكبر من الإجمالي")

        return if (input.paymentType == "cash") {
            // النقد المطلوب = الإجمالي ناقص الأجزاء غير النقدية
            val cashDue = total - nonCash
            val rawReceived = if (input.receivedCents == null || input.receivedCents == 0L) cashDue else input.receivedCents
            val received = Money.toWhole(rawReceived)
            if (received < cashDue) {
                return SaleResult.Error(
                    if (nonCash > 0L) "المبلغ النقدي المستلم أقل من المطلوب نقداً" else "المبلغ المستلم أقل من الإجمالي",
                )
            }
            SaleResult.Ok(
                lines = priced,
                subtotalCents = subtotal,
                discountCents = discount,
                totalCents = total,
                paidCents = total,
                dueCents = 0L,
                receivedCents = received,
                changeCents = received - cashDue,
                paymentType = "cash",
            )
        } else {
            // المدفوع الآن = النقد المدفوع + الأجزاء غير النقدية
            val cashPaid = Money.toWhole(max(0L, min(input.paidCents ?: 0L, total - nonCash)))
            val paid = cashPaid + nonCash
            SaleResult.Ok(
                lines = priced,
                subtotalCents = subtotal,
                discountCents = discount,
                totalCents = total,
                paidCents = paid,
                dueCents = total - paid,
                receivedCents = null,
                changeCents = null,
                paymentType = "credit",
            )
        }
    }

    /** حركة الدرج للبيع: تُسجَّل فقط إذا دُفع شيء الآن. */
    fun saleCashMovementCents(paidCents: Long): Long? = if (paidCents > 0L) paidCents else null
}

object InvoiceRules {

    /** الإلغاء ممكن فقط للفاتورة المفتوحة. يعيد رسالة الخطأ أو null. */
    fun validateCancel(status: String?): String? =
        if (status == "open") null else "الفاتورة غير موجودة أو ملغاة مسبقاً"

    /** حركة الدرج عند الإلغاء: سالبة بقدر النقد الذي دخل فعلاً، لا إجمالي المدفوع بكل الطرق. */
    fun cancelCashMovementCents(cashCents: Long): Long? = if (cashCents > 0L) -cashCents else null
}
