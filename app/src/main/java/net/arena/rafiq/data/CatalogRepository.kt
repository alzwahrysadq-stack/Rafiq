package net.arena.rafiq.data

import net.arena.rafiq.domain.ReportRules
import net.arena.rafiq.domain.ShelfRules

/** نتيجة شاشة «أين هذا الصنف». */
data class FindResult(val mode: String, val products: List<ProductEntity>)   // mode = "location" أو "name"

/** إحصاءات لوحة الرئيسية لليوم المحدد وحالة المخزون والديون. */
data class DashboardStats(
    val salesCount: Int,
    val salesTotalCents: Long,
    val salesPaidCents: Long,
    val newDebtCents: Long,
    val cancelledCount: Int,
    val collectionsCents: Long,
    val incomeCents: Long,
    val expensesCents: Long,
    val withdrawsCents: Long,
    val supplierPaidCents: Long,
    val productCount: Int,
    val lowStockCount: Int,
    val debtsTotalCents: Long,
)

/** البحث في الأصناف والإحصاءات اليومية، فوق قاعدة البيانات. */
class CatalogRepository(private val db: RafiqDatabase) {

    /**
     * حفظ صنف جديد (pid = null) أو تعديل صنف، كما save_product في النسخة الأصلية.
     * القيم خام من النموذج؛ الفارغ في الحقول الاختيارية لا يعطّل الحفظ.
     */
    fun saveProduct(pid: Long?, form: Map<String, String?>): RepoResult<Unit> {
        val name = form["name"]?.trim().orEmpty()
        ShelfRules.validateProductName(name.ifEmpty { null })?.let { return RepoResult.Failed(it) }
        val barcode = form["barcode"]?.trim()?.ifEmpty { null }
        val unit = form["unit"]?.trim()?.ifEmpty { "حبة" } ?: "حبة"
        val category = form["category"]?.trim().orEmpty()
        val cost = net.arena.rafiq.domain.Money.parse(form["cost"], 0L) ?: 0L
        val price = net.arena.rafiq.domain.Money.parse(form["price"], 0L) ?: 0L
        val stock = ShelfRules.toFloatOr(form["stock"], 0.0)
        val defaultLow = db.settings().get("low_stock_default")?.value
            ?.let { ShelfRules.toFloatOr(it, 5.0) } ?: 5.0
        val low = ShelfRules.toFloatOr(form["low_stock"], defaultLow)
        val expiry = form["expiry"]?.trim()?.ifEmpty { null }
        val aisle = form["aisle"]?.trim().orEmpty()
        val shelf = form["shelf"]?.trim().orEmpty()
        if (expiry != null && net.arena.rafiq.domain.ImportRules.toIsoDate(expiry) != expiry) {
            return RepoResult.Failed("تاريخ الانتهاء يجب أن يكون صحيحاً بصيغة سنة-شهر-يوم")
        }

        val existing = pid?.let { db.products().getById(it) ?: return RepoResult.Failed("الصنف غير موجود") }
        val otherVariants = barcode?.let { db.products().othersByBarcode(it, pid ?: -1L) }.orEmpty()
        if (otherVariants.any { it.name == name }) {
            return RepoResult.Failed("يوجد وجه بيع بنفس الاسم والباركود؛ سمِّ كل وجه بوضوح")
        }
        val rootText = form["shared_stock_with"]?.trim()
        if (!rootText.isNullOrEmpty() && rootText.toLongOrNull() == null) {
            return RepoResult.Failed("اختيار صنف الرصيد المشترك غير صالح")
        }
        val oldRootId = pid?.let { StockSharing.linkedRootId(db, it) }
        // النماذج القديمة التي لا ترسل الحقل تُبقي الربط القائم عند تعديل صنف.
        val rootId = if (form.containsKey("shared_stock_with")) rootText?.toLongOrNull() else oldRootId
        if (rootId != null) {
            val root = db.products().getById(rootId)
            if (root == null || root.active != 1 || root.id == pid || barcode == null ||
                root.barcode != barcode || StockSharing.linkedRootId(db, root.id) != null) {
                return RepoResult.Failed("رصيد مشترك غير صالح: اختر صنفاً أساسياً بالباركود نفسه")
            }
        }
        val childIds = pid?.let { StockSharing.linkedChildIds(db, it) }.orEmpty()
        if (pid != null && oldRootId != rootId) {
            if (db.catalog().invoiceItemCount(pid) > 0) {
                return RepoResult.Failed("لا يمكن تغيير ربط المخزون لوجه سبق بيعه؛ إلغاء الفواتير القديمة يجب أن يعيد الرصيد الأصلي")
            }
            if (childIds.isNotEmpty()) {
                return RepoResult.Failed("هذا الصنف أصل مخزون لوجوه أخرى؛ افصل روابطها أولاً")
            }
        }
        if (childIds.isNotEmpty() && existing?.barcode != barcode) {
            if (barcode == null) return RepoResult.Failed("لا يمكن حذف باركود صنف أساس له أوجه مشتركة")
            val childNames = childIds.map { id -> db.products().getById(id)?.name
                ?: return RepoResult.Failed("أحد أوجه الرصيد المشترك مفقود؛ لا تحفظ تغيير الباركود") }
            if (otherVariants.any { it.id !in childIds && it.name in childNames }) {
                return RepoResult.Failed("الباركود الجديد يتعارض مع اسم أحد الأوجه المرتبطة")
            }
        }
        db.beginTransaction()
        try {
            val savedId = if (pid != null) {
                db.products().updateFields(
                    pid, barcode, name, unit, category, cost, price,
                    if (rootId != null) 0.0 else stock,
                    if (rootId != null) 0.0 else low,
                    if (rootId != null) null else expiry, aisle, shelf,
                )
                pid
            } else {
                db.products().insert(
                    ProductEntity(
                        barcode = barcode, name = name, unit = unit, category = category,
                        costCents = cost, priceCents = price,
                        stock = if (rootId != null) 0.0 else stock,
                        lowStock = if (rootId != null) 0.0 else low,
                        expiry = if (rootId != null) null else expiry,
                        aisle = aisle, shelf = shelf,
                    )
                )
            }
            if (rootId == null) db.settings().delete(StockSharing.key(savedId))
            else db.settings().upsert(SettingEntity(StockSharing.key(savedId), rootId.toString()))
            if (childIds.isNotEmpty() && existing?.barcode != barcode) {
                for (childId in childIds) {
                    if (db.products().setBarcode(childId, barcode!!) != 1) {
                        error("تعذّر تحديث باركود جميع الأوجه المشتركة؛ تراجعت العملية")
                    }
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return RepoResult.Ok(Unit)
    }

    /** بحث عام بالاسم أو الباركود، حتى 12 نتيجة (كما شاشة البيع). */
    fun search(query: String): List<ProductEntity> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        return db.catalog().searchProducts(q, 12)
    }

    /**
     * «أين هذا الصنف؟»: إذا كانت العبارة موقعاً («ممر 3») ووُجد فيه أصناف، تُعرض الأصناف في الموقع.
     * وإلا يُبحث بالاسم أو الباركود.
     */
    fun find(query: String): FindResult {
        val q = query.trim()
        if (q.isEmpty()) return FindResult("name", emptyList())
        val code = ShelfRules.parseLocationQuery(q)
        if (code != null) {
            val atLocation = db.catalog().productsAtLocation(code)
            if (atLocation.isNotEmpty()) return FindResult("location", atLocation)
        }
        return FindResult("name", db.catalog().searchProducts(q, 60))
    }

    /** إحصاءات لوحة الرئيسية ليوم معيّن بصيغة yyyy-MM-dd. */
    fun dashboard(dayIso: String, debtsTotalCents: Long): DashboardStats {
        val invoices = db.catalog().invoicesOn(dayIso).map {
            ReportRules.InvoiceSummaryInput(it.status, it.totalCents, it.paidCents, it.dueCents)
        }
        val summary = ReportRules.summarizeDay(invoices)
        return DashboardStats(
            salesCount = summary.count,
            salesTotalCents = summary.totalCents,
            salesPaidCents = summary.paidCents,
            newDebtCents = summary.dueCents,
            cancelledCount = summary.cancelledCount,
            collectionsCents = db.catalog().collectionsOn(dayIso),
            incomeCents = db.catalog().incomeOn(dayIso),
            expensesCents = db.catalog().expensesOn(dayIso),
            withdrawsCents = db.catalog().withdrawsOn(dayIso),
            supplierPaidCents = db.catalog().supplierPaidOn(dayIso),
            productCount = db.catalog().activeProductCount(),
            lowStockCount = db.catalog().lowStockCount(),
            debtsTotalCents = debtsTotalCents,
        )
    }
}
