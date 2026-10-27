package net.arena.rafiq.data

import net.arena.rafiq.domain.ImportRules
import net.arena.rafiq.domain.ImportRules.Status

/**
 * حفظ الاستيراد بعد المعاينة، مطابق لـ imports_commit في النسخة الأصلية:
 * الأصناف: يُحدَّث الصنف إن وُجد بالباركود أو بالاسم (النشط)، وإلا يُضاف.
 * ترحيل الديون القديم بالاسم أُلغي (#50) حتى لا تضاعَف الأرصدة؛ المسودة الجديدة
 * ستتطلب معرّف زبون محدداً وبصمة PDF ومطابقة مجموع ونسخة نجاة قبل أي كتابة.
 */
class ImportRepository(private val db: RafiqDatabase) {

    data class Counts(val added: Int, val updated: Int, val errors: Int)

    private inline fun <T> tx(block: () -> T): T {
        db.beginTransaction()
        try {
            val result = block()
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    fun commitProducts(records: List<ImportRules.ProductRecord>, filename: String, userId: Long): Counts = tx {
        val catalog = db.catalog()
        var added = 0
        var updated = 0
        var errors = 0
        for (rec in records) {
            if (rec.status == Status.ERROR || rec.name.isEmpty()) {
                errors++
                continue
            }
            val sameBarcode = if (rec.barcode.isNotEmpty()) catalog.anyProductsByBarcode(rec.barcode) else emptyList()
            // عند وجود عدة وجوه بالباركود نفسه، لا تسمح لصف CSV بتغيير وجه اعتباطي.
            val byBarcode = if (sameBarcode.size > 1) sameBarcode.singleOrNull { it.name == rec.name }
                else sameBarcode.firstOrNull()
            if (sameBarcode.size > 1 && byBarcode == null) {
                errors++
                continue
            }
            val existing = byBarcode ?: catalog.activeProductByName(rec.name)
            if (existing != null && (StockSharing.linkedRootId(db, existing.id) != null ||
                    (StockSharing.linkedChildren(db, existing.id) && rec.barcode.isNotEmpty() &&
                        rec.barcode != existing.barcode))) {
                // لا يستبدل الاستيراد رصيد وجه مشترك أو باركود أصله دون قصد.
                errors++
                continue
            }
            if (existing != null) {
                db.products().updateFields(
                    existing.id,
                    rec.barcode.ifEmpty { existing.barcode },
                    rec.name, rec.unit, rec.category,
                    rec.costCents, rec.priceCents, if (rec.stockProvided) rec.stock else existing.stock,
                    existing.lowStock,
                    rec.expiry ?: existing.expiry,
                    rec.aisle.ifEmpty { existing.aisle },
                    rec.shelf.ifEmpty { existing.shelf },
                )
                updated++
            } else {
                db.products().insert(
                    ProductEntity(
                        barcode = rec.barcode.ifEmpty { null },
                        name = rec.name,
                        unit = rec.unit,
                        category = rec.category,
                        costCents = rec.costCents,
                        priceCents = rec.priceCents,
                        stock = rec.stock,
                        expiry = rec.expiry,
                        aisle = rec.aisle,
                        shelf = rec.shelf,
                    )
                )
                added++
            }
        }
        db.importLogs().insert(
            ImportLogEntity(kind = "products", filename = filename, added = added, updated = updated,
                errors = errors, userId = userId)
        )
        Counts(added, updated, errors)
    }

}
