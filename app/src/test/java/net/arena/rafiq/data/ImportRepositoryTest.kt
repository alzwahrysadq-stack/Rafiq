package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import net.arena.rafiq.domain.ImportRules
import net.arena.rafiq.domain.Money
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** بيانات وهمية فقط؛ لا تُحمّل قائمة المالك الفعلية في الاختبارات أو المستودع. */
@RunWith(RobolectricTestRunner::class)
class ImportRepositoryTest {
    private lateinit var db: RafiqDatabase
    private lateinit var repo: ImportRepository
    private var ownerId = 0L

    @Before fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        repo = ImportRepository(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
    }

    @After fun tearDown() { db.close() }

    private fun records(rows: List<Map<String, String?>>) =
        ImportRules.prepareProducts(rows) { Money.parse(it, null) }

    @Test fun `قائمة باركودات بلا كمية لا تصفر الصنف الموجود لكنها تضيف الجديد برصيد صفر`() {
        val existingId = db.products().insert(ProductEntity(name = "قديم", barcode = "CODE-1",
            costCents = 900L, priceCents = 1000L, stock = 12.0))
        val items = records(listOf(
            linkedMapOf("barcode" to "CODE-1", "item_name" to "محدث", "cost_price" to "11",
                "selling_price" to "15"),
            linkedMapOf("barcode" to "CODE-2", "item_name" to "جديد", "cost_price" to "21",
                "selling_price" to "25"),
        ))
        assertEquals(listOf(false, false), items.map { it.stockProvided })
        val counts = repo.commitProducts(items, "test-only.csv", ownerId)
        assertEquals(1, counts.added)
        assertEquals(1, counts.updated)
        val updated = db.products().getById(existingId)!!
        assertEquals(12.0, updated.stock, 0.0)
        assertEquals(1500L, updated.priceCents)
        assertEquals(1100L, updated.costCents)
        val added = db.catalog().anyProductByBarcode("CODE-2")
        assertNotNull(added)
        assertEquals(0.0, added!!.stock, 0.0)
    }

    @Test fun `كمية صريحة تحدث الرصيد وغير الرقمية لا تُعتمد`() {
        val id = db.products().insert(ProductEntity(name = "صنف", barcode = "CODE-3",
            priceCents = 1000L, stock = 12.0))
        val ok = records(listOf(mapOf("barcode" to "CODE-3", "item_name" to "صنف",
            "selling_price" to "16", "stock" to "3")))
        assertEquals(true, ok.single().stockProvided)
        assertEquals(1, repo.commitProducts(ok, "stock.csv", ownerId).updated)
        assertEquals(3.0, db.products().getById(id)!!.stock, 0.0)
        val broken = records(listOf(mapOf("barcode" to "CODE-3", "item_name" to "صنف",
            "selling_price" to "99", "stock" to "غير معروف")))
        assertEquals(ImportRules.Status.ERROR, broken.single().status)
        assertEquals(1, repo.commitProducts(broken, "bad-stock.csv", ownerId).errors)
        assertEquals(3.0, db.products().getById(id)!!.stock, 0.0)
        assertEquals(1600L, db.products().getById(id)!!.priceCents)
    }
}
