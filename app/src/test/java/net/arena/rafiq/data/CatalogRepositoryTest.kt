package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CatalogRepositoryTest {

    private lateinit var db: RafiqDatabase
    private lateinit var repo: CatalogRepository
    private var ownerId = 0L

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        repo = CatalogRepository(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun product(name: String, barcode: String? = null, aisle: String = "", shelf: String = "",
                        stock: Double = 10.0, lowStock: Double = 5.0, active: Int = 1): Long =
        db.products().insert(
            ProductEntity(name = name, barcode = barcode, aisle = aisle, shelf = shelf,
                stock = stock, lowStock = lowStock, active = active)
        )

    @Test
    fun `البحث الفارغ لا يعيد شيئاً`() {
        product("حليب")
        assertTrue(repo.search("   ").isEmpty())
    }

    @Test
    fun `البحث بالاسم أو الباركود ويتجاهل الأصناف غير النشطة`() {
        product("حليب طازج", barcode = "629001")
        product("حليب معلب", active = 0)
        product("خبز")
        assertEquals(listOf("حليب طازج"), repo.search("حليب").map { it.name })
        assertEquals(listOf("حليب طازج"), repo.search("629").map { it.name })
    }

    @Test
    fun `عبارة الموقع تعرض أصناف الممر`() {
        product("أرز", aisle = "3", shelf = "ب")
        product("سكر", aisle = "3")
        product("ملح", aisle = "5")
        val r = repo.find("ممر 3")
        assertEquals("location", r.mode)
        assertEquals(setOf("أرز", "سكر"), r.products.map { it.name }.toSet())
    }

    @Test
    fun `إذا لم يوجد موقع مطابق يُبحث بالاسم`() {
        product("3 قطع صابون", aisle = "1")
        val r = repo.find("3")
        assertEquals("name", r.mode)
        assertEquals(listOf("3 قطع صابون"), r.products.map { it.name })
    }

    @Test
    fun `لوحة اليوم تحسب الفواتير المفتوحة وتعد الملغاة فقط`() {
        product("أرز", stock = 2.0, lowStock = 5.0)
        product("سكر", stock = 50.0, lowStock = 5.0)
        val day = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        db.invoices().insert(InvoiceEntity(number = 1, userId = ownerId, totalCents = 1000, paidCents = 400, dueCents = 600))
        db.invoices().insert(InvoiceEntity(number = 2, userId = ownerId, totalCents = 500, paidCents = 500, dueCents = 0))
        db.invoices().insert(InvoiceEntity(number = 3, userId = ownerId, totalCents = 700, status = "cancelled"))
        val s = repo.dashboard(day, debtsTotalCents = 600)
        assertEquals(2, s.salesCount)
        assertEquals(1500L, s.salesTotalCents)
        assertEquals(900L, s.salesPaidCents)
        assertEquals(600L, s.newDebtCents)
        assertEquals(1, s.cancelledCount)
        assertEquals(2, s.productCount)
        assertEquals(1, s.lowStockCount)
        assertEquals(600L, s.debtsTotalCents)
    }

    @Test
    fun `إضافة وجه مشترك تحفظ الرصيد الحقيقي في الأصل دون ترحيل قاعدة البيانات`() {
        val root = product("ماء عادي", barcode = "W-1", stock = 4.0)
        val r = repo.saveProduct(null, mapOf(
            "name" to "ماء بارد", "barcode" to "W-1", "price" to "3",
            "stock" to "99", "shared_stock_with" to root.toString(),
        ))
        assertTrue(r is RepoResult.Ok)
        val child = db.products().allByBarcode("W-1").single { it.name == "ماء بارد" }
        assertEquals(0.0, child.stock, 0.0)
        assertEquals(root, StockSharing.linkedRootId(db, child.id))
        assertEquals(4.0, StockSharing.availableStock(db, child)!!, 0.0)
        assertEquals(1, db.catalog().lowStockCount()) // الجذر فقط عند انخفاض رصيده
        val invalid = repo.saveProduct(null, mapOf(
            "name" to "ماء ثلج", "barcode" to "X-1", "price" to "4",
            "shared_stock_with" to root.toString(),
        ))
        assertTrue(invalid is RepoResult.Failed)
        assertEquals(2, db.products().allByBarcode("W-1").size)
        assertTrue(repo.saveProduct(root, mapOf("name" to "ماء عادي", "barcode" to "W-2",
            "price" to "2", "stock" to "4")) is RepoResult.Ok)
        assertEquals(setOf(root, child.id), db.products().allByBarcode("W-2").map { it.id }.toSet())
        assertEquals(root, StockSharing.linkedRootId(db, child.id))
        assertEquals(0, db.products().allByBarcode("W-1").size)
    }

    @Test
    fun `كشف الزبون يجمع المرحّل والفواتير والدفعات بالرصيد الجاري`() {
        val sales = SalesRepository(db)
        val cid = db.customers().insert(CustomerEntity(name = "علي", openingCents = 15000))
        db.invoices().insert(InvoiceEntity(number = 7, userId = ownerId, customerId = cid,
            totalCents = 2000, dueCents = 2000, paymentType = "credit"))
        db.payments().insert(PaymentEntity(customerId = cid, amountCents = 7000, userId = ownerId))
        val events = sales.statement(cid)!!
        assertEquals(3, events.size)
        assertEquals(10000L, events[0].balanceAfterCents)   // الدفعة هي الأحدث
        assertEquals("صاحب المتجر", events[0].userName)
        assertEquals(15000L, events[2].balanceAfterCents)
    }

    @Test
    fun `كشف زبون غير موجود يعيد null`() {
        assertEquals(null, SalesRepository(db).statement(999L))
    }
}
