package net.arena.rafiq.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * قاعدة بيانات «رفيق» المحلية — الإصدار 1.
 * تطابق schema.sql المرجعي (14 جدولاً).
 */
@Database(
    entities = [
        UserEntity::class,
        SettingEntity::class,
        ProductEntity::class,
        CustomerEntity::class,
        ShiftEntity::class,
        InvoiceEntity::class,
        InvoiceItemEntity::class,
        PaymentEntity::class,
        CashMovementEntity::class,
        ImportLogEntity::class,
        SupplierEntity::class,
        SupplierTransactionEntity::class,
        SupplierVisitEntity::class,
        LedgerEntryEntity::class,
        OfxOpEntity::class,
        MirrorRowEntity::class,
        SyncMetaEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class RafiqDatabase : RoomDatabase() {

    abstract fun users(): UserDao
    abstract fun settings(): SettingDao
    abstract fun products(): ProductDao
    abstract fun customers(): CustomerDao
    abstract fun shifts(): ShiftDao
    abstract fun invoices(): InvoiceDao
    abstract fun invoiceItems(): InvoiceItemDao
    abstract fun payments(): PaymentDao
    abstract fun cashMovements(): CashMovementDao
    abstract fun importLogs(): ImportLogDao
    abstract fun suppliers(): SupplierDao
    abstract fun supplierTransactions(): SupplierTransactionDao
    abstract fun supplierVisits(): SupplierVisitDao
    abstract fun ledger(): LedgerDao
    abstract fun ofx(): OfxDao
    abstract fun mirror(): MirrorDao
    abstract fun syncMeta(): SyncMetaDao
    abstract fun sales(): SalesQueries
    abstract fun supplierQueries(): SupplierQueries
    abstract fun catalog(): CatalogQueries

    companion object {
        const val DB_NAME = "rafiq.db"

        /**
         * 6أ: ترقية 1→2 تنشئ جداول المزامنة الجديدة فقط (ofx_ops/mirror_rows/sync_meta).
         * لا تمس أي جدول قديم ولا تحذف أي بيانات — شرط المالك صريح.
         */
        val MIG_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `ofx_ops` (`id` TEXT NOT NULL, `kind` TEXT NOT NULL, " +
                    "`payload` TEXT NOT NULL, `status` TEXT NOT NULL, `attempts` INTEGER NOT NULL, " +
                    "`serverRef` TEXT NOT NULL, `note` TEXT NOT NULL, `queuedAt` TEXT NOT NULL, " +
                    "`anchor` TEXT NOT NULL, PRIMARY KEY(`id`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `mirror_rows` (`tbl` TEXT NOT NULL, `id` TEXT NOT NULL, " +
                    "`json` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`tbl`, `id`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `sync_meta` (`k` TEXT NOT NULL, `v` TEXT NOT NULL, PRIMARY KEY(`k`))")
            }
        }

        /** ينشئ القاعدة الحية أو قاعدة مرحلية خاصة لفحص النسخة؛ لا يتغير اسم القاعدة الحية. */
        fun build(context: Context, inMemory: Boolean = false, fileName: String = DB_NAME,
                  snapshot: Boolean = false): RafiqDatabase {
            require(!snapshot || !inMemory)
            require(fileName == DB_NAME || (fileName.startsWith("rafiq-snapshot-") && fileName.endsWith(".db") &&
                fileName.substringAfter("rafiq-snapshot-").substringBeforeLast(".db").matches(Regex("[a-zA-Z0-9-]+"))))
            val builder: RoomDatabase.Builder<RafiqDatabase> = if (inMemory) {
                Room.inMemoryDatabaseBuilder(context.applicationContext, RafiqDatabase::class.java)
                    .allowMainThreadQueries()
            } else {
                Room.databaseBuilder(context.applicationContext, RafiqDatabase::class.java, fileName)
            }
            if (snapshot) builder.setJournalMode(RoomDatabase.JournalMode.TRUNCATE)
            return builder.addMigrations(MIG_1_2).addCallback(CALLBACK).build()
        }

        /** مستخدمو البداية — مطابقة لـ ensure_defaults في النسخة المرجعية. */
        val SEED_USERS: List<Triple<String, String, String>> = listOf(
            Triple("صاحب المتجر", "owner", "1111"),
            Triple("أحمد (عامل)", "worker", "2222"),
            Triple("سالم (عامل)", "worker", "3333"),
        )

        /** الإعدادات الافتراضية — مطابقة لـ DEFAULT_SETTINGS في النسخة المرجعية. */
        val DEFAULT_SETTINGS: Map<String, String> = linkedMapOf(
            "store_name" to "سوبرماركت البركة",
            "store_phone" to "",
            "country_code" to "967",
            "currency" to "ريال",
            "low_stock_default" to "5",
            "expiry_alert_days" to "30",
            "debt_followup_days" to "30",
            "allow_negative_stock" to "1",
            "allow_price_edit" to "0",
            "invoice_footer" to "شكراً لتعاملكم معنا",
            "demo_hint" to "0",
        )

        private val CALLBACK = object : RoomDatabase.Callback() {
            override fun onCreate(db: SupportSQLiteDatabase) {
                super.onCreate(db)
                for ((name, role, pin) in SEED_USERS) {
                    db.execSQL(
                        "INSERT INTO users(name, role, pin, active, created_at) " +
                            "VALUES(?, ?, ?, 1, datetime('now','localtime'))",
                        arrayOf<Any>(name, role, pin),
                    )
                }
                for ((key, value) in DEFAULT_SETTINGS) {
                    db.execSQL("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", arrayOf<Any>(key, value))
                }
            }

            override fun onOpen(db: SupportSQLiteDatabase) {
                super.onOpen(db)
                // المفاتيح الأجنبية مُعطّلة افتراضياً في SQLite، نفعّلها في كل فتح
                db.execSQL("PRAGMA foreign_keys = ON")
                // تفصيل طرق الدفع لكل فاتورة (جدول إضافي بلا ترحيل للنسخة)
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS invoice_payments (" +
                        "id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "invoice_id INTEGER NOT NULL, method TEXT NOT NULL, " +
                        "amount_cents INTEGER NOT NULL, reference TEXT NOT NULL DEFAULT '')",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id)")
                // جدولان إضافيان خارج Room: لا تُسقطهما النسخة الاحتياطية ولا تُنشئهما عند الطلب الأول فقط.
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS login_guard (uid INTEGER PRIMARY KEY NOT NULL, " +
                        "fails INTEGER NOT NULL, locked_until INTEGER NOT NULL)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS wa_log (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "created_at TEXT NOT NULL, invoice_id INTEGER NOT NULL, " +
                        "status TEXT NOT NULL, detail TEXT NOT NULL)",
                )
            }
        }
    }
}
