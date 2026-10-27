package net.arena.rafiq.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/*
 * مرحلة 2: الوصول الأساسي فقط (إضافة وقراءة).
 * استعلامات الرصيد والكشوف والتقارير تُكتب في المرحلة 3 مع منطق الأعمال.
 */

@Dao
interface UserDao {
    @Insert
    fun insert(e: UserEntity): Long

    @Query("SELECT * FROM users ORDER BY role DESC, id")
    fun getAll(): List<UserEntity>

    @Query("SELECT * FROM users WHERE id = :id")
    fun getById(id: Long): UserEntity?

    @Query("UPDATE users SET pin = :pin WHERE id = :id")
    fun setPin(id: Long, pin: String): Int

    @Query("UPDATE users SET name = :name WHERE id = :id")
    fun setName(id: Long, name: String): Int

    @Query("UPDATE users SET active = :active WHERE id = :id AND role = 'worker'")
    fun setWorkerActive(id: Long, active: Int): Int
}

@Dao
interface SettingDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(e: SettingEntity): Long

    @Query("SELECT * FROM settings WHERE key = :k")
    fun get(k: String): SettingEntity?

    @Query("SELECT * FROM settings")
    fun getAll(): List<SettingEntity>

    @Query("DELETE FROM settings WHERE `key` = :k")
    fun delete(k: String): Int
}

@Dao
interface ProductDao {
    @Insert
    fun insert(e: ProductEntity): Long

    @Query("SELECT * FROM products WHERE id = :id")
    fun getById(id: Long): ProductEntity?

    @Query("SELECT * FROM products WHERE barcode = :code AND active = 1 LIMIT 1")
    fun findByBarcode(code: String): ProductEntity?

    @Query("SELECT * FROM products WHERE barcode = :code AND active = 1 ORDER BY name, id")
    fun allByBarcode(code: String): List<ProductEntity>

    @Query("SELECT * FROM products WHERE barcode = :code AND id != :selfId ORDER BY id")
    fun othersByBarcode(code: String, selfId: Long): List<ProductEntity>

    @Query("SELECT * FROM products WHERE active = 1 AND (name LIKE '%' || :q || '%' OR barcode = :q) ORDER BY name LIMIT 50")
    fun search(q: String): List<ProductEntity>

    /** رقم صنف آخر يحمل هذا الباركود (أي صنف، نشطاً كان أو لا)، كما في النسخة الأصلية. */
    @Query("SELECT id FROM products WHERE barcode = :code AND id != :selfId LIMIT 1")
    fun barcodeOwner(code: String, selfId: Long): Long?

    @Query(
        "UPDATE products SET barcode = :barcode, name = :name, unit = :unit, category = :category, " +
            "cost_cents = :cost, price_cents = :price, stock = :stock, low_stock = :low, expiry = :expiry, " +
            "aisle = :aisle, shelf = :shelf WHERE id = :id"
    )
    fun updateFields(
        id: Long, barcode: String?, name: String, unit: String, category: String,
        cost: Long, price: Long, stock: Double, low: Double, expiry: String?,
        aisle: String, shelf: String,
    ): Int

    @Query("UPDATE products SET barcode = :barcode WHERE id = :id")
    fun setBarcode(id: Long, barcode: String): Int
}

@Dao
interface CustomerDao {
    @Insert
    fun insert(e: CustomerEntity): Long

    @Query("SELECT * FROM customers WHERE id = :id")
    fun getById(id: Long): CustomerEntity?

    @Query("SELECT * FROM customers WHERE active = 1 ORDER BY name")
    fun getAll(): List<CustomerEntity>

    /** افحص أسماء غير النشطين أيضاً قبل اقتراح إنشاء زبون جديد. */
    @Query("SELECT * FROM customers ORDER BY id")
    fun getAllIncludingInactive(): List<CustomerEntity>
}

@Dao
interface ShiftDao {
    @Insert
    fun insert(e: ShiftEntity): Long

    @Query("SELECT * FROM shifts WHERE id = :id")
    fun getById(id: Long): ShiftEntity?

    @Query("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    fun getOpen(): ShiftEntity?

    @Query("SELECT * FROM shifts WHERE status = 'closed' ORDER BY id DESC LIMIT 1")
    fun lastClosed(): ShiftEntity?

    @Query(
        "UPDATE shifts SET closed_at = datetime('now','localtime'), closed_by = :closedBy, status = 'closed', " +
            "expected_cents = :expected, counted_cents = :counted, difference_cents = :difference, " +
            "difference_reason = :reason WHERE id = :id AND status = 'open'"
    )
    fun close(id: Long, closedBy: Long, expected: Long, counted: Long, difference: Long, reason: String): Int
}

@Dao
interface InvoiceDao {
    @Insert
    fun insert(e: InvoiceEntity): Long

    @Query("SELECT * FROM invoices WHERE id = :id")
    fun getById(id: Long): InvoiceEntity?

    @Query("SELECT COALESCE(MAX(number), 0) + 1 FROM invoices")
    fun nextNumber(): Long

    @Query("SELECT * FROM invoices WHERE number = :n LIMIT 1")
    fun byNumber(n: Long): InvoiceEntity?
}

@Dao
interface InvoiceItemDao {
    @Insert
    fun insert(e: InvoiceItemEntity): Long

    @Query("SELECT * FROM invoice_items WHERE invoice_id = :invoiceId ORDER BY id")
    fun getByInvoice(invoiceId: Long): List<InvoiceItemEntity>
}

@Dao
interface PaymentDao {
    @Insert
    fun insert(e: PaymentEntity): Long

    @Query("SELECT * FROM payments WHERE customer_id = :customerId ORDER BY id")
    fun getByCustomer(customerId: Long): List<PaymentEntity>
}

@Dao
interface CashMovementDao {
    @Insert
    fun insert(e: CashMovementEntity): Long

    @Query("SELECT * FROM cash_movements ORDER BY id")
    fun getAll(): List<CashMovementEntity>

    @Query("SELECT * FROM cash_movements WHERE shift_id = :shiftId ORDER BY id")
    fun getByShift(shiftId: Long): List<CashMovementEntity>

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements WHERE shift_id = :shiftId")
    fun sumForShift(shiftId: Long): Long

    /** النقد الذي دخل فعلاً من هذه الفاتورة؛ لا يُستدل عليه من paid_cents الذي يشمل غير النقد. */
    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements " +
        "WHERE kind = 'sale' AND ref_type = 'invoice' AND ref_id = :invoiceId")
    fun saleCashForInvoice(invoiceId: Long): Long
}

@Dao
interface LedgerDao {
    @Insert
    fun insert(e: LedgerEntryEntity): Long

    @Query("SELECT * FROM ledger_entries WHERE customer_id = :customerId ORDER BY id")
    fun getByCustomer(customerId: Long): List<LedgerEntryEntity>
}

@Dao
interface ImportLogDao {
    @Insert
    fun insert(e: ImportLogEntity): Long

    @Query("SELECT * FROM imports_log ORDER BY id DESC")
    fun getAll(): List<ImportLogEntity>
}

@Dao
interface SupplierDao {
    @Insert
    fun insert(e: SupplierEntity): Long

    @Query("SELECT * FROM suppliers WHERE id = :id")
    fun getById(id: Long): SupplierEntity?

    @Query("SELECT * FROM suppliers WHERE active = 1 ORDER BY name")
    fun getAll(): List<SupplierEntity>
}

@Dao
interface SupplierTransactionDao {
    @Insert
    fun insert(e: SupplierTransactionEntity): Long

    @Query("SELECT * FROM supplier_transactions WHERE supplier_id = :supplierId ORDER BY id")
    fun getBySupplier(supplierId: Long): List<SupplierTransactionEntity>
}

@Dao
interface SupplierVisitDao {
    @Insert
    fun insert(e: SupplierVisitEntity): Long

    @Query("SELECT * FROM supplier_visits WHERE supplier_id = :supplierId ORDER BY id")
    fun getBySupplier(supplierId: Long): List<SupplierVisitEntity>
}
