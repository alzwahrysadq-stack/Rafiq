package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PdfDebtMigrationTest {
    private fun valid() = PdfDebtMigration.Draft(
        sourceSha256 = "a".repeat(64), pageCount = 2, cutoffIso = "2026-10-14",
        strategy = PdfDebtMigration.Strategy.OPENING_BALANCES,
        sourceTotalCents = 3_350L, checkedTotalCents = 3_350L,
        rows = listOf(
            PdfDebtMigration.SourceRow(1, 4, "زبون أول", 11, 1_000L, true),
            PdfDebtMigration.SourceRow(2, 8, "زبون ثان", 12, 2_350L, true),
        ), ownerConfirmed = true,
    )

    @Test fun `يراجع مجموع PDF والزبائن المحددين دون الحاجة إلى إرسال الملف إلى الشبكة`() {
        assertEquals(PdfDebtMigration.Decision.Verified(3_350L, 2), PdfDebtMigration.validate(valid()))
    }

    @Test fun `لا يجمع تاريخ الحركات مع رصيد افتتاحي`() {
        val draft = valid().copy(strategy = PdfDebtMigration.Strategy.HISTORICAL_MOVEMENTS)
        assertTrue(PdfDebtMigration.validate(draft) is PdfDebtMigration.Decision.Blocked)
    }

    @Test fun `يرفض استيراد ملف غير مُبصم أو مراجعة بلا اعتماد المالك`() {
        assertTrue(PdfDebtMigration.validate(valid().copy(sourceSha256 = null)) is PdfDebtMigration.Decision.Blocked)
        assertTrue(PdfDebtMigration.validate(valid().copy(ownerConfirmed = false)) is PdfDebtMigration.Decision.Blocked)
        assertTrue(PdfDebtMigration.validate(valid().copy(cutoffIso = "2026-02-31")) is PdfDebtMigration.Decision.Blocked)
    }

    @Test fun `يرفض التكرار والربط المجهول والسطر غير المراجع`() {
        val v = valid()
        val second = v.rows[1]
        for (row in listOf(
            second.copy(customerId = v.rows[0].customerId),
            second.copy(page = 1, line = 4),
            second.copy(customerId = null),
            second.copy(reviewed = false),
            second.copy(sourceName = " "),
            second.copy(page = 3),
        )) {
            assertTrue(PdfDebtMigration.validate(v.copy(rows = listOf(v.rows[0], row)))
                is PdfDebtMigration.Decision.Blocked)
        }
    }

    @Test fun `يحتسب رصيد الزبون الدائن سالباً والرصيد الصفري ولا يسقطهما من عدد الصفوف`() {
        val v = valid()
        val rows = listOf(
            v.rows[0].copy(amountCents = 2_000L),
            v.rows[1].copy(amountCents = -1_500L),
            PdfDebtMigration.SourceRow(2, 9, "زبون صفر", 13, 0L, true),
        )
        val draft = v.copy(sourceTotalCents = 500L, checkedTotalCents = 500L, rows = rows)
        assertEquals(PdfDebtMigration.Decision.Verified(500L, 3), PdfDebtMigration.validate(draft))
        assertEquals(PdfDebtMigration.Decision.Verified(0L, 3), PdfDebtMigration.validate(
            draft.copy(sourceTotalCents = 0L, checkedTotalCents = 0L,
                rows = rows.mapIndexed { index, r -> if (index == 1) r.copy(amountCents = -2_000L) else r })
        ))
        assertEquals(PdfDebtMigration.Decision.Verified(-500L, 3), PdfDebtMigration.validate(
            draft.copy(sourceTotalCents = -500L, checkedTotalCents = -500L,
                rows = rows.mapIndexed { index, r -> if (index == 1) r.copy(amountCents = -2_500L) else r })
        ))
        assertTrue(PdfDebtMigration.validate(draft.copy(checkedTotalCents = 2_000L))
            is PdfDebtMigration.Decision.Blocked) // إهمال الدائن لا يُطابق صافي المصدر
    }

    @Test fun `يرفض المبلغ الناقص أو الخارج عن الحد واختلاف المجاميع`() {
        val v = valid()
        for (amount in listOf<Long?>(null, 100_000_000_000_001L, -100_000_000_000_001L, Long.MIN_VALUE, Long.MAX_VALUE)) {
            assertTrue(PdfDebtMigration.validate(v.copy(rows = listOf(v.rows[0].copy(amountCents = amount), v.rows[1])))
                is PdfDebtMigration.Decision.Blocked)
        }
        assertTrue(PdfDebtMigration.validate(v.copy(checkedTotalCents = 3_400)) is PdfDebtMigration.Decision.Blocked)
        assertTrue(PdfDebtMigration.validate(v.copy(sourceTotalCents = 3_400)) is PdfDebtMigration.Decision.Blocked)
        assertTrue(PdfDebtMigration.validate(v.copy(checkedTotalCents = null)) is PdfDebtMigration.Decision.Blocked)
    }
}
