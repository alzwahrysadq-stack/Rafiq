package net.arena.rafiq.data

/**
 * ربط اختياري بين وجه البيع وصنف المخزون الحقيقي. لا نعدّل مخطط Room هنا:
 * مفتاح settings يُحفظ في النسخ الاحتياطية القائمة، وتظل قواعد الإصدار 1 قابلة للفتح.
 * لا يجوز تغيير الربط بعد أول فاتورة لهذا الوجه؛ وإلا قد تُرجع الفاتورة الملغاة
 * الكمية إلى صنف غير الذي خُصمت منه عند البيع.
 */
object StockSharing {
    const val KEY_PREFIX = "shared_stock_product_"

    fun key(productId: Long): String = "$KEY_PREFIX$productId"

    fun linkedRootId(db: RafiqDatabase, productId: Long): Long? =
        db.settings().get(key(productId))?.value?.toLongOrNull()

    fun stockProduct(db: RafiqDatabase, product: ProductEntity): ProductEntity? {
        val saved = db.settings().get(key(product.id))?.value ?: return product
        val rootId = saved.toLongOrNull() ?: return null
        val root = db.products().getById(rootId) ?: return null
        // روابط بمستويين أو باركود غير متطابق ليست نموذجاً مدعوماً؛ لا نخمن رصيداً آخر.
        return root.takeIf {
            root.id != product.id && root.active == 1 && product.barcode != null &&
                product.barcode == root.barcode && linkedRootId(db, root.id) == null
        }
    }

    fun linkedChildIds(db: RafiqDatabase, rootId: Long): List<Long> =
        db.settings().getAll().filter {
            it.key.startsWith(KEY_PREFIX) && it.value == rootId.toString()
        }.mapNotNull { it.key.removePrefix(KEY_PREFIX).toLongOrNull() }

    fun linkedChildren(db: RafiqDatabase, rootId: Long): Boolean = linkedChildIds(db, rootId).isNotEmpty()

    fun availableStock(db: RafiqDatabase, product: ProductEntity): Double? =
        stockProduct(db, product)?.stock
}
