package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SalesRulesTest {

    private fun line(
        price: Long = 1000L,
        stock: Double = 10.0,
        qty: Double? = 1.0,
        priceOverride: Long? = null,
        found: Boolean = true,
        name: String = "صنف",
    ) = SaleLineInput(
        productId = 1L, found = found, name = name, stock = stock,
        catalogPriceCents = price, requestedQty = qty, requestedPriceCents = priceOverride,
    )

    private fun input(
        lines: List<SaleLineInput> = listOf(line()),
        payment: String = "cash",
        shiftOpen: Boolean = true,
        isOwner: Boolean = false,
        allowPriceEdit: Boolean = false,
        allowNegativeStock: Boolean = false,
        discount: Long = 0L,
        customerFound: Boolean = false,
        received: Long? = null,
        paid: Long? = null,
    ) = SaleInput(
        lines, payment, shiftOpen, isOwner, allowPriceEdit, allowNegativeStock,
        discount, customerFound, received, paid,
    )

    private fun ok(r: SaleResult): SaleResult.Ok {
        assertTrue("توقعنا نجاح الفاتورة، لكن جاء: $r", r is SaleResult.Ok)
        return r as SaleResult.Ok
    }

    private fun error(r: SaleResult): String {
        assertTrue("توقعنا رفض الفاتورة، لكن جاء: $r", r is SaleResult.Error)
        return (r as SaleResult.Error).message
    }

    // ---------- الدقة الحسابية ----------

    @Test
    fun `الكسر في الكمية يُقرَّب إلى ريال كامل`() {
        // 0.75 كيلو × 10 ريال = 7.5 → 8 ريال، وليس 7.50
        assertEquals(800L, SalesRules.lineTotal(1000L, 0.75))
    }

    @Test
    fun `الكمية الصفرية تُعامل كواحد كما في النسخة الأصلية`() {
        val r = ok(SalesRules.validateSale(input(lines = listOf(line(price = 2600L, qty = 0.0)))))
        assertEquals(2600L, r.totalCents)
        assertEquals(1.0, r.lines[0].qty, 0.0)
    }

    @Test
    fun `الكمية السالبة مرفوضة مع اسم الصنف`() {
        val msg = error(SalesRules.validateSale(input(lines = listOf(line(qty = -2.0, name = "رز")))))
        assertEquals("كمية غير صحيحة للصنف: رز", msg)
    }

    @Test
    fun `الخصم يُقرَّب ولا يتجاوز الفاتورة`() {
        val r = ok(SalesRules.validateSale(input(lines = listOf(line(price = 2600L)), discount = 1250L)))
        assertEquals(1300L, r.discountCents)   // 12.50 → 13
        assertEquals(1300L, r.totalCents)      // 26 − 13
        val capped = ok(SalesRules.validateSale(input(lines = listOf(line(price = 500L)), discount = 90000L)))
        assertEquals(500L, capped.discountCents)
        assertEquals(0L, capped.totalCents)
    }

    @Test
    fun `مجموع الفاتورة من أسطر متعددة`() {
        val r = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L, qty = 2.0), line(price = 2550L, qty = 1.0)))
            )
        )
        assertEquals(4600L, r.subtotalCents) // 20 + 25.50 → 20 + 26
    }

    // ---------- البيع النقدي ----------

    @Test
    fun `البيع النقدي يحسب الباقي`() {
        val r = ok(SalesRules.validateSale(input(lines = listOf(line(price = 2600L)), received = 3000L)))
        assertEquals(2600L, r.totalCents)
        assertEquals(2600L, r.paidCents)
        assertEquals(0L, r.dueCents)
        assertEquals(400L, r.changeCents)
        assertEquals("cash", r.paymentType)
    }

    @Test
    fun `البيع النقدي بلا مبلغ مستلم يعتبر المستلم هو الإجمالي`() {
        val r = ok(SalesRules.validateSale(input(lines = listOf(line(price = 2600L)), received = null)))
        assertEquals(2600L, r.receivedCents)
        assertEquals(0L, r.changeCents)
    }

    @Test
    fun `البيع النقدي يرفض المبلغ المستلم الأقل من الإجمالي`() {
        val msg = error(SalesRules.validateSale(input(lines = listOf(line(price = 2600L)), received = 2000L)))
        assertEquals("المبلغ المستلم أقل من الإجمالي", msg)
    }

    @Test
    fun `حركة الدرج للبيع تُسجَّل فقط إذا دُفع شيء`() {
        assertEquals(2600L, SalesRules.saleCashMovementCents(2600L))
        assertNull(SalesRules.saleCashMovementCents(0L))
    }

    // ---------- البيع الآجل ----------

    @Test
    fun `البيع الآجل يتطلب زبوناً`() {
        val msg = error(SalesRules.validateSale(input(payment = "credit", customerFound = false)))
        assertEquals("اختر الزبون الآجل", msg)
    }

    @Test
    fun `البيع الآجل يحسب المدفوع والمتبقي دَيناً`() {
        // 3 × 8 = 24، دُفع 4 → الدين 20
        val r = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 800L, qty = 3.0)), payment = "credit",
                    customerFound = true, paid = 400L)
            )
        )
        assertEquals(2400L, r.totalCents)
        assertEquals(400L, r.paidCents)
        assertEquals(2000L, r.dueCents)
        assertNull(r.changeCents)
    }

    @Test
    fun `المدفوع في الآجل لا يتجاوز الإجمالي`() {
        val r = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L)), payment = "credit",
                    customerFound = true, paid = 99999L)
            )
        )
        assertEquals(1000L, r.paidCents)
        assertEquals(0L, r.dueCents)
    }

    // ---------- الصندوق والفاتورة الفارغة والأصناف ----------

    @Test
    fun `الفاتورة الفارغة مرفوضة`() {
        assertEquals("الفاتورة فارغة", error(SalesRules.validateSale(input(lines = emptyList()))))
    }

    @Test
    fun `نوع الدفع غير المعروف مرفوض`() {
        assertEquals("نوع الدفع غير صحيح", error(SalesRules.validateSale(input(payment = "visa"))))
    }

    @Test
    fun `لا بيع والصندوق مغلق`() {
        assertEquals(
            "الصندوق مغلق — افتح الوردية أولاً",
            error(SalesRules.validateSale(input(shiftOpen = false))),
        )
    }

    @Test
    fun `الصنف غير الموجود مرفوض`() {
        assertEquals(
            "أحد الأصناف غير موجود",
            error(SalesRules.validateSale(input(lines = listOf(line(found = false))))),
        )
    }

    @Test
    fun `الرصيد غير الكافي مرفوض ويظهر المتاح بصيغة مختصرة`() {
        val msg = error(
            SalesRules.validateSale(input(lines = listOf(line(stock = 5.0, qty = 7.0, name = "حليب")))),
        )
        assertEquals("رصيد غير كافٍ: حليب (المتاح 5)", msg)
    }

    @Test
    fun `الرصيد السالب مسموح عند تفعيل الإعداد`() {
        val r = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(stock = 0.0, qty = 3.0, price = 500L)), allowNegativeStock = true)
            )
        )
        assertEquals(1500L, r.totalCents)
    }

    // ---------- تعديل السعر ----------

    @Test
    fun `تعديل السعر للمالك فقط وعند تفعيل الإعداد`() {
        val byOwner = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L, priceOverride = 1500L)),
                    isOwner = true, allowPriceEdit = true)
            )
        )
        assertEquals(1500L, byOwner.lines[0].priceCents)

        val byWorker = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L, priceOverride = 1500L)),
                    isOwner = false, allowPriceEdit = true)
            )
        )
        assertEquals(1000L, byWorker.lines[0].priceCents)

        val disabled = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L, priceOverride = 1500L)),
                    isOwner = true, allowPriceEdit = false)
            )
        )
        assertEquals(1000L, disabled.lines[0].priceCents)
    }

    @Test
    fun `السعر اليدوي السالب يصبح صفراً`() {
        val r = ok(
            SalesRules.validateSale(
                input(lines = listOf(line(price = 1000L, priceOverride = -500L)),
                    isOwner = true, allowPriceEdit = true)
            )
        )
        assertEquals(0L, r.lines[0].priceCents)
    }

    @Test
    fun `عرض الرصيد يطابق صيغة بايثون`() {
        assertEquals("5", SalesRules.formatStock(5.0))
        assertEquals("0.75", SalesRules.formatStock(0.75))
        assertTrue(SalesRules.formatStock(0.0) == "0")
    }
}
