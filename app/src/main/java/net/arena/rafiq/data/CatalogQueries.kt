package net.arena.rafiq.data

import androidx.room.Dao
import androidx.room.Query

/** استعلامات البحث والتقارير اليومية، مطابقة لشاشات الأصناف و«أين هذا الصنف» واللوحة. */
@Dao
interface CatalogQueries {

    @Query(
        "SELECT * FROM products WHERE active = 1 AND (name LIKE '%' || :q || '%' OR barcode LIKE '%' || :q || '%') " +
            "ORDER BY name LIMIT :limit"
    )
    fun searchProducts(q: String, limit: Int): List<ProductEntity>

    @Query(
        "SELECT * FROM products WHERE active = 1 AND (aisle = :code OR shelf = :code) " +
            "ORDER BY CAST(aisle AS INTEGER), name LIMIT 200"
    )
    fun productsAtLocation(code: String): List<ProductEntity>

    /** الأكثر بيعاً في يوم: اسم الصنف وكميته وقيمته (من الفواتير المفتوحة). */
    @Query(
        "SELECT it.name AS name, SUM(it.qty) AS q, SUM(it.total_cents) AS t FROM invoice_items it " +
            "JOIN invoices i ON i.id = it.invoice_id WHERE i.status = 'open' AND date(i.created_at) = :day " +
            "GROUP BY it.name ORDER BY q DESC LIMIT 10"
    )
    fun topItems(day: String): List<TopItem>

    @Query("SELECT MAX(created_at) FROM invoices WHERE customer_id = :customerId AND status = 'open'")
    fun lastOpenInvoiceAt(customerId: Long): String?

    @Query("SELECT id FROM customers")
    fun allCustomerIds(): List<Long>

    @Query("SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.stock <= p.low_stock " +
        "AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = 'shared_stock_product_' || p.id)")
    fun lowStockCount(): Int

    @Query("SELECT COUNT(*) FROM invoice_items WHERE product_id = :productId")
    fun invoiceItemCount(productId: Long): Int

    /** تنبيه داخل التطبيق فقط: تاريخ ISO واحد للصنف ذي الرصيد الفعلي، وليس دفعات متعددة. */
    @Query("SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.stock > 0 AND " +
        "p.expiry IS NOT NULL AND length(p.expiry) = 10 AND p.expiry <= :through AND " +
        "NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = 'shared_stock_product_' || p.id)")
    fun expiringCount(through: String): Int

    @Query("SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.stock > 0 AND " +
        "p.expiry IS NOT NULL AND length(p.expiry) = 10 AND p.expiry < :today AND " +
        "NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = 'shared_stock_product_' || p.id)")
    fun expiredCount(today: String): Int

    @Query("SELECT * FROM products p WHERE p.active = 1 AND p.stock > 0 AND " +
        "p.expiry IS NOT NULL AND length(p.expiry) = 10 AND p.expiry <= :through AND " +
        "NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = 'shared_stock_product_' || p.id) " +
        "ORDER BY p.expiry, p.name LIMIT :limit")
    fun expiringProducts(through: String, limit: Int): List<ProductEntity>

    @Query("SELECT COUNT(*) FROM products WHERE active = 1")
    fun activeProductCount(): Int

    @Query("SELECT * FROM invoices WHERE date(created_at) = :day")
    fun invoicesOn(day: String): List<InvoiceEntity>

    /** صافي نقد المبيعات في يوم الحركة، بما فيه ردّ النقد لإلغاء فاتورة. لا تدخل الحوالات والمحافظ هنا. */
    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements " +
        "WHERE kind IN ('sale', 'cancel') AND date(created_at) = :day")
    fun netCashFromSalesOn(day: String): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE date(created_at) = :day")
    fun collectionsOn(day: String): Long

    @Query("SELECT COALESCE(SUM(-amount_cents), 0) FROM cash_movements WHERE kind = 'expense' AND date(created_at) = :day")
    fun expensesOn(day: String): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements WHERE kind = 'income' AND date(created_at) = :day")
    fun incomeOn(day: String): Long

    @Query("SELECT COALESCE(SUM(-amount_cents), 0) FROM cash_movements WHERE kind = 'withdraw' AND date(created_at) = :day")
    fun withdrawsOn(day: String): Long

    @Query("SELECT COALESCE(SUM(-amount_cents), 0) FROM cash_movements WHERE kind = 'supplier_pay' AND date(created_at) = :day")
    fun supplierPaidOn(day: String): Long

    /** قائمة موجزة لشاشة تفاصيل الزبون؛ لا تُستعمل أبداً لحساب كشف الحساب. */
    @Query("SELECT * FROM invoices WHERE customer_id = :customerId ORDER BY id DESC LIMIT 200")
    fun invoicesOfCustomer(customerId: Long): List<InvoiceEntity>

    /** فحص واحد للزبائن ذوي أرصدة أو عمليات سابقة بدلاً من قراءة كل حركاتهم عند حفظ كل قرار. */
    @Query("SELECT id FROM customers WHERE opening_cents != 0 OR id IN (" +
        "SELECT customer_id FROM invoices WHERE customer_id IS NOT NULL " +
        "UNION SELECT customer_id FROM payments " +
        "UNION SELECT customer_id FROM ledger_entries)")
    fun customerIdsWithHistory(): List<Long>

    /** كشف مالي كامل، دون حدّ يترك الرصيد الظاهر مخالفاً للإجمالي. */
    @Query("SELECT * FROM invoices WHERE customer_id = :customerId ORDER BY id")
    fun invoicesForStatement(customerId: Long): List<InvoiceEntity>

    @Query("SELECT COALESCE(SUM(opening_cents), 0) FROM customers")
    fun openingTotal(): Long

    @Query("SELECT COALESCE(SUM(due_cents), 0) FROM invoices WHERE status = 'open'")
    fun openDueTotal(): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries")
    fun ledgerTotal(): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM payments")
    fun paymentsTotal(): Long

    @Query(
        "SELECT COALESCE(MAX(created_at), '') FROM (" +
            "SELECT created_at FROM invoices WHERE customer_id = :customerId AND status = 'open' " +
            "UNION ALL SELECT created_at FROM payments WHERE customer_id = :customerId " +
            "UNION ALL SELECT created_at FROM ledger_entries WHERE customer_id = :customerId)"
    )
    fun lastActivity(customerId: Long): String

    /** للاستيراد: صنف بالباركود (أي حالة)، وصنف نشط بالاسم. */
    @Query("SELECT * FROM products WHERE barcode = :code LIMIT 1")
    fun anyProductByBarcode(code: String): ProductEntity?

    @Query("SELECT * FROM products WHERE barcode = :code ORDER BY id")
    fun anyProductsByBarcode(code: String): List<ProductEntity>

    @Query("SELECT * FROM products WHERE name = :name AND active = 1 LIMIT 1")
    fun activeProductByName(name: String): ProductEntity?

    /** للاستيراد: زبون بالاسم (أي حالة). */
    @Query("SELECT * FROM customers WHERE name = :name LIMIT 1")
    fun customerByName(name: String): CustomerEntity?

    /** ورديات يوم معيّن (YYYY-MM-DD) حسب وقت الفتح. */
    @Query("SELECT * FROM shifts WHERE substr(opened_at, 1, 10) = :day ORDER BY id")
    fun shiftsOn(day: String): List<ShiftEntity>

    /** حركات يوم معيّن حسب وقت التسجيل، لحساب دخل اليوم وخروجه. */
    @Query("SELECT * FROM cash_movements WHERE substr(created_at, 1, 10) = :day ORDER BY id")
    fun movementsOn(day: String): List<CashMovementEntity>
}

/** صف «الأكثر بيعاً» في التقارير. */
data class TopItem(val name: String, val q: Double, val t: Long)
