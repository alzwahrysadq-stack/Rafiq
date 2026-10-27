package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DebtFollowUpTest {
    private lateinit var db: RafiqDatabase
    private var ownerId = 0L

    @Before fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
    }

    @After fun tearDown() { db.close() }

    @Test fun `الدفعات تسدد الأقدم ولا تُسمى الديون الجديدة متعثرة`() {
        val id = db.customers().insert(CustomerEntity(
            name = "زبون", openingCents = 1000L, createdAt = "2026-08-01 00:00:00"))
        val customer = db.customers().getById(id)!!
        db.invoices().insert(InvoiceEntity(number = 1, userId = ownerId, customerId = id,
            createdAt = "2026-08-20 00:00:00", dueCents = 2000L, totalCents = 2000L))
        db.invoices().insert(InvoiceEntity(number = 2, userId = ownerId, customerId = id,
            createdAt = "2026-10-05 00:00:00", dueCents = 3000L, totalCents = 3000L))
        db.payments().insert(PaymentEntity(customerId = id, amountCents = 2000L, userId = ownerId))
        assertEquals("2026-08-20", DebtFollowUp.oldestUnpaidDate(db, customer))
        val alert = DebtFollowUp.alert(db, customer, SalesRepository(db).customerBalance(id), "2026-10-14", 30)
        assertTrue(alert != null)
        assertEquals(55, alert!!.ageDays)
        db.payments().insert(PaymentEntity(customerId = id, amountCents = 1000L, userId = ownerId))
        assertEquals("2026-10-05", DebtFollowUp.oldestUnpaidDate(db, customer))
        assertNull(DebtFollowUp.alert(db, customer, SalesRepository(db).customerBalance(id), "2026-10-14", 30))
    }

    @Test fun `فاتورة ملغاة ورصيد مسدد لا يظهران في المتابعة`() {
        val id = db.customers().insert(CustomerEntity(name = "زبون", createdAt = "2026-01-01 00:00:00"))
        val customer = db.customers().getById(id)!!
        db.invoices().insert(InvoiceEntity(number = 9, userId = ownerId, customerId = id,
            createdAt = "2026-01-01 00:00:00", dueCents = 1000L, status = "cancelled"))
        assertNull(DebtFollowUp.oldestUnpaidDate(db, customer))
        assertNull(DebtFollowUp.alert(db, customer, 0L, "2026-10-14", 30))
    }
}
