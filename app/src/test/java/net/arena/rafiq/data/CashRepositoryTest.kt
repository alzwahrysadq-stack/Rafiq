package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** منقول من test_cash_drawer.py — نقاط القبول الخمس للمالك. */
@RunWith(RobolectricTestRunner::class)
class CashRepositoryTest {

    private lateinit var db: RafiqDatabase
    private lateinit var cash: CashRepository
    private lateinit var sales: SalesRepository
    private var ownerId = 0L
    private var workerId = 0L

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        cash = CashRepository(db)
        sales = SalesRepository(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
        workerId = db.users().getAll().first { it.role == "worker" }.id
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun product(price: Long, stock: Double = 10.0): Long = db.products().insert(
        ProductEntity(name = "صنف تجربة", barcode = null, priceCents = price, stock = stock)
    )

    private fun customer(opening: Long = 0L): Long =
        db.customers().insert(CustomerEntity(name = "زبون تجربة", openingCents = opening))

    private fun drawerTotal(): Long = db.cashMovements().getAll().sumOf { it.amountCents }

    private fun lastMovement(): CashMovementEntity =
        db.cashMovements().getAll().maxBy { it.id }

    // ==================== ١) الحساب بالسنت ====================

    @Test
    fun `عهدة افتتاح سالبة لا تفتح وردية ولا تضيف حركة`() {
        assertTrue(cash.open(-100L, ownerId) is RepoResult.Failed)
        assertEquals(null, cash.openShift())
        assertEquals(0, db.cashMovements().getAll().size)
    }

    @Test
    fun `عهدة 5000 + بيع 100 + تحصيل 50 - إخراج 30 = 5120 بالسنت`() {
        val pid = product(10000)
        val cid = customer()
        openShift(500000L)
        sales.createSale(
            SaleRequest(listOf(RequestedLine(pid, 1.0)), paymentType = "cash", receivedCents = 10000L), ownerId
        )
        sales.recordPayment(cid, 5000L, "", ownerId)
        cash.manualMovement("expense", 3000L, "مصروف متجر", "نقل", ownerId)
        assertEquals(512000L, drawerTotal())
    }

    @Test
    fun `البيع النقدي يدخل الدرج تلقائياً`() {
        val pid = product(1300)
        openShift(0L)
        sales.createSale(
            SaleRequest(listOf(RequestedLine(pid, 2.0)), paymentType = "cash", receivedCents = 3000L), ownerId
        )
        val m = lastMovement()
        assertEquals("sale", m.kind)
        assertEquals(2600L, m.amountCents)
    }

    @Test
    fun `البيع الآجل لا يدخل الدرج`() {
        val pid = product(1000)
        val cid = customer()
        openShift(0L)
        sales.createSale(
            SaleRequest(listOf(RequestedLine(pid, 1.0)), paymentType = "credit", customerId = cid), ownerId
        )
        assertEquals(0L, drawerTotal())
    }

    @Test
    fun `الفارق يُحسب في حالتي العجز والزيادة`() {
        openShift(10000L)
        val r1 = cash.close(9700L, "خطأ في العدّ", ownerId) as RepoResult.Ok<Long>
        assertEquals(-300L, r1.value)
        openShift(10000L)
        val r2 = cash.close(10400L, "فكّة ناقصة/زائدة", ownerId) as RepoResult.Ok<Long>
        assertEquals(400L, r2.value)
    }

    @Test
    fun `لا فارق لا يحتاج سبباً`() {
        openShift(10000L)
        val r = cash.close(10000L, "", ownerId)
        assertTrue(r is RepoResult.Ok)
        assertEquals(null, cash.openShift())
    }

    // ==================== ٢) السبب الإلزامي ====================

    @Test
    fun `الحركة اليدوية بلا سبب تُرفض ولا تُسجَّل`() {
        openShift(10000L)
        val before = drawerTotal()
        assertTrue(cash.manualMovement("income", 1000L, "", "", ownerId) is RepoResult.Failed)
        assertTrue(cash.manualMovement("expense", 1000L, "", "", ownerId) is RepoResult.Failed)
        assertEquals(before, drawerTotal())
    }

    @Test
    fun `سبب خارج القائمة يُرفض`() {
        openShift(10000L)
        val before = drawerTotal()
        assertTrue(cash.manualMovement("expense", 1000L, "سبب مخترع", "", ownerId) is RepoResult.Failed)
        assertEquals(before, drawerTotal())
    }

    @Test
    fun `سبب من القائمة يُسجَّل ويُحفظ مع الملاحظة`() {
        openShift(10000L)
        cash.manualMovement("expense", 1000L, "مصروف متجر", "كهرباء", ownerId)
        val m = lastMovement()
        assertEquals("expense", m.kind)
        assertEquals(-1000L, m.amountCents)
        assertEquals("مصروف متجر", m.reason)
        assertEquals("كهرباء", m.note)
    }

    @Test
    fun `لا إغلاق بفارق بلا سبب`() {
        openShift(10000L)
        assertTrue(cash.close(9000L, "", ownerId) is RepoResult.Failed)
        assertTrue(cash.openShift() != null)
    }

    @Test
    fun `سحب المالك للمالك فقط`() {
        openShift(10000L)
        val before = drawerTotal()
        assertTrue(cash.manualMovement("withdraw", 1000L, "سحب للمالك", "", workerId) is RepoResult.Failed)
        assertEquals(before, drawerTotal())
        assertTrue(cash.manualMovement("withdraw", 1000L, "سحب للمالك", "", ownerId) is RepoResult.Ok)
    }

    // ==================== ٣) السجل والتقرير ====================

    @Test
    fun `السجل يُظهر من فعل الحركة`() {
        openShift(0L)
        cash.manualMovement("income", 2000L, "إيداع من المالك", "", ownerId)
        assertEquals(ownerId, lastMovement().userId)
    }

    @Test
    fun `الحركات تطابق الرصيد المتوقع بالضبط`() {
        val pid = product(10000)
        val cid = customer()
        openShift(500000L)
        sales.createSale(
            SaleRequest(listOf(RequestedLine(pid, 1.0)), paymentType = "cash", receivedCents = 10000L), ownerId
        )
        sales.recordPayment(cid, 5000L, "", ownerId)
        cash.manualMovement("expense", 3000L, "مصروف متجر", "", ownerId)
        cash.manualMovement("income", 700L, "دخل متنوع", "", ownerId)
        assertEquals(512700L, cash.expectedNow())
    }

    @Test
    fun `لا تُفتح وردية ثانية أثناء وجود وردية مفتوحة`() {
        openShift(5000L)
        assertTrue(cash.open(99900L, ownerId) is RepoResult.Failed)
        assertEquals(1, countOpen())

    }

    @Test
    fun `لا حركة بلا وردية مفتوحة`() {
        val before = drawerTotal()
        assertTrue(cash.manualMovement("expense", 500L, "مصروف متجر", "", ownerId) is RepoResult.Failed)
        assertEquals(before, drawerTotal())
    }

    @Test
    fun `العامل يسجّل مصروفاً ولا يسحب`() {
        openShift(10000L)
        assertTrue(cash.manualMovement("expense", 300L, "مصروف متجر", "", workerId) is RepoResult.Ok)
        assertEquals(-300L, lastMovement().amountCents)
    }

    // ==================== مساعدات ====================

    private fun openShift(openingCents: Long) {
        // إغلاق أي وردية سابقة مطابقة حتى تُفتح جديدة (بعدّ مطابق للمتوقع)
        cash.openShift()?.let {
            val expected = db.cashMovements().sumForShift(it.id)
            cash.close(expected, "", ownerId)
        }
        assertTrue(cash.open(openingCents, ownerId) is RepoResult.Ok)
    }

    private fun countOpen(): Int = db.shifts().let { if (it.getOpen() != null) 1 else 0 }
}
