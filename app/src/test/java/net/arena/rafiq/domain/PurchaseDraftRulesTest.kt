package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PurchaseDraftRulesTest {
    private fun valid() = PurchaseDraftRules.Draft(
        supplierId = 2,
        imageSha256 = "a".repeat(64),
        invoiceDateIso = "2026-10-14",
        invoiceRef = "فاتورة-17",
        paymentType = "credit",
        declaredTotalCents = 3_000,
        paidCents = 1_000,
        lines = listOf(PurchaseDraftRules.Line(productId = 5, quantity = 3.0,
            unitCostCents = 1_000L, expiryIso = "2027-01-31", expiryRequired = true, reviewed = true)),
        reviewedByOwner = true,
    )

    @Test fun `مسودة غير مؤكدة لا تغيّر رصيد المورد ولا المخزون حتى لو كانت الحقول صالحة`() {
        assertTrue(PurchaseDraftRules.validateForPosting(valid().copy(reviewedByOwner = false)) is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(valid().copy(imageSha256 = null)) is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(valid().copy(lines = valid().lines.map { it.copy(reviewed = false) }))
            is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(valid().copy(lines = valid().lines.map { it.copy(productId = null) }))
            is PurchaseDraftRules.Decision.Reject)
    }

    @Test fun `حساب فاتورة مطابقة ومسددة جزئيا يفصل المدفوع عن دين المورد`() {
        val result = PurchaseDraftRules.validateForPosting(valid()) as PurchaseDraftRules.Decision.Ready
        assertEquals(3_000L, result.totalCents)
        assertEquals(1_000L, result.paidCents)
        assertEquals(2_000L, result.debtCents)
    }

    @Test fun `الصلاحية المتناقضة والكمية غير المنتهية وتجاوز المدفوع تمنع الترحيل`() {
        val draft = valid()
        assertFalse(PurchaseDraftRules.isIsoDate("2027-02-31"))
        assertFalse(PurchaseDraftRules.isIsoDate("٢٠٢٧-٠١-٣١"))
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(lines = draft.lines.map { it.copy(expiryIso = "2027-02-31") }))
            is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(lines = draft.lines.map { it.copy(expiryIso = "2025-01-01") }))
            is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(lines = draft.lines.map { it.copy(quantity = Double.NaN) }))
            is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(paidCents = 3_100)) is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(paymentType = "cash", paidCents = 1_000))
            is PurchaseDraftRules.Decision.Reject)
    }

    @Test fun `كسور الريال والكمية تحفظ القروش وتطابق الإجمالي المراجع`() {
        val draft = valid().copy(declaredTotalCents = 151L, paidCents = 37L, lines = listOf(
            valid().lines.first().copy(quantity = 0.5, unitCostCents = 101L), // 50.5 قرش ← 51
            valid().lines.first().copy(productId = 6L, quantity = 1.0, unitCostCents = 100L),
        ))
        val result = PurchaseDraftRules.validateForPosting(draft) as PurchaseDraftRules.Decision.Ready
        assertEquals(151L, result.totalCents)
        assertEquals(37L, result.paidCents)
        assertEquals(114L, result.debtCents)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(declaredTotalCents = 150L))
            is PurchaseDraftRules.Decision.Reject)
        assertTrue(PurchaseDraftRules.validateForPosting(draft.copy(declaredTotalCents = null))
            is PurchaseDraftRules.Decision.Reject)
    }
}
