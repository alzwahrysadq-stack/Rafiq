package net.arena.rafiq.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * يُنشئ قاعدة SQLite مرحلية ببيانات متطابقة في نقطة زمنية واحدة، دون نسخ ملف Room المفتوح
 * (فقد توجد بيانات حديثة في WAL). لا يغيّر أخذ اللقطة سجلات البيع الأصلية، لكنه
 * يهيّئ الجداول المساعدة الناقصة عند الفتح؛ والاستعادة التجريبية داخل معاملة غير مكشوفة للواجهة.
 * تظل قاعدة المرحلية خاصة بالتطبيق حتى تُشفّر وتُصدّر بعبارة مرور.
 */
object DatabaseSnapshots {
    private val TABLES = listOf(
        "users", "settings", "products", "customers", "suppliers", "shifts", "invoices",
        "invoice_items", "payments", "cash_movements", "imports_log", "supplier_transactions",
        "supplier_visits", "ledger_entries", "invoice_payments", "login_guard", "wa_log",
        "ofx_ops", "mirror_rows", "sync_meta",
    )
    private val EXPECTED_TABLES = TABLES.toSet()
    private const val VERSION = 2
    private const val MAX_FILE_BYTES = 512L * 1024 * 1024

    data class Info(val file: File, val rowCounts: Map<String, Long>, val size: Long)

    /** مسار جديد وفريد داخل مجلد قواعد التطبيق، لا يقبل اسماً قادماً من ملف المستخدم. */
    fun newStagingFile(context: Context): File {
        val stage = context.getDatabasePath("rafiq-snapshot-${UUID.randomUUID()}.db")
        if (stage.parentFile?.isDirectory != true && stage.parentFile?.mkdirs() != true) {
            throw IOException("تعذّر تجهيز مساحة النسخة المرحلية")
        }
        return stage
    }

    fun snapshot(context: Context, live: RafiqDatabase): Info {
        // فتح Room قبل القراءة يضمن تطبيق مخطط القاعدة والإضافات خارج Room على الجهاز القديم.
        val path = live.openHelper.writableDatabase.path
            ?: throw IOException("تعذّر تحديد ملف قاعدة الهاتف")
        if (path.isBlank() || path == ":memory:") throw IOException("النسخ يتطلب قاعدة هاتف محفوظة في ملف")
        val stage = newStagingFile(context)
        try {
            val staged = RafiqDatabase.build(context, fileName = stage.name, snapshot = true)
            try {
                staged.openHelper.writableDatabase.query("SELECT COUNT(*) FROM users").use { it.moveToFirst() }
            } finally {
                staged.close()
            }
            // اتصال SQLite مستقل: معاملة قراءة/كتابة واحدة تُثبّت لقطة الجداول، حتى لو كانت الحية بوضع WAL.
            SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE).use { src ->
                src.setForeignKeyConstraintsEnabled(true)
                src.beginTransactionNonExclusive()
                try {
                    requireCompleteSchema(src, "main")
                    src.execSQL("ATTACH DATABASE ? AS snap", arrayOf(stage.absolutePath))
                    requireCompleteSchema(src, "snap")
                    // القاعدة المرحلية زُرعت بمستخدمين وإعدادات ابتدائية؛ تزال قبل نسخ الأصل.
                    src.execSQL("DELETE FROM snap.settings")
                    src.execSQL("DELETE FROM snap.users")
                    for (table in TABLES) {
                        src.execSQL("INSERT INTO snap.\"$table\" SELECT * FROM main.\"$table\"")
                        val original = count(src, "main", table)
                        if (count(src, "snap", table) != original) throw IOException("فشل اكتمال جدول $table في النسخة")
                    }
                    // لا نعيد استعمال أرقام صُرفت ثم حُذفت: احتفظ بعدادات AUTOINCREMENT.
                    src.execSQL("DELETE FROM snap.sqlite_sequence")
                    src.execSQL("INSERT INTO snap.sqlite_sequence(name, seq) SELECT name, seq FROM main.sqlite_sequence")
                    src.setTransactionSuccessful()
                } finally {
                    // إغلاق الاتصال بعد المعاملة يفصل القاعدة المرحلية ويُفرغ أي دفتر كتابات تابع لها.
                    src.endTransaction()
                }
            }
            return verify(context, stage)
        } catch (e: Exception) {
            discard(context, stage)
            throw e
        }
    }

    /**
     * استعادة ذرية من ملف مرحلي جرى فحصه مسبقاً. كل الحذف والإدراج يقع في معاملة واحدة
     * على القاعدة الحية؛ أي خطأ يردها إلى حالتها السابقة. لا تُستدعى من واجهة المستخدم
     * إلا بعد نسخة نجاة للحالة الحالية وتأكيد المالك، ومع إيقاف طلبات البيع حتى الاكتمال.
     */
    internal fun replaceFromVerified(context: Context, live: RafiqDatabase, stage: File): Info {
        val accepted = verify(context, stage)
        val path = live.openHelper.writableDatabase.path
            ?: throw IOException("تعذّر تحديد ملف قاعدة الهاتف")
        SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE).use { target ->
            target.setForeignKeyConstraintsEnabled(true)
            target.beginTransactionNonExclusive()
            try {
                requireCompleteSchema(target, "main")
                target.execSQL("ATTACH DATABASE ? AS replacement", arrayOf(stage.absolutePath))
                requireCompleteSchema(target, "replacement")
                // الأطفال أولاً عند الحذف، والآباء أولاً عند الإدراج؛ لا نوقف حماية المفاتيح الأجنبية.
                for (table in TABLES.asReversed()) target.execSQL("DELETE FROM main.\"$table\"")
                for (table in TABLES) {
                    target.execSQL("INSERT INTO main.\"$table\" SELECT * FROM replacement.\"$table\"")
                    if (count(target, "main", table) != accepted.rowCounts.getValue(table)) {
                        throw IOException("استعادة غير مكتملة في جدول $table")
                    }
                }
                target.execSQL("DELETE FROM main.sqlite_sequence")
                target.execSQL("INSERT INTO main.sqlite_sequence(name, seq) " +
                    "SELECT name, seq FROM replacement.sqlite_sequence")
                target.rawQuery("PRAGMA main.foreign_key_check", null).use { c ->
                    if (c.moveToFirst()) throw IOException("تعذّر استعادة روابط البيانات")
                }
                target.setTransactionSuccessful()
            } finally {
                // إذا وقع فشل، يحافظ SQLite على القاعدة السابقة كاملةً بما فيها عدادات IDs.
                target.endTransaction()
            }
        }
        return accepted
    }

    /** فحص كامل قبل اعتبار الملف صالحاً، ومن دون أي كتابة إلى قاعدة البيع. */
    fun verify(context: Context, stage: File): Info {
        requirePrivateStage(context, stage)
        if (!stage.isFile || stage.length() < 4096 || stage.length() > MAX_FILE_BYTES) {
            throw IOException("حجم قاعدة النسخة غير صالح")
        }
        if (File(stage.path + "-wal").length() > 0L) {
            throw IOException("سجل قاعدة النسخة لم يُفرغ بعد؛ لا يمكن تصدير ملف ناقص")
        }
        val counts = SQLiteDatabase.openDatabase(stage.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { check ->
            if (check.version != VERSION) throw IOException("إصدار قاعدة النسخة غير مدعوم")
            requireCompleteSchema(check, "main")
            check.rawQuery("PRAGMA quick_check", null).use { c ->
                if (!c.moveToFirst() || c.getString(0) != "ok") throw IOException("قاعدة النسخة تالفة")
            }
            check.rawQuery("PRAGMA foreign_key_check", null).use { c ->
                if (c.moveToFirst()) throw IOException("روابط سجلات النسخة غير متطابقة")
            }
            TABLES.associateWith { count(check, "main", it) }
        }
        if (counts.getValue("users") == 0L || counts.getValue("settings") == 0L) {
            throw IOException("بيانات النسخة الأساسية ناقصة")
        }
        // نغلق اتصال الفحص قبل فتح Room: وضع TRUNCATE يمنع قارئاً طويلاً وفتح قاعدة أخرى معاً.
        val room = RafiqDatabase.build(context, fileName = stage.name, snapshot = true)
        try {
            room.openHelper.readableDatabase.query("SELECT COUNT(*) FROM users").use { it.moveToFirst() }
            for (entry in room.settings().getAll().filter { it.key.startsWith(StockSharing.KEY_PREFIX) }) {
                val childId = entry.key.removePrefix(StockSharing.KEY_PREFIX).toLongOrNull()
                    ?: throw IOException("رابط مخزون غير صالح في النسخة")
                val child = room.products().getById(childId)
                    ?: throw IOException("وجه بيع مفقود في رابط المخزون")
                if (StockSharing.stockProduct(room, child)?.id.toString() != entry.value) {
                    throw IOException("الباركود أو أصل الرصيد لا يطابق وجه البيع في النسخة")
                }
            }
        } finally {
            room.close()
        }
        return Info(stage, counts, stage.length())
    }

    /** يُحذف الملف المرحلي وملفات SQLite الجانبية فقط بعد التحقق من مساره الخاص. */
    fun discard(context: Context, stage: File) {
        requirePrivateStage(context, stage)
        for (suffix in listOf("", "-wal", "-shm", "-journal")) File(stage.path + suffix).delete()
    }

    private fun requirePrivateStage(context: Context, stage: File) {
        val dbDir = context.getDatabasePath(RafiqDatabase.DB_NAME).parentFile.canonicalFile
        require(stage.parentFile?.canonicalFile == dbDir &&
            stage.name.matches(Regex("rafiq-snapshot-[a-fA-F0-9-]{36}\\.db"))) {
            "الملف المرحلي ليس داخل مجلد التطبيق"
        }
    }

    private fun requireCompleteSchema(db: SQLiteDatabase, schema: String) {
        val names = HashSet<String>()
        db.rawQuery(
            "SELECT name FROM $schema.sqlite_master WHERE type = 'table' " +
                "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'room_%' AND name NOT LIKE 'android_%'",
            null,
        ).use { c -> while (c.moveToNext()) names.add(c.getString(0)) }
        if (names != EXPECTED_TABLES) throw IOException("مخطط قاعدة البيانات لا يطابق نسخة رفيق الحالية")
    }

    private fun count(db: SQLiteDatabase, schema: String, table: String): Long =
        db.rawQuery("SELECT COUNT(*) FROM $schema.\"$table\"", null).use { c ->
            if (!c.moveToFirst()) throw IOException("جدول ناقص: $table")
            c.getLong(0)
        }
}
