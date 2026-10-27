package net.arena.rafiq.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DatabaseSnapshotsTest {
    private lateinit var context: Context
    private lateinit var live: RafiqDatabase
    private lateinit var liveName: String
    private val stages = mutableListOf<java.io.File>()

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        liveName = "rafiq-snapshot-${UUID.randomUUID()}.db"
        live = RafiqDatabase.build(context, fileName = liveName)
    }

    @After fun tearDown() {
        live.close()
        stages.forEach { DatabaseSnapshots.discard(context, it) }
        context.deleteDatabase(liveName)
    }

    private fun count(db: RafiqDatabase, table: String): Long =
        db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM \"$table\"").use { c -> c.moveToFirst(); c.getLong(0) }

    /** قاعدة الملف لا تسمح باستعلامات على خيط الواجهة؛ يقلّد خيط جسر WebView الحقيقي. */
    private fun inWorker(block: () -> Unit) {
        var failure: Throwable? = null
        val t = Thread { try { block() } catch (e: Throwable) { failure = e } }
        t.start()
        t.join()
        failure?.let { throw it }
    }

    @Test fun `تُنسخ الجداول التجارية والإضافية من قاعدة WAL في لحظة واحدة دون تعديل الأصل`() = inWorker {
        val owner = live.users().getAll().single { it.role == "owner" }.id
        val product = live.products().insert(ProductEntity(name = "أرز", stock = 17.5, priceCents = 2700L))
        val customer = live.customers().insert(CustomerEntity(name = "عميل", phone = "777000111"))
        val shift = live.shifts().insert(ShiftEntity(openedBy = owner))
        val invoice = live.invoices().insert(InvoiceEntity(number = 7L, userId = owner,
            customerId = customer, shiftId = shift, totalCents = 2700L, paidCents = 700L, dueCents = 2000L))
        live.invoiceItems().insert(InvoiceItemEntity(invoiceId = invoice, productId = product,
            name = "أرز", qty = 1.0, priceCents = 2700L, totalCents = 2700L))
        live.cashMovements().insert(CashMovementEntity(shiftId = shift, kind = "sale", amountCents = 700L,
            refType = "invoice", refId = invoice, userId = owner))
        live.openHelper.writableDatabase.execSQL(
            "INSERT INTO invoice_payments(invoice_id,method,amount_cents,reference) VALUES(?, 'cash',700,'')",
            arrayOf<Any>(invoice),
        )
        live.openHelper.writableDatabase.execSQL("INSERT INTO login_guard(uid,fails,locked_until) VALUES(?,?,?)",
            arrayOf<Any>(owner, 2, 8000L))
        live.openHelper.writableDatabase.execSQL("INSERT INTO wa_log(created_at,invoice_id,status,detail) VALUES(?,?,?,?)",
            arrayOf<Any>("2026-10-14 10:00:00", invoice, "skipped", "تجربة"))

        val info = DatabaseSnapshots.snapshot(context, live)
        stages.add(info.file)
        assertEquals(1L, info.rowCounts["invoices"])
        assertEquals(1L, info.rowCounts["invoice_payments"])
        assertEquals(1L, info.rowCounts["wa_log"])
        assertEquals(1L, info.rowCounts["login_guard"])
        assertTrue(info.size >= 4096)
        val staged = RafiqDatabase.build(context, fileName = info.file.name, snapshot = true)
        try {
            assertEquals(17.5, staged.products().getById(product)!!.stock, 0.0)
            assertEquals("777000111", staged.customers().getById(customer)!!.phone)
            assertEquals(2700L, staged.invoices().getById(invoice)!!.totalCents)
            assertEquals(1L, count(staged, "invoice_payments"))
            assertEquals(1L, count(staged, "login_guard"))
            assertEquals(1L, count(staged, "wa_log"))
        } finally {
            staged.close()
        }
        // ما يحدث بعد أخذ اللقطة لا يغيّرها، وتبقى قاعدة البيع حية قابلة للكتابة.
        live.products().insert(ProductEntity(name = "شاي", stock = 2.0))
        assertEquals(2L, count(live, "products"))
        assertEquals(1L, info.rowCounts["invoices"])
        assertEquals(1L, DatabaseSnapshots.verify(context, info.file).rowCounts["products"])
    }

    @Test fun `النسخة والاستعادة تحفظان رابط الوجه بالرصيد الفعلي دون تغيير إصدار القاعدة`() = inWorker {
        val root = live.products().insert(ProductEntity(name = "ماء عادي", barcode = "W-1", stock = 12.0))
        val variant = live.products().insert(ProductEntity(name = "ماء بارد", barcode = "W-1", stock = 0.0))
        live.settings().upsert(SettingEntity(StockSharing.key(variant), root.toString()))
        val stage = DatabaseSnapshots.snapshot(context, live).file
        stages.add(stage)
        assertEquals(2, SQLiteDatabase.openDatabase(stage.path, null, SQLiteDatabase.OPEN_READONLY).use { it.version })
        val staged = RafiqDatabase.build(context, fileName = stage.name, snapshot = true)
        try {
            assertEquals(12.0, StockSharing.availableStock(staged, staged.products().getById(variant)!!)!!, 0.0)
        } finally { staged.close() }
        live.settings().delete(StockSharing.key(variant))
        DatabaseSnapshots.replaceFromVerified(context, live, stage)
        assertEquals(root, StockSharing.linkedRootId(live, variant))
        assertEquals(12.0, StockSharing.availableStock(live, live.products().getById(variant)!!)!!, 0.0)
    }

    @Test fun `قاعدة مشفرة ثم مفكوكة تحتفظ بمخطط البيانات والحركات`() = inWorker {
        val owner = live.users().getAll().single { it.role == "owner" }.id
        live.invoices().insert(InvoiceEntity(number = 11L, userId = owner, totalCents = 1200L))
        val snapshot = DatabaseSnapshots.snapshot(context, live)
        stages.add(snapshot.file)
        val encrypted = ByteArrayOutputStream()
        FileInputStream(snapshot.file).use { input ->
            BackupArchive.encrypt(input, encrypted, "عبارة قوية وفريدة 2026".toCharArray())
        }
        val restored = DatabaseSnapshots.newStagingFile(context)
        stages.add(restored)
        FileOutputStream(restored).use { out ->
            BackupArchive.decrypt(ByteArrayInputStream(encrypted.toByteArray()), out,
                "عبارة قوية وفريدة 2026".toCharArray())
        }
        val verified = DatabaseSnapshots.verify(context, restored)
        assertEquals(snapshot.rowCounts, verified.rowCounts)
        assertEquals(1L, verified.rowCounts["invoices"])
        assertEquals(1L, count(live, "invoices")) // الأصل لم يُستبدل
    }

    @Test fun `خدمة النسخ تفحص الملف المشفر وتحذف القاعدة المؤقتة حتى عند كلمة مرور خاطئة`() = inWorker {
        live.customers().insert(CustomerEntity(name = "زبون غير مُرسَل", openingCents = 12300L))
        val service = BackupService(context, live)
        val encoded = ByteArrayOutputStream()
        val summary = service.export(encoded, "عبارة سرية قوية 2026".toCharArray())
        assertEquals(1L, summary.rows["customers"])
        assertEquals(summary, service.inspect(ByteArrayInputStream(encoded.toByteArray()),
            "عبارة سرية قوية 2026".toCharArray()))
        assertThrows(IOException::class.java) {
            service.inspect(ByteArrayInputStream(encoded.toByteArray()), "عبارة مرور أخرى 2026".toCharArray())
        }
        val leftovers = context.getDatabasePath(liveName).parentFile!!.listFiles().orEmpty()
            .filter { it.name.startsWith("rafiq-snapshot-") && !it.name.startsWith(liveName) }
        assertTrue("ملفات مؤقتة لم تُحذف: $leftovers", leftovers.isEmpty())
        assertEquals(1L, count(live, "customers"))
    }

    @Test fun `الاستعادة التجريبية تستبدل البيانات داخل معاملة واحدة ولا تفقد الجداول الإضافية`() = inWorker {
        val first = live.customers().insert(CustomerEntity(name = "قبل النسخ", openingCents = 4400L))
        live.openHelper.writableDatabase.execSQL(
            "INSERT INTO wa_log(created_at,invoice_id,status,detail) VALUES('2026-10-14',1,'skipped','x')",
        )
        val stage = DatabaseSnapshots.snapshot(context, live).file
        stages.add(stage)
        live.customers().insert(CustomerEntity(name = "أضيف بعد النسخة"))
        assertEquals(2L, count(live, "customers"))
        DatabaseSnapshots.replaceFromVerified(context, live, stage)
        assertEquals(1L, count(live, "customers"))
        assertEquals("قبل النسخ", live.customers().getById(first)!!.name)
        assertEquals(4400L, live.customers().getById(first)!!.openingCents)
        assertEquals(1L, count(live, "wa_log"))
    }

    @Test fun `أي خطأ أثناء النسخ إلى الحية يرد بياناتها الأصلية كاملة`() = inWorker {
        live.customers().insert(CustomerEntity(name = "باقٍ في الهاتف", openingCents = 9800L))
        val stage = DatabaseSnapshots.snapshot(context, live).file
        stages.add(stage)
        SQLiteDatabase.openDatabase(stage.path, null, SQLiteDatabase.OPEN_READWRITE).use { altered ->
            // محاكاة ملف يحمل عموداً زائداً مع بقاء أسماء الجداول سليمة: الإدراج يفشل بعد بدء الحذف.
            altered.execSQL("ALTER TABLE settings ADD COLUMN incompatible TEXT")
        }
        assertThrows(Exception::class.java) { DatabaseSnapshots.replaceFromVerified(context, live, stage) }
        assertEquals(1L, count(live, "customers"))
        assertEquals("باقٍ في الهاتف", live.customers().getAll().first().name)
        assertEquals(9800L, live.customers().getAll().first().openingCents)
        assertEquals(3L, count(live, "users"))
    }

    @Test fun `مخطط جديد غير معروف يرفض تصدير نسخة صامتة ناقصة`() = inWorker {
        live.openHelper.writableDatabase.execSQL("CREATE TABLE feature_not_yet_backed_up (id INTEGER)")
        assertThrows(IOException::class.java) { DatabaseSnapshots.snapshot(context, live) }
        assertEquals(3, live.users().getAll().size)
    }

    @Test fun `التحقق يرفض قاعدة غير صالحة قبل قبول نسخة محفوظة`() = inWorker {
        val stage = DatabaseSnapshots.newStagingFile(context)
        stages.add(stage)
        stage.parentFile!!.mkdirs()
        stage.writeText("not sqlite")
        assertThrows(IOException::class.java) { DatabaseSnapshots.verify(context, stage) }
        assertEquals(3, live.users().getAll().size)
    }
}
