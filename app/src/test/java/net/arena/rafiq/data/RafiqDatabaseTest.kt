package net.arena.rafiq.data

import android.database.sqlite.SQLiteConstraintException
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * اختبارات المرحلة 2: الجداول، البذور، تخزين المبالغ، المفاتيح الأجنبية، الحذف المتسلسل.
 * تعمل على Robolectric (بدون جهاز أو محاكي).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RafiqDatabaseTest {

    private lateinit var db: RafiqDatabase

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
    }

    @After
    fun tearDown() {
        db.close()
    }

    /** قراءة قيمة واحدة من SQL مباشرة. */
    private fun scalar(sql: String): String =
        db.openHelper.readableDatabase.query(sql).use { c ->
            c.moveToFirst()
            c.getString(0)
        }

    private fun ownerId(): Long = db.users().getAll().first { it.role == "owner" }.id

    @Test
    fun createsFourteenRoomTablesAndThreeAuxiliaryTables() {
        val names = mutableSetOf<String>()
        db.openHelper.readableDatabase
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'room_%' AND name NOT LIKE 'android_%'")
            .use { c ->
                while (c.moveToNext()) names.add(c.getString(0))
            }
        val expected = setOf(
            "users", "settings", "products", "customers", "shifts", "invoices",
            "invoice_items", "payments", "cash_movements", "imports_log",
            "suppliers", "supplier_transactions", "supplier_visits", "ledger_entries",
            // جداول إضافية خارج Room تُنشأ عند كل فتح لحفظها جميعاً في النسخة
            "invoice_payments", "login_guard", "wa_log",
            "ofx_ops", "mirror_rows", "sync_meta",
        )
        assertEquals(expected, names)
    }

    @Test
    fun productsTableHasLocationIndexes() {
        // الممر والباركود والاسم مفهرسة للبحث السريع (5000 صنف)
        var count = 0
        db.openHelper.readableDatabase.query("PRAGMA index_list('products')").use { c ->
            while (c.moveToNext()) count++
        }
        assertTrue("عدد فهارس products = $count", count >= 3)
    }

    @Test
    fun seedsThreeUsersWithRoles() {
        val users = db.users().getAll()
        assertEquals(3, users.size)
        val owner = users.single { it.role == "owner" }
        assertEquals("1111", owner.pin)
        assertEquals(2, users.count { it.role == "worker" })
    }

    @Test
    fun seedsDefaultSettingsIncludingCountryCode967() {
        val map = db.settings().getAll().associate { it.key to it.value }
        assertEquals(RafiqDatabase.DEFAULT_SETTINGS.size, map.size)
        assertEquals("967", map["country_code"])
        assertEquals("ريال", map["currency"])
        assertEquals("1", map["allow_negative_stock"])
        assertEquals("0", map["allow_price_edit"])
    }

    @Test
    fun moneyIsStoredAsInteger() {
        val id = db.customers().insert(CustomerEntity(name = "علي", openingCents = 5000L))
        assertEquals("integer", scalar("SELECT typeof(opening_cents) FROM customers WHERE id = $id"))
        assertEquals(5000L, db.customers().getById(id)!!.openingCents)
    }

    @Test
    fun fractionalStockIsExact() {
        // 0.75 كغ — يجب أن تبقى الكمية الكسرية كما هي دون تقريب
        val id = db.products().insert(ProductEntity(name = "طماطم", priceCents = 1000L, stock = 0.75))
        val p = db.products().getById(id)
        assertNotNull(p)
        assertEquals(0.75, p!!.stock, 0.0)
        assertEquals("real", scalar("SELECT typeof(stock) FROM products WHERE id = $id"))
    }

    @Test
    fun findsProductByBarcode() {
        db.products().insert(ProductEntity(name = "حليب", barcode = "6221234567890", priceCents = 300L))
        val found = db.products().findByBarcode("6221234567890")
        assertNotNull(found)
        assertEquals("حليب", found!!.name)
    }

    @Test
    fun foreignKeysAreEnforced() {
        // فاتورة لا وجود لها — يجب أن ترفضها قاعدة البيانات
        assertThrows(SQLiteConstraintException::class.java) {
            db.invoiceItems().insert(
                InvoiceItemEntity(invoiceId = 999L, name = "صنف وهمي", priceCents = 100L),
            )
        }
    }

    @Test
    fun deletingInvoiceCascadesToItems() {
        val invId = db.invoices().insert(
            InvoiceEntity(number = 1L, userId = ownerId(), totalCents = 500L),
        )
        db.invoiceItems().insert(
            InvoiceItemEntity(invoiceId = invId, name = "خبز", priceCents = 500L, totalCents = 500L),
        )
        db.openHelper.writableDatabase.execSQL("DELETE FROM invoices WHERE id = ?", arrayOf<Any>(invId))
        assertEquals("0", scalar("SELECT COUNT(*) FROM invoice_items"))
    }

    @Test
    fun cashMovementsSumPerShift() {
        val shiftId = db.shifts().insert(ShiftEntity(openedBy = ownerId(), openingCents = 0L))
        assertEquals(0L, db.cashMovements().sumForShift(shiftId))
        db.cashMovements().insert(CashMovementEntity(shiftId = shiftId, kind = "sale", amountCents = 1000L))
        db.cashMovements().insert(CashMovementEntity(shiftId = shiftId, kind = "expense", amountCents = -300L))
        assertEquals(700L, db.cashMovements().sumForShift(shiftId))
    }
}
