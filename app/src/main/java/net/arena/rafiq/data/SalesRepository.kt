package net.arena.rafiq.data

import net.arena.rafiq.domain.CustomerRules
import net.arena.rafiq.domain.CustomerStatement
import net.arena.rafiq.domain.InvoiceRules
import net.arena.rafiq.domain.SaleInput
import net.arena.rafiq.domain.SaleLineInput
import net.arena.rafiq.domain.SaleResult
import net.arena.rafiq.domain.SalesRules

/** نتيجة عملية في المستودع: إما نجاح مع قيمة، أو رسالة خطأ بالعربية. */
sealed class RepoResult<out T> {
    data class Ok<T>(val value: T) : RepoResult<T>()
    data class Failed(val message: String) : RepoResult<Nothing>()
}

/** صنف يطلبه الكاشير: رقم الصنف، وكمية اختيارية، وسعر يدوي اختياري. */
data class RequestedLine(
    val productId: Long,
    val qty: Double? = null,
    val priceCents: Long? = null,
)

/** طلب بيع كامل من شاشة البيع. */
data class SaleRequest(
    val lines: List<RequestedLine>,
    val paymentType: String,               // "cash" أو "credit"
    val discountCents: Long = 0L,
    val customerId: Long? = null,          // مطلوب للبيع الآجل
    val receivedCents: Long? = null,       // للبيع النقدي
    val paidCents: Long? = null,           // للبيع الآجل
    val nonCash: List<net.arena.rafiq.domain.PaymentRules.Part> = emptyList(),
)

data class SaleReceipt(
    val invoiceId: Long,
    val number: Long,
    val totalCents: Long,
    val changeCents: Long?,
)

/** رصيد وكشف يُقرآن من لقطة قاعدة واحدة، مع نتيجة مطابقة مستقلة عن الواجهة. */
data class CustomerAccountSnapshot(
    val balanceCents: Long,
    val events: List<CustomerStatement.Event>,
    val reconciles: Boolean,
)

/**
 * طبقة الأعمال فوق قاعدة البيانات: تقرأ الحالة، وتستدعي القواعد النقية،
 * ثم تكتب النتيجة كلها داخل معاملة واحدة (إما تنجح كلها أو لا شيء).
 */
class SalesRepository(private val db: RafiqDatabase) {

    /** ينفّذ block داخل معاملة. أي استثناء يُلغي كل ما كُتب فيها. */
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

    private fun setting(key: String): String? = db.settings().get(key)?.value

    /** يكتب أجزاء الدفع للفاتورة: نقد (إن وُجد)، ثم الأجزاء غير النقدية بمراجعها، ثم الدين. */
    private fun insertPaymentRows(
        invoiceId: Long,
        cashCents: Long,
        parts: List<net.arena.rafiq.domain.PaymentRules.Part>,
        debtCents: Long,
    ) {
        val w = db.openHelper.writableDatabase
        fun row(method: String, amount: Long, ref: String) = w.execSQL(
            "INSERT INTO invoice_payments(invoice_id, method, amount_cents, reference) VALUES(?, ?, ?, ?)",
            arrayOf<Any>(invoiceId, method, amount, ref),
        )
        if (cashCents > 0L) row("cash", cashCents, "")
        for (p in parts) row(p.method, p.amountCents, p.reference.trim())
        if (debtCents > 0L) row("debt", debtCents, "")
    }

    /** مجاميع الوردية المفتوحة/المغلقة حسب طريقة الدفع (الفواتير الملغاة مستبعدة). */
    fun methodTotals(shiftId: Long): Map<String, Long> {
        val out = LinkedHashMap<String, Long>()
        db.openHelper.readableDatabase.query(
            "SELECT p.method, SUM(p.amount_cents) FROM invoice_payments p " +
                "JOIN invoices i ON i.id = p.invoice_id " +
                "WHERE i.shift_id = ? AND i.status = 'open' GROUP BY p.method",
            arrayOf<Any>(shiftId),
        ).use { c ->
            while (c.moveToNext()) out[c.getString(0)] = c.getLong(1)
        }
        return out
    }

    /** أجزاء فاتورة واحدة للعرض والطباعة. */
    fun paymentsOf(invoiceId: Long): List<Triple<String, Long, String>> {
        val out = ArrayList<Triple<String, Long, String>>()
        db.openHelper.readableDatabase.query(
            "SELECT method, amount_cents, reference FROM invoice_payments WHERE invoice_id = ? ORDER BY id",
            arrayOf<Any>(invoiceId),
        ).use { c ->
            while (c.moveToNext()) out.add(Triple(c.getString(0), c.getLong(1), c.getString(2)))
        }
        return out
    }

    /** ينشئ فاتورة بيع: يتحقق، ثم يحفظ الفاتورة والأصناف وخصم المخزون وحركة الدرج. */
    fun createSale(request: SaleRequest, userId: Long): RepoResult<SaleReceipt> {
        val user = db.users().getById(userId)
            ?: return RepoResult.Failed("المستخدم غير موجود")
        net.arena.rafiq.domain.PaymentRules.validateNonCash(request.nonCash)?.let { return RepoResult.Failed(it) }
        val nonCashCents = net.arena.rafiq.domain.PaymentRules.sumNonCash(request.nonCash)
        val shift = db.shifts().getOpen()
        val allowPriceEdit = setting("allow_price_edit") == "1"
        val allowNegativeStock = setting("allow_negative_stock") == "1"

        // نقرأ الأصناف مرة واحدة ونحتفظ بها لكتابة الأسطر لاحقاً
        val products = HashMap<Long, ProductEntity>()
        val stockRoots = HashMap<Long, ProductEntity>()
        val lines = request.lines.map { req ->
            val product = db.sales().activeProduct(req.productId)
            val root = product?.let { StockSharing.stockProduct(db, it) }
            if (product != null && root == null) {
                return RepoResult.Failed("ربط مخزون الصنف غير صالح؛ راجع إعداد الوجه قبل البيع")
            }
            if (product != null && root != null) {
                products[product.id] = product
                stockRoots[product.id] = root
            }
            SaleLineInput(
                productId = req.productId,
                found = product != null,
                name = product?.name ?: "",
                stock = root?.stock ?: 0.0,
                catalogPriceCents = product?.priceCents ?: 0L,
                requestedQty = req.qty,
                requestedPriceCents = req.priceCents,
            )
        }
        val customerFound = request.customerId?.let { db.sales().activeCustomer(it) != null } ?: false

        val input = SaleInput(
            lines = lines,
            paymentType = request.paymentType,
            shiftOpen = shift != null,
            isOwner = user.role == "owner",
            allowPriceEdit = allowPriceEdit,
            allowNegativeStock = allowNegativeStock,
            discountCents = request.discountCents,
            customerFound = customerFound,
            receivedCents = request.receivedCents,
            paidCents = request.paidCents,
            nonCashCents = nonCashCents,
        )

        val ok = when (val r = SalesRules.validateSale(input)) {
            is SaleResult.Error -> return RepoResult.Failed(r.message)
            is SaleResult.Ok -> r
        }

        // قد تحتوي الفاتورة على وجهين يشتركان في الرصيد (أو سطرين للصنف نفسه).
        // فحص كل سطر بمفرده لا يمنع خصم كمية إجمالية أكبر من المخزون.
        if (!allowNegativeStock) {
            val byRoot = ok.lines.groupBy { stockRoots.getValue(it.productId).id }
            for ((_, group) in byRoot) {
                val root = stockRoots.getValue(group[0].productId)
                if (group.sumOf { it.qty } > root.stock + 0.0000001) {
                    return RepoResult.Failed("رصيد غير كافٍ: ${root.name} (المتاح ${root.stock})")
                }
            }
        }

        return tx {
            val number = db.invoices().nextNumber()
            val invoiceId = db.invoices().insert(
                InvoiceEntity(
                    number = number,
                    userId = userId,
                    customerId = if (ok.paymentType == "credit") request.customerId else null,
                    subtotalCents = ok.subtotalCents,
                    discountCents = ok.discountCents,
                    totalCents = ok.totalCents,
                    paidCents = ok.paidCents,
                    dueCents = ok.dueCents,
                    receivedCents = ok.receivedCents,
                    changeCents = ok.changeCents,
                    paymentType = ok.paymentType,
                    shiftId = shift?.id,
                )
            )
            for (line in ok.lines) {
                val product = products.getValue(line.productId)
                db.invoiceItems().insert(
                    InvoiceItemEntity(
                        invoiceId = invoiceId,
                        productId = line.productId,
                        name = line.name,
                        barcode = product.barcode ?: "",
                        unit = product.unit,
                        priceCents = line.priceCents,
                        qty = line.qty,
                        totalCents = line.lineTotalCents,
                    )
                )
                db.sales().decrementStock(stockRoots.getValue(line.productId).id, line.qty)
            }
            // تفصيل الدفع: النقد يدخل الدرج، وغير النقدي يُسجَّل بمرجعه، والمتبقي دين
            insertPaymentRows(invoiceId, ok.paidCents - nonCashCents, request.nonCash, ok.dueCents)
            SalesRules.saleCashMovementCents(ok.paidCents - nonCashCents)?.let { amount ->
                db.cashMovements().insert(
                    CashMovementEntity(
                        shiftId = shift?.id,
                        kind = "sale",
                        amountCents = amount,
                        note = "فاتورة رقم $number",
                        refType = "invoice",
                        refId = invoiceId,
                        userId = userId,
                    )
                )
            }
            RepoResult.Ok(
                SaleReceipt(
                    invoiceId = invoiceId,
                    number = number,
                    totalCents = ok.totalCents,
                    changeCents = ok.changeCents,
                )
            )
        }
    }

    /**
     * إلغاء آمن أثناء الوردية الأصلية فقط. ردّ النقد يُشتق من حركة البيع الفعلية،
     * لا من paidCents الذي قد يضم حوالة/محفظة. المرتجع غير النقدي يحتاج تسوية منفصلة.
     */
    fun cancelInvoice(invoiceId: Long, userId: Long): RepoResult<Unit> = tx {
        val inv = db.invoices().getById(invoiceId)
        InvoiceRules.validateCancel(inv?.status)?.let { return@tx RepoResult.Failed(it) }
        inv!!
        val shiftId = inv.shiftId
        if (shiftId == null || db.shifts().getById(shiftId)?.status != "open") {
            return@tx RepoResult.Failed("لا يمكن إلغاء فاتورة ورديتها مغلقة؛ يلزم إجراء تسوية مرتجع منفصلة")
        }
        val parts = paymentsOf(invoiceId)
        if (parts.any { (method, amount, _) -> method != "cash" && method != "debt" && amount > 0L }) {
            return@tx RepoResult.Failed("لا يمكن إلغاء فاتورة بها حوالة أو محفظة أو إيداع؛ يلزم ردّ غير النقد وتسويته منفصلاً")
        }
        if (inv.dueCents > 0L && inv.customerId != null && customerBalance(inv.customerId) < inv.dueCents) {
            return@tx RepoResult.Failed("إلغاء هذه الفاتورة الآجلة سيجعل رصيد الزبون سالباً؛ يلزم تسوية رصيد الزبون أولاً")
        }
        val cashPaid = db.cashMovements().saleCashForInvoice(invoiceId)
        // الفواتير الأقدم قد لا تملك صفوف تفصيل الدفع؛ كان paidCents فيها نقداً فقط.
        val expectedCash = if (parts.isEmpty()) inv.paidCents else parts.filter { it.first == "cash" }.sumOf { it.second }
        if (cashPaid < 0L || cashPaid > inv.paidCents || cashPaid != expectedCash) {
            return@tx RepoResult.Failed("حركة النقد الأصلية غير متطابقة مع الفاتورة؛ راجع الصندوق قبل الإلغاء")
        }
        // تحقّق من كل روابط الرصيد قبل لمس أي صنف: tx تُثبِّت المعاملة عند عودة Failed أيضاً.
        val stockReturns = ArrayList<Pair<Long, Double>>()
        for (item in db.invoiceItems().getByInvoice(invoiceId)) {
            item.productId?.let { id ->
                val product = db.products().getById(id)
                    ?: return@tx RepoResult.Failed("صنف الفاتورة مفقود؛ لا يمكن إعادة المخزون بأمان")
                val root = StockSharing.stockProduct(db, product)
                    ?: return@tx RepoResult.Failed("ربط المخزون تغيّر؛ لا يمكن إلغاء الفاتورة بأمان")
                stockReturns.add(root.id to item.qty)
            }
        }
        for ((rootId, qty) in stockReturns) db.sales().incrementStock(rootId, qty)
        db.sales().markCancelled(invoiceId)
        InvoiceRules.cancelCashMovementCents(cashPaid)?.let { amount ->
            db.cashMovements().insert(
                CashMovementEntity(
                    shiftId = shiftId,
                    kind = "cancel",
                    amountCents = amount,
                    note = "إلغاء فاتورة رقم ${inv.number}",
                    refType = "invoice",
                    refId = invoiceId,
                    userId = userId,
                )
            )
        }
        RepoResult.Ok(Unit)
    }

    /** «أعطيت»: دين يُسجَّل على الزبون بلا فاتورة. */
    fun recordDebit(customerId: Long, amountCents: Long?, note: String, userId: Long): RepoResult<Unit> {
        CustomerRules.validateDebit(amountCents)?.let { return RepoResult.Failed(it) }
        db.sales().activeCustomer(customerId) ?: return RepoResult.Failed("الزبون غير موجود")
        db.ledger().insert(
            LedgerEntryEntity(
                customerId = customerId,
                kind = "debit",
                amountCents = amountCents!!,
                note = note.trim(),
                userId = userId,
            )
        )
        return RepoResult.Ok(Unit)
    }

    /** دفعة من الزبون: تُسجَّل كدفعة، وكحركة تحصيل في الوردية المفتوحة. */
    fun recordPayment(customerId: Long, amountCents: Long?, note: String, userId: Long): RepoResult<Unit> {
        val shift = db.shifts().getOpen()
        CustomerRules.validatePayment(amountCents, shift != null)?.let { return RepoResult.Failed(it) }
        db.sales().activeCustomer(customerId) ?: return RepoResult.Failed("الزبون غير موجود")
        val amount = amountCents!!
        val cleanNote = note.trim()
        tx {
            db.payments().insert(
                PaymentEntity(
                    customerId = customerId,
                    amountCents = amount,
                    userId = userId,
                    note = cleanNote,
                    shiftId = shift!!.id,
                )
            )
            db.cashMovements().insert(
                CashMovementEntity(
                    shiftId = shift.id,
                    kind = "collection",
                    amountCents = amount,
                    note = cleanNote.ifEmpty { "تحصيل دين" },
                    refType = "customer",
                    refId = customerId,
                    userId = userId,
                )
            )
        }
        return RepoResult.Ok(Unit)
    }

    /** رصيد الزبون الحالي بوحدة 1/100 من الريال. */
    fun customerBalance(customerId: Long): Long {
        val customer = db.customers().getById(customerId) ?: return 0L
        return CustomerRules.balance(
            openingCents = customer.openingCents,
            openInvoiceDueCents = db.sales().openDueSum(customerId),
            ledgerDebitsCents = db.sales().ledgerSum(customerId),
            paymentsCents = db.sales().paymentsSum(customerId),
        )
    }

    /** المتوقع في درج الوردية = مجموع كل حركاتها. */
    fun expectedCashForShift(shiftId: Long): Long = db.cashMovements().sumForShift(shiftId)

    /** لا تُقصّ الفواتير أو الدفعات من الكشف: الرقم النهائي يجب أن يمثل كل الحركات. */
    fun accountSnapshot(customerId: Long): CustomerAccountSnapshot? = db.runInTransaction<CustomerAccountSnapshot?> {
        val c = db.customers().getById(customerId) ?: return@runInTransaction null
        val users = db.users().getAll().associate { it.id to it.name }
        val invoices = db.catalog().invoicesForStatement(customerId).map {
            CustomerStatement.InvoiceLine(it.id, it.number, it.createdAt, it.dueCents, it.paidCents, it.status,
                users[it.userId])
        }
        val ledger = db.ledger().getByCustomer(customerId).map {
            CustomerStatement.LedgerLine(it.id, it.createdAt, it.amountCents, it.note,
                it.userId?.let { uid -> users[uid] })
        }
        val payments = db.payments().getByCustomer(customerId).map {
            CustomerStatement.PaymentLine(it.id, it.createdAt, it.amountCents, it.note,
                it.userId?.let { uid -> users[uid] })
        }
        val events = CustomerStatement.build(c.openingCents, invoices, ledger, payments)
        val balance = customerBalance(customerId)
        CustomerAccountSnapshot(balance, events, (events.firstOrNull()?.balanceAfterCents ?: 0L) == balance)
    }

    /** التوافق مع المستدعين القدامى: الأحداث كلها، دون اقتطاع صامت. */
    fun statement(customerId: Long): List<CustomerStatement.Event>? = accountSnapshot(customerId)?.events
}
