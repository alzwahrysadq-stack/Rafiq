package net.arena.rafiq.data

import androidx.room.Dao
import androidx.room.Query

/** استعلامات الموردين والمندوبين التي تحتاجها طبقة SupplierRepository. */
@Dao
interface SupplierQueries {

    @Query("SELECT * FROM suppliers WHERE id = :id")
    fun byId(id: Long): SupplierEntity?

    @Query("SELECT * FROM suppliers")
    fun allList(): List<SupplierEntity>

    @Query("SELECT * FROM suppliers WHERE active = 1 ORDER BY name")
    fun activeList(): List<SupplierEntity>

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM supplier_transactions WHERE supplier_id = :supplierId AND kind = :kind")
    fun sumKind(supplierId: Long, kind: String): Long

    @Query("UPDATE suppliers SET last_visit_at = datetime('now','localtime') WHERE id = :id")
    fun touch(id: Long): Int

    @Query("UPDATE suppliers SET active = :active WHERE id = :id")
    fun setActive(id: Long, active: Int): Int

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM supplier_transactions WHERE kind = :kind")
    fun sumAllKind(kind: String): Long

    @Query("SELECT * FROM supplier_transactions WHERE supplier_id = :supplierId ORDER BY created_at, id")
    fun transactionsOf(supplierId: Long): List<SupplierTransactionEntity>

    @Query("SELECT * FROM supplier_visits WHERE supplier_id = :supplierId ORDER BY id DESC LIMIT 30")
    fun visitsOf(supplierId: Long): List<SupplierVisitEntity>

    @Query(
        "UPDATE suppliers SET name = :name, phone = :phone, kind = :kind, periodicity = :periodicity, " +
            "goods = :goods, returnable = :returnable, note = :note WHERE id = :id"
    )
    fun updateDetails(
        id: Long, name: String, phone: String, kind: String, periodicity: String,
        goods: String, returnable: Int, note: String,
    ): Int
}
