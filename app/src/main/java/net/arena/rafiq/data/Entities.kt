package net.arena.rafiq.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * مطابقة لـ schema.sql في النسخة المرجعية، جدولاً بجدول.
 * المبالغ كلها بوحدة 1/100 من الريال (Long). الكميات كسرية (Double).
 * قيم الافتراضات (DEFAULT) تُطبَّق في الكود لا في قاعدة البيانات.
 */

/** الطابع الزمني بالتوقيت المحلي، بصيغة schema.sql نفسها. */
fun nowStamp(): String = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())

@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val name: String,
    val role: String = "worker",          // owner | worker
    val pin: String,
    val active: Int = 1,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
)

@Entity(tableName = "settings")
data class SettingEntity(
    @PrimaryKey val key: String,
    val value: String,
)

@Entity(
    tableName = "products",
    indices = [
        Index(value = arrayOf("aisle")),
        Index(value = arrayOf("barcode")),
        Index(value = arrayOf("name")),
    ],
)
data class ProductEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val barcode: String? = null,
    val name: String,
    val unit: String = "حبة",
    val category: String = "",
    val aisle: String = "",               // الممر — اختياري
    val shelf: String = "",               // الرف داخل الممر — اختياري
    @ColumnInfo(name = "cost_cents") val costCents: Long = 0L,
    @ColumnInfo(name = "price_cents") val priceCents: Long = 0L,
    val stock: Double = 0.0,
    @ColumnInfo(name = "low_stock") val lowStock: Double = 5.0,
    val expiry: String? = null,
    val active: Int = 1,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
)

@Entity(tableName = "customers")
data class CustomerEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val name: String,
    val phone: String = "",
    @ColumnInfo(name = "opening_cents") val openingCents: Long = 0L,   // دين مُرحَّل من الكناش
    val note: String = "",
    val active: Int = 1,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
)

@Entity(
    tableName = "shifts",
    foreignKeys = [
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("opened_by")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("closed_by")),
    ],
)
data class ShiftEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "opened_at") val openedAt: String = nowStamp(),
    @ColumnInfo(name = "opened_by") val openedBy: Long? = null,
    @ColumnInfo(name = "opening_cents") val openingCents: Long = 0L,
    @ColumnInfo(name = "closed_at") val closedAt: String? = null,
    @ColumnInfo(name = "closed_by") val closedBy: Long? = null,
    @ColumnInfo(name = "expected_cents") val expectedCents: Long? = null,
    @ColumnInfo(name = "counted_cents") val countedCents: Long? = null,
    @ColumnInfo(name = "difference_cents") val differenceCents: Long? = null,
    @ColumnInfo(name = "difference_reason") val differenceReason: String = "",
    val status: String = "open",          // open | closed
)

@Entity(
    tableName = "invoices",
    foreignKeys = [
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
        ForeignKey(entity = CustomerEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("customer_id")),
        ForeignKey(entity = ShiftEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("shift_id")),
    ],
    indices = [
        Index(value = arrayOf("created_at")),
        Index(value = arrayOf("customer_id")),
    ],
)
data class InvoiceEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val number: Long,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long,
    @ColumnInfo(name = "customer_id") val customerId: Long? = null,
    @ColumnInfo(name = "subtotal_cents") val subtotalCents: Long = 0L,
    @ColumnInfo(name = "discount_cents") val discountCents: Long = 0L,
    @ColumnInfo(name = "total_cents") val totalCents: Long = 0L,
    @ColumnInfo(name = "paid_cents") val paidCents: Long = 0L,
    @ColumnInfo(name = "due_cents") val dueCents: Long = 0L,
    @ColumnInfo(name = "received_cents") val receivedCents: Long? = null,
    @ColumnInfo(name = "change_cents") val changeCents: Long? = null,
    @ColumnInfo(name = "payment_type") val paymentType: String = "cash",   // cash | credit
    val status: String = "open",                                           // open | cancelled
    @ColumnInfo(name = "shift_id") val shiftId: Long? = null,
)

@Entity(
    tableName = "invoice_items",
    foreignKeys = [
        ForeignKey(
            entity = InvoiceEntity::class,
            parentColumns = arrayOf("id"),
            childColumns = arrayOf("invoice_id"),
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(entity = ProductEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("product_id")),
    ],
    indices = [Index(value = arrayOf("invoice_id"))],
)
data class InvoiceItemEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "invoice_id") val invoiceId: Long,
    @ColumnInfo(name = "product_id") val productId: Long? = null,
    val name: String,
    val barcode: String = "",
    val unit: String = "",
    @ColumnInfo(name = "price_cents") val priceCents: Long = 0L,
    val qty: Double = 1.0,
    @ColumnInfo(name = "total_cents") val totalCents: Long = 0L,
)

@Entity(
    tableName = "payments",
    foreignKeys = [
        ForeignKey(entity = CustomerEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("customer_id")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
        ForeignKey(entity = ShiftEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("shift_id")),
    ],
    indices = [Index(value = arrayOf("customer_id"))],
)
data class PaymentEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "customer_id") val customerId: Long,
    @ColumnInfo(name = "amount_cents") val amountCents: Long,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long? = null,
    val note: String = "",
    @ColumnInfo(name = "shift_id") val shiftId: Long? = null,
)

@Entity(
    tableName = "cash_movements",
    foreignKeys = [
        ForeignKey(entity = ShiftEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("shift_id")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
    ],
    indices = [Index(value = arrayOf("shift_id"))],
)
data class CashMovementEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "shift_id") val shiftId: Long? = null,
    val kind: String,                     // open | sale | collection | expense | withdraw | cancel | income | supplier_pay
    @ColumnInfo(name = "amount_cents") val amountCents: Long,   // موجب = دخل، سالب = خروج
    val reason: String = "",
    val note: String = "",
    @ColumnInfo(name = "ref_type") val refType: String = "",
    @ColumnInfo(name = "ref_id") val refId: Long? = null,
    @ColumnInfo(name = "user_id") val userId: Long? = null,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
)

@Entity(tableName = "imports_log")
data class ImportLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val kind: String,
    val filename: String,
    val added: Int = 0,
    val updated: Int = 0,
    val errors: Int = 0,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long? = null,
    val detail: String = "",
)

@Entity(
    tableName = "suppliers",
    indices = [Index(value = arrayOf("kind", "active"))],
)
data class SupplierEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    val name: String,
    val phone: String = "",
    val kind: String = "delegate",        // delegate | fixed
    val periodicity: String = "weekly",   // daily | semi_daily | weekly | monthly | irregular
    val goods: String = "",
    val returnable: Int = 0,              // 1 = يُرتجع الفائض
    val note: String = "",
    @ColumnInfo(name = "last_visit_at") val lastVisitAt: String? = null,
    val active: Int = 1,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
)

@Entity(
    tableName = "supplier_transactions",
    foreignKeys = [
        ForeignKey(entity = SupplierEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("supplier_id")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
        ForeignKey(entity = ShiftEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("shift_id")),
    ],
    indices = [Index(value = arrayOf("supplier_id"))],
)
data class SupplierTransactionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "supplier_id") val supplierId: Long,
    val kind: String,                     // receive | pay | return
    @ColumnInfo(name = "amount_cents") val amountCents: Long,
    val note: String = "",
    @ColumnInfo(name = "invoice_ref") val invoiceRef: String = "",
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long? = null,
    @ColumnInfo(name = "shift_id") val shiftId: Long? = null,
)

@Entity(
    tableName = "supplier_visits",
    foreignKeys = [
        ForeignKey(entity = SupplierEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("supplier_id")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
    ],
    indices = [Index(value = arrayOf("supplier_id"))],
)
data class SupplierVisitEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "supplier_id") val supplierId: Long,
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long? = null,
    val note: String = "",
)

@Entity(
    tableName = "ledger_entries",
    foreignKeys = [
        ForeignKey(entity = CustomerEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("customer_id")),
        ForeignKey(entity = UserEntity::class, parentColumns = arrayOf("id"), childColumns = arrayOf("user_id")),
    ],
    indices = [Index(value = arrayOf("customer_id"))],
)
data class LedgerEntryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0L,
    @ColumnInfo(name = "customer_id") val customerId: Long,
    val kind: String = "debit",           // debit = أعطيت
    @ColumnInfo(name = "amount_cents") val amountCents: Long,
    val note: String = "",
    @ColumnInfo(name = "created_at") val createdAt: String = nowStamp(),
    @ColumnInfo(name = "user_id") val userId: Long? = null,
)
