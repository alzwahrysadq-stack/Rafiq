package net.arena.rafiq.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * 6أ — طبقة المزامنة دون اتصال.
 * ofx_ops: طابور خارج للعمليات المالية (بيع/زبون/تحصيل/دين/صنف) حتى إقرار الخادم.
 * الحالات: queued | confirmed | conflict | cancelled_by_owner — لا حالة «حذف» إطلاقًا.
 * mirror_rows: مرآة داخل لبيانات المتجر (أصناف/زبائن/فواتير/ديون/ورديات) للعرض دون اتصال.
 * sync_meta: مراس المزامنة (مثل pull_wm) — الوقت المرجعي من الخادم لا من ساعة الهاتف.
 */
@Entity(tableName = "ofx_ops")
data class OfxOpEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val payload: String,
    val status: String = "queued",
    val attempts: Int = 0,
    val serverRef: String = "",
    val note: String = "",
    val queuedAt: String = "",
    val anchor: String = "",
)

@Dao
interface OfxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun add(op: OfxOpEntity)

    /** عمليات تحتاج مراجعة (تعارض/بانتظار المالك/ملغاة محليًا) — بلا حد العرض: قابلة للاسترجاع دائمًا. */
    @Query("SELECT * FROM ofx_ops WHERE status IN ('conflict','sent_awaiting_owner','cancelled_by_owner') ORDER BY queuedAt DESC, rowid DESC")
    fun review(): List<OfxOpEntity>

    /** كل العمليات المعلّقة بلا حد — مرتبة زمنيًا مع كسر التعادل برقم الصف: المبيعات قبل إغلاق ورديتها. */
    @Query("SELECT * FROM ofx_ops WHERE status='queued' ORDER BY queuedAt ASC, rowid ASC")
    fun queued(): List<OfxOpEntity>

    @Query("SELECT * FROM ofx_ops ORDER BY queuedAt DESC LIMIT 100")
    fun recent(): List<OfxOpEntity>

    /** تأكيد حفظ حالة فاتورة بعينها، حتى لو تجاوزت حد قائمة العرض. */
    @Query("SELECT * FROM ofx_ops WHERE id=:id LIMIT 1")
    fun getById(id: String): OfxOpEntity?

    @Query("UPDATE ofx_ops SET status=:status, serverRef=:ref, note=:note, attempts=attempts+1 WHERE id=:id")
    fun settle(id: String, status: String, ref: String, note: String)

    @Query("SELECT COUNT(*) FROM ofx_ops WHERE status='queued'")
    fun queuedCount(): Int
}

@Entity(tableName = "mirror_rows", primaryKeys = ["tbl", "id"])
data class MirrorRowEntity(
    val tbl: String,
    val id: String,
    val json: String,
    val updatedAt: String = "",
)

@Dao
interface MirrorDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(rows: List<MirrorRowEntity>)

    @Query("SELECT * FROM mirror_rows WHERE tbl=:tbl ORDER BY updatedAt ASC")
    fun all(tbl: String): List<MirrorRowEntity>
}

@Entity(tableName = "sync_meta")
data class SyncMetaEntity(
    @PrimaryKey val k: String,
    val v: String,
)

@Dao
interface SyncMetaDao {
    @Query("SELECT v FROM sync_meta WHERE k=:k")
    fun get(k: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun set(row: SyncMetaEntity)
}
