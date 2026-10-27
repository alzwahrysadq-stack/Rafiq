package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * اختبارات المستودع على قاعدة بيانات حقيقية في الذاكرة.
 * تقابل تدفقات النسخة الأصلية: البيع النقدي، والآجل، والإلغاء، والدفعات، والدين اليدوي.
 */
@RunWith(RobolectricTestRunner::class)
class SalesRepositoryTest {

    private lateinit var db: RafiqDatabase
    private lateinit var repo: SalesRepository
    private var ownerId = 0L

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        repo = SalesRepository(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun openShift(openingCents: Long = 0L): Long {
        val id = db.shifts().insert(ShiftEntity(openedBy = ownerId, openingCents = openingCents))
        db.cashMovements().insert(
            CashMovementEntity(shiftId = id, kind = "open", amountCents = openingCents, note = "بداية الوردية", userId = ownerId)
        )
        return id
    }

    private fun product(name: String = "شاي", priceCents: Long = 1000L, stock: Double = 10.0): Long =
        db.products().insert(ProductEntity(name = name, priceCents = priceCents, stock = stock))

    private fun customer(name: String = "عم محمد", openingCents: Long = 0L): Long =
        db.customers().insert(CustomerEntity(name = name, openingCents = openingCents))

    private fun stockOf(productId: Long): Double = db.products().getById(productId)!!.stock

    private fun ok(r: RepoResult<*>) {
        assertTrue("توقعنا النجاح، لكن جاء: $r", r is RepoResult.Ok<*>)
    }

    private fun failMessage(r: RepoResult<*>): String {
        assertTrue("توقعنا الرفض، لكن جاء: $r", r is RepoResult.Failed)
        return (r as RepoResult.Failed).message
    }

    // ---------- البيع النقدي ----------

    @Test
    fun `البيع النقدي يحفظ الفاتورة ويخصم المخزون ويسجل حركة الدرج`() {
        val shiftId = openShift()
        val pid = product(priceCents = 1000L, stock = 10.0)

        val r = repo.createSale(
            SaleRequest(lines = listOf(RequestedLine(pid, qty = 2.0)), paymentType = "cash", receivedCents = 2000L),
            ownerId,
        ) as RepoResult.Ok

        assertEquals(2000L, r.value.totalCents)
        assertEquals(0L, r.value.changeCents)
        assertEquals(8.0, stockOf(pid), 0.0)
        assertEquals(2000L, repo.expectedCashForShift(shiftId))   // بداية 0 + بيع 2000
        val inv = db.invoices().getById(r.value.invoiceId)!!
        assertEquals("cash", inv.paymentType)
        assertEquals(null, inv.customerId)
    }

    @Test
    fun `رقم الفاتورة يتزايد من فاتورة إلى أخرى`() {
        openShift()
        val pid = product(stock = 10.0)
        val first = repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId) as RepoResult.Ok
        val second = repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId) as RepoResult.Ok
        assertEquals(1L, first.value.number)
        assertEquals(2L, second.value.number)
    }

    @Test
    fun `الكسر في الكمية يُقرَّب إلى ريال كامل في الفاتورة`() {
        openShift()
        val pid = product(priceCents = 1000L, stock = 10.0)
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid, qty = 0.75)), "cash", receivedCents = 1000L), ownerId,
        ) as RepoResult.Ok
        assertEquals(800L, r.value.totalCents)     // 7.50 → 8 ريال
        assertEquals(200L, r.value.changeCents)    // 10 − 8
        assertEquals(800L, db.invoices().getById(r.value.invoiceId)!!.totalCents)
    }

    @Test
    fun `البيع يُرفض والصندوق مغلق ولا يُكتب شيء`() {
        val pid = product(stock = 10.0)
        val msg = failMessage(
            repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId)
        )
        assertEquals("الصندوق مغلق — افتح الوردية أولاً", msg)
        assertEquals(10.0, stockOf(pid), 0.0)
        assertEquals(0, db.invoices().nextNumber().toInt() - 1)
    }

    @Test
    fun `الرصيد غير الكافي يُرفض عند إغلاق السماح بالسالب`() {
        openShift()
        db.settings().upsert(SettingEntity("allow_negative_stock", "0"))
        val pid = product(name = "حليب", stock = 1.0)
        val msg = failMessage(
            repo.createSale(SaleRequest(listOf(RequestedLine(pid, qty = 3.0)), "cash", receivedCents = 9999L), ownerId)
        )
        assertEquals("رصيد غير كافٍ: حليب (المتاح 1)", msg)
        assertEquals(1.0, stockOf(pid), 0.0)
    }

    @Test
    fun `الرصيد السالب مسموح افتراضياً`() {
        openShift()
        val pid = product(stock = 0.0)
        ok(repo.createSale(SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "cash", receivedCents = 2000L), ownerId))
        assertEquals(-2.0, stockOf(pid), 0.0)
    }

    @Test
    fun `وجهان بسعرين يشتركان في الرصيد ويعيد الإلغاء الكمية إلى الأصل`() {
        openShift()
        db.settings().upsert(SettingEntity("allow_negative_stock", "0"))
        val root = db.products().insert(ProductEntity(name = "ماء عادي", barcode = "WA-1", priceCents = 100L, stock = 5.0))
        val variant = db.products().insert(ProductEntity(name = "ماء بارد", barcode = "WA-1", priceCents = 150L, stock = 0.0))
        db.settings().upsert(SettingEntity(StockSharing.key(variant), root.toString()))

        val tooMany = repo.createSale(
            SaleRequest(listOf(RequestedLine(root, 3.0), RequestedLine(variant, 3.0)),
                "cash", receivedCents = 9999L), ownerId,
        )
        assertTrue(tooMany is RepoResult.Failed)
        assertEquals(5.0, stockOf(root), 0.0)
        assertEquals(1L, db.invoices().nextNumber())

        val sale = repo.createSale(
            SaleRequest(listOf(RequestedLine(root, 1.0), RequestedLine(variant, 2.0)),
                "cash", receivedCents = 400L), ownerId,
        ) as RepoResult.Ok
        assertEquals(400L, sale.value.totalCents)
        assertEquals(2.0, stockOf(root), 0.0)
        assertEquals(0.0, stockOf(variant), 0.0)
        assertEquals(listOf("ماء عادي", "ماء بارد"),
            db.invoiceItems().getByInvoice(sale.value.invoiceId).map { it.name })
        val unlink = CatalogRepository(db).saveProduct(variant,
            mapOf("name" to "ماء بارد", "barcode" to "WA-1", "price" to "1.5", "shared_stock_with" to ""))
        assertTrue("فصل وجه بيع له فواتير قديمة قد يفسد إلغاءها", unlink is RepoResult.Failed)
        db.settings().upsert(SettingEntity(StockSharing.key(variant), "not-a-root"))
        assertTrue(repo.cancelInvoice(sale.value.invoiceId, ownerId) is RepoResult.Failed)
        assertEquals(2.0, stockOf(root), 0.0) // لا ردّ جزئي للسطر الأول
        assertEquals("open", db.invoices().getById(sale.value.invoiceId)!!.status)
        db.settings().upsert(SettingEntity(StockSharing.key(variant), root.toString()))
        ok(repo.cancelInvoice(sale.value.invoiceId, ownerId))
        assertEquals(5.0, stockOf(root), 0.0)
        assertEquals(0.0, stockOf(variant), 0.0)
    }

    @Test
    fun `باركود واحد برصيدين مستقلين لا يخصم إلا الوجه المختار`() {
        openShift()
        db.settings().upsert(SettingEntity("allow_negative_stock", "0"))
        val coffee = db.products().insert(ProductEntity(name = "بن محوج", barcode = "BEAN-1", priceCents = 100L, stock = 2.0))
        val cumin = db.products().insert(ProductEntity(name = "كمون", barcode = "BEAN-1", priceCents = 200L, stock = 9.0))
        ok(repo.createSale(SaleRequest(listOf(RequestedLine(coffee, 1.0)), "cash", receivedCents = 100L), ownerId))
        assertEquals(1.0, stockOf(coffee), 0.0)
        assertEquals(9.0, stockOf(cumin), 0.0)
    }

    // ---------- البيع الآجل والزبائن ----------

    @Test
    fun `البيع الآجل ينشئ دَيناً على الزبون ولا يلمس الدرج إلا بالمدفوع`() {
        val shiftId = openShift()
        val pid = product(priceCents = 800L, stock = 10.0)
        val cid = customer(openingCents = 0L)
        ok(
            repo.createSale(
                SaleRequest(listOf(RequestedLine(pid, qty = 3.0)), "credit", customerId = cid, paidCents = 400L),
                ownerId,
            )
        )
        assertEquals(2000L, repo.customerBalance(cid))        // 24 − 4
        assertEquals(400L, repo.expectedCashForShift(shiftId)) // المدفوع فقط
    }

    @Test
    fun `الآجل يتطلب زبوناً`() {
        openShift()
        val pid = product()
        assertEquals(
            "اختر الزبون الآجل",
            failMessage(repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "credit"), ownerId)),
        )
    }

    @Test
    fun `الدين المرحّل مع الفواتير ناقص الدفعات`() {
        openShift()
        val pid = product(priceCents = 1000L, stock = 50.0)
        val cid = customer(openingCents = 15000L)              // 150 مرحّلة
        ok(repo.createSale(SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "credit", customerId = cid), ownerId))
        assertEquals(17000L, repo.customerBalance(cid))         // 150 + 20
        ok(repo.recordPayment(cid, 7000L, "", ownerId))         // دفعة 70
        assertEquals(10000L, repo.customerBalance(cid))
    }

    @Test
    fun `الكشف بعد أكثر من 200 دفعة يطابق الرصيد ولا يخفي أسماء مُدخليها`() {
        openShift()
        val cid = customer(openingCents = 40_000L)
        val worker = db.users().getAll().first { it.role == "worker" }
        repeat(205) { i ->
            ok(repo.recordPayment(cid, 100L, "دفعة $i", if (i % 2 == 0) ownerId else worker.id))
        }
        val statement = repo.statement(cid)!!
        assertEquals(206, statement.size) // 205 دفعات + الرصيد المرحّل، لا آخر 200 فقط.
        assertTrue(repo.accountSnapshot(cid)!!.reconciles)
        assertEquals(19_500L, repo.customerBalance(cid))
        assertEquals(repo.customerBalance(cid), statement.first().balanceAfterCents)
        assertEquals(205, statement.count { it.kind == net.arena.rafiq.domain.CustomerStatement.Kind.TAKEN })
        assertEquals(db.users().getById(ownerId)!!.name, statement.first().userName)
        assertEquals(worker.name, statement[1].userName)
    }

    @Test
    fun `الكشف بعد أكثر من 200 فاتورة آجل يطابق الرصيد ولا يفقد أول فاتورة`() {
        openShift()
        val pid = product(priceCents = 100L, stock = 210.0)
        val cid = customer()
        repeat(205) {
            ok(repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "credit", customerId = cid), ownerId))
        }
        val statement = repo.statement(cid)!!
        assertEquals(205, statement.size)
        assertTrue(repo.accountSnapshot(cid)!!.reconciles)
        assertEquals(20_500L, repo.customerBalance(cid))
        assertEquals(repo.customerBalance(cid), statement.first().balanceAfterCents)
        assertEquals(1L, statement.last().invoiceId)
    }

    @Test
    fun `الكشف ينسب الدين اليدوي لمُدخله ولا يُخلط مع دفعة المالك`() {
        openShift()
        val cid = customer()
        val worker = db.users().getAll().first { it.role == "worker" }
        ok(repo.recordDebit(cid, 1_000L, "من العامل", worker.id))
        ok(repo.recordPayment(cid, 200L, "من المالك", ownerId))
        val events = repo.statement(cid)!!
        assertEquals(800L, events.first().balanceAfterCents)
        assertEquals(db.users().getById(ownerId)!!.name, events.first().userName)
        assertEquals(worker.name, events.last().userName)
    }

    @Test
    fun `الدفعة تُسجَّل كتحصيل في الدرج`() {
        val shiftId = openShift()
        val cid = customer(openingCents = 5000L)
        ok(repo.recordPayment(cid, 3000L, "", ownerId))
        assertEquals(3000L, repo.expectedCashForShift(shiftId) - 0L)
        assertEquals(2000L, repo.customerBalance(cid))
        val kinds = db.cashMovements().getByShift(shiftId).map { it.kind }
        assertTrue(kinds.contains("collection"))
    }

    @Test
    fun `الدفعة تُرفض والصندوق مغلق ولا يتغير الرصيد`() {
        val cid = customer(openingCents = 5000L)
        assertEquals("الصندوق مغلق — افتح الوردية أولاً حتى تُسجَّل التحصيلات في الصندوق",
            failMessage(repo.recordPayment(cid, 1000L, "", ownerId)))
        assertEquals(5000L, repo.customerBalance(cid))
    }

    @Test
    fun `الدين اليدوي يزيد الرصيد ويرفض المبلغ الخاطئ`() {
        val cid = customer(openingCents = 0L)
        ok(repo.recordDebit(cid, 4000L, "بضاعة على الحساب", ownerId))
        assertEquals(4000L, repo.customerBalance(cid))
        assertEquals("اكتب مبلغاً صحيحاً", failMessage(repo.recordDebit(cid, 0L, "", ownerId)))
        assertEquals(4000L, repo.customerBalance(cid))
    }

    @Test
    fun `الدفعة لزبون غير موجود تُرفض ولا تُكتب`() {
        openShift()
        assertEquals("الزبون غير موجود", failMessage(repo.recordPayment(999L, 1000L, "", ownerId)))
        assertEquals(0, db.payments().getByCustomer(999L).size)
    }

    // ---------- الإلغاء ----------

    @Test
    fun `الإلغاء يُرجع المخزون ويعكس المدفوع في الدرج`() {
        val shiftId = openShift()
        val pid = product(priceCents = 1000L, stock = 10.0)
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "cash", receivedCents = 2000L), ownerId,
        ) as RepoResult.Ok
        assertEquals(8.0, stockOf(pid), 0.0)

        ok(repo.cancelInvoice(r.value.invoiceId, ownerId))

        assertEquals(10.0, stockOf(pid), 0.0)
        assertEquals("cancelled", db.invoices().getById(r.value.invoiceId)!!.status)
        assertEquals(0L, repo.expectedCashForShift(shiftId))   // 2000 بيع − 2000 إلغاء
    }

    @Test
    fun `لا يُلغى الفاتورة مرتين`() {
        openShift()
        val pid = product(stock = 10.0)
        val r = repo.createSale(SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId) as RepoResult.Ok
        ok(repo.cancelInvoice(r.value.invoiceId, ownerId))
        assertEquals(
            "الفاتورة غير موجودة أو ملغاة مسبقاً",
            failMessage(repo.cancelInvoice(r.value.invoiceId, ownerId)),
        )
        assertNotNull(db.invoices().getById(r.value.invoiceId))
    }

    @Test
    fun `إلغاء الفاتورة الآجلة بلا دفعة لا يحرك الدرج`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val cid = customer()
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid)), "credit", customerId = cid, paidCents = 0L), ownerId,
        ) as RepoResult.Ok
        ok(repo.cancelInvoice(r.value.invoiceId, ownerId))
        assertEquals(0L, repo.customerBalance(cid))            // الدين اختفى مع الإلغاء
        assertEquals(0L, repo.expectedCashForShift(shiftId))
    }

    @Test
    fun `فاتورة آجلة دُفع منها نقد فقط تُلغي النقد والدين في ورديتها`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val cid = customer()
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "credit", customerId = cid, paidCents = 500L), ownerId,
        ) as RepoResult.Ok
        assertEquals(500L, repo.expectedCashForShift(shiftId))
        assertEquals(1500L, repo.customerBalance(cid))
        ok(repo.cancelInvoice(r.value.invoiceId, ownerId))
        assertEquals(0L, repo.expectedCashForShift(shiftId))
        assertEquals(0L, repo.customerBalance(cid))
        assertEquals(10.0, stockOf(pid), 0.001)
    }

    @Test
    fun `إلغاء الدفع المختلط يُرفض بلا خصم حوالة من الدرج أو رد مخزون`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val r = repo.createSale(
            SaleRequest(
                listOf(RequestedLine(pid, qty = 2.0)), "cash", receivedCents = 500L,
                nonCash = listOf(net.arena.rafiq.domain.PaymentRules.Part("transfer", 1500L, "TR-7")),
            ), ownerId,
        ) as RepoResult.Ok
        assertEquals(500L, repo.expectedCashForShift(shiftId))
        assertTrue(failMessage(repo.cancelInvoice(r.value.invoiceId, ownerId)).contains("حوالة"))
        assertEquals("open", db.invoices().getById(r.value.invoiceId)!!.status)
        assertEquals(8.0, stockOf(pid), 0.001)
        assertEquals(500L, repo.expectedCashForShift(shiftId))
        assertEquals(0, db.cashMovements().getByShift(shiftId).count { it.kind == "cancel" })
    }

    @Test
    fun `فاتورة ورديتها مغلقة لا تُلغى حتى بعد فتح وردية جديدة`() {
        val oldShiftId = openShift()
        val pid = product(stock = 10.0)
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "cash", receivedCents = 2000L), ownerId,
        ) as RepoResult.Ok
        ok(CashRepository(db).close(2000L, "", ownerId))
        val newShiftId = openShift()
        assertTrue(failMessage(repo.cancelInvoice(r.value.invoiceId, ownerId)).contains("مغلقة"))
        assertEquals("open", db.invoices().getById(r.value.invoiceId)!!.status)
        assertEquals(8.0, stockOf(pid), 0.001)
        assertEquals(2000L, repo.expectedCashForShift(oldShiftId))
        assertEquals(0L, repo.expectedCashForShift(newShiftId))
        assertEquals(2000L, db.shifts().getById(oldShiftId)!!.expectedCents)
    }

    @Test
    fun `فاتورة آجلة حُصّل بعض دينها لا تُلغى إن صار رصيد الزبون سالباً`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val cid = customer()
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid, qty = 2.0)), "credit", customerId = cid), ownerId,
        ) as RepoResult.Ok
        ok(repo.recordPayment(cid, 1000L, "", ownerId))
        assertEquals(1000L, repo.customerBalance(cid))
        assertTrue(failMessage(repo.cancelInvoice(r.value.invoiceId, ownerId)).contains("تسوية رصيد"))
        assertEquals("open", db.invoices().getById(r.value.invoiceId)!!.status)
        assertEquals(8.0, stockOf(pid), 0.001)
        assertEquals(1000L, repo.expectedCashForShift(shiftId))
        assertEquals(1000L, repo.customerBalance(cid))
    }

    @Test
    fun `فاتورة نقدية قديمة دون صفوف وسائل دفع تُلغى بحسب حركة الصندوق`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId,
        ) as RepoResult.Ok
        db.openHelper.writableDatabase.execSQL(
            "DELETE FROM invoice_payments WHERE invoice_id = ?", arrayOf<Any>(r.value.invoiceId),
        )
        ok(repo.cancelInvoice(r.value.invoiceId, ownerId))
        assertEquals(10.0, stockOf(pid), 0.001)
        assertEquals(0L, repo.expectedCashForShift(shiftId))
    }

    @Test
    fun `لا يكتمل الإلغاء إن لم تطابق حركة النقد المدفوع في الفاتورة`() {
        val shiftId = openShift()
        val pid = product(stock = 10.0)
        val r = repo.createSale(
            SaleRequest(listOf(RequestedLine(pid)), "cash", receivedCents = 1000L), ownerId,
        ) as RepoResult.Ok
        db.openHelper.writableDatabase.execSQL(
            "UPDATE cash_movements SET amount_cents = 0 WHERE kind = 'sale' AND ref_id = ?",
            arrayOf<Any>(r.value.invoiceId),
        )
        assertTrue(failMessage(repo.cancelInvoice(r.value.invoiceId, ownerId)).contains("غير متطابقة"))
        assertEquals("open", db.invoices().getById(r.value.invoiceId)!!.status)
        assertEquals(9.0, stockOf(pid), 0.001)
        assertEquals(0L, repo.expectedCashForShift(shiftId))
    }
}
