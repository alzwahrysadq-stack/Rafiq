package net.arena.rafiq.data

import androidx.room.Dao
import androidx.room.Query

/**
 * استعلامات البيع والزبائن التي تحتاجها طبقة المستودع (SalesRepository).
 * منفصلة عن الـ DAO الأساسية حتى تبقى كل ملف صغيراً وواضحاً.
 */
@Dao
interface SalesQueries {

    @Query("SELECT * FROM products WHERE id = :id AND active = 1")
    fun activeProduct(id: Long): ProductEntity?

    @Query("UPDATE products SET stock = stock - :qty WHERE id = :id")
    fun decrementStock(id: Long, qty: Double): Int

    @Query("UPDATE products SET stock = stock + :qty WHERE id = :id")
    fun incrementStock(id: Long, qty: Double): Int

    @Query("SELECT * FROM customers WHERE id = :id AND active = 1")
    fun activeCustomer(id: Long): CustomerEntity?

    @Query("UPDATE invoices SET status = 'cancelled' WHERE id = :id")
    fun markCancelled(id: Long): Int

    @Query("SELECT * FROM invoices WHERE customer_id = :customerId AND status = 'open' AND due_cents > 0 " +
        "ORDER BY created_at, id")
    fun debtInvoices(customerId: Long): List<InvoiceEntity>

    @Query("SELECT COALESCE(SUM(due_cents), 0) FROM invoices WHERE customer_id = :customerId AND status = 'open'")
    fun openDueSum(customerId: Long): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE customer_id = :customerId")
    fun ledgerSum(customerId: Long): Long

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE customer_id = :customerId")
    fun paymentsSum(customerId: Long): Long
}
